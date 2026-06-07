import { MossClient, type DocumentInfo } from "@moss-dev/moss";
import type { CaseRecord, CaseStatus, UploadedFile } from "../types/case.js";
import { env } from "../config/env.js";

export class CaseStore {
    private readonly memory = new Map<string, CaseRecord>();
    private readonly moss?: MossClient;
    private readonly indexName: string;
    private checkedIndex = false;
    private readonly docsCacheTtlMs = 5_000;
    private docsCache:
        | {
              fetchedAt: number;
              docs: DocumentInfo[];
          }
        | undefined;
    private docsFetchPromise: Promise<DocumentInfo[]> | undefined;

    constructor() {
        this.indexName = env.mossIndexName;
        if (env.mossProjectId && env.mossProjectKey) {
            this.moss = new MossClient(env.mossProjectId, env.mossProjectKey);
        }
        console.log("[MOSS] case store init", {
            indexName: this.indexName,
            configured: Boolean(this.moss)
        });
    }

    async get(caseId: string): Promise<CaseRecord | null> {
        const memoized = this.memory.get(caseId);
        if (memoized) {
            return memoized;
        }

        if (!this.moss) {
            return null;
        }

        try {
            const docs = await this.getAllDocsCached();
            const doc = docs.find((entry) => entry.id === caseId);
            if (!doc) {
                return null;
            }

            const parsed = this.docToCase(doc);
            this.memory.set(caseId, parsed);
            return parsed;
        } catch {
            return this.memory.get(caseId) ?? null;
        }
    }

    async save(record: CaseRecord): Promise<CaseRecord> {
        this.memory.set(record.id, record);

        if (!this.moss) {
            return record;
        }

        try {
            await this.ensureIndexExists();
            await this.addDocsWithRetry([this.caseToDoc(record)], { upsert: true });
            this.invalidateDocsCache();
            console.log("[MOSS] case upsert success", {
                caseId: record.id,
                indexName: this.indexName
            });
        } catch (error) {
            console.warn("[MOSS] case upsert failed, using in-memory fallback", {
                caseId: record.id,
                indexName: this.indexName,
                ...this.describeError(error)
            });
            // Keep in-memory fallback for demo continuity.
        }

        return record;
    }

    async upsertCaseImageExtraction(
        caseId: string,
        image: UploadedFile,
        extractedText: string
    ): Promise<void> {
        if (!this.moss) {
            return;
        }
        const text = extractedText.trim();
        if (text.length === 0) {
            return;
        }

        await this.ensureIndexExists();
        await this.addDocsWithRetry(
            [
                {
                    id: `${caseId}-image-${image.id}`,
                    text,
                    metadata: {
                        recordKind: "case_image",
                        caseId,
                        imageId: image.id,
                        sourceFileName: image.filename,
                        mimeType: image.mimeType,
                        uploadedAt: image.uploadedAt,
                        type: "case_image_extraction"
                    }
                }
            ],
            { upsert: true }
        );
        this.invalidateDocsCache();
        console.log("[MOSS] case image extraction upsert success", {
            caseId,
            imageId: image.id,
            indexName: this.indexName
        });
    }

    async getCaseImageExtracts(caseId: string): Promise<string[]> {
        if (!this.moss) {
            return [];
        }

        try {
            const docs = await this.getAllDocsCached();
            return docs
                .filter((doc) => doc.metadata?.recordKind === "case_image")
                .filter((doc) => doc.metadata?.caseId === caseId)
                .map((doc) => doc.text.trim())
                .filter((text) => text.length > 0);
        } catch (error) {
            console.warn("[MOSS] getCaseImageExtracts failed", {
                caseId,
                indexName: this.indexName,
                ...this.describeError(error)
            });
            return [];
        }
    }

    async getByRoomName(roomName: string): Promise<CaseRecord | null> {
        if (!this.moss) {
            for (const record of this.memory.values()) {
                if (record.roomName === roomName) {
                    return record;
                }
            }
            return null;
        }

        try {
            const docs = await this.getAllDocsCached();
            const found = docs
                .filter((doc) => doc.metadata?.recordKind !== "case_image")
                .map((doc) => this.docToCase(doc))
                .find((record) => record.roomName === roomName);
            if (!found) {
                return null;
            }
            this.memory.set(found.id, found);
            return found;
        } catch {
            for (const record of this.memory.values()) {
                if (record.roomName === roomName) {
                    return record;
                }
            }
            return null;
        }
    }

    async list(options?: {
        status?: CaseStatus;
        page?: number;
        pageSize?: number;
    }): Promise<{
        items: CaseRecord[];
        total: number;
        page: number;
        pageSize: number;
    }> {
        const page = Math.max(1, options?.page ?? 1);
        const pageSize = Math.max(1, Math.min(100, options?.pageSize ?? 20));
        const status = options?.status;

        let records: CaseRecord[];
        if (!this.moss) {
            records = [...this.memory.values()];
        } else {
            try {
                const docs = await this.getAllDocsCached();
                records = docs
                    .filter((doc) => doc.metadata?.recordKind !== "case_image")
                    .map((doc) => this.docToCase(doc))
                    .filter((record) => Boolean(record?.id));
            } catch {
                records = [...this.memory.values()];
            }
        }

        if (status) {
            records = records.filter((r) => r.status === status);
        }

        records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

        const total = records.length;
        const start = (page - 1) * pageSize;
        const items = records.slice(start, start + pageSize);

        return { items, total, page, pageSize };
    }

    private async ensureIndexExists() {
        if (!this.moss) {
            return;
        }

        if (this.checkedIndex) {
            return;
        }

        try {
            await this.moss.getIndex(this.indexName);
            this.checkedIndex = true;
            return;
        } catch (error) {
            console.warn("[MOSS] getIndex failed, attempting createIndex", {
                indexName: this.indexName,
                ...this.describeError(error)
            });
            // Create on first use.
        }

        try {
            const seed = this.memory.values().next().value as CaseRecord | undefined;
            if (seed) {
                await this.moss.createIndex(this.indexName, [this.caseToDoc(seed)]);
            } else {
                await this.moss.createIndex(this.indexName, [
                    {
                        id: "__seed__",
                        text: JSON.stringify({
                            id: "__seed__",
                            status: "closed",
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        }),
                        metadata: {
                            recordKind: "case",
                            status: "closed",
                            city: "",
                            zip: "",
                            urgency: ""
                        }
                    }
                ]);
                await this.moss.deleteDocs(this.indexName, ["__seed__"]);
            }
        } catch (error) {
            console.error("[MOSS] createIndex failed", {
                indexName: this.indexName,
                ...this.describeError(error)
            });
            throw error;
        }

        this.checkedIndex = true;
        this.invalidateDocsCache();
    }

    private caseToDoc(record: CaseRecord): DocumentInfo {
        return {
            id: record.id,
            text: JSON.stringify(record),
            metadata: {
                recordKind: "case",
                status: record.status,
                city: record.city ?? "",
                zip: record.zip ?? "",
                urgency: record.urgency ?? ""
            }
        };
    }

    private docToCase(doc: DocumentInfo): CaseRecord {
        const parsed = JSON.parse(doc.text) as CaseRecord;
        return parsed;
    }

    private async addDocsWithRetry(
        docs: DocumentInfo[],
        options: { upsert: boolean }
    ): Promise<void> {
        if (!this.moss) {
            return;
        }

        const maxAttempts = 5;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                await this.moss.addDocs(this.indexName, docs, options);
                return;
            } catch (error) {
                const details = this.describeError(error);
                const message =
                    typeof details.message === "string" ? details.message : "unknown";
                const rateLimited =
                    /429/.test(message) ||
                    /rate.?limit/i.test(message) ||
                    /too many requests/i.test(message);
                if (!rateLimited || attempt === maxAttempts) {
                    console.error("[MOSS] addDocs failed", {
                        indexName: this.indexName,
                        attempt,
                        maxAttempts,
                        ...details
                    });
                    throw error;
                }

                const baseDelayMs = 700;
                const jitterMs = Math.floor(Math.random() * 250);
                const backoffMs = baseDelayMs * 2 ** (attempt - 1) + jitterMs;
                console.warn("[MOSS] addDocs rate limited, retrying", {
                    indexName: this.indexName,
                    attempt,
                    maxAttempts,
                    backoffMs
                });
                await this.sleep(backoffMs);
            }
        }
    }

    private invalidateDocsCache(): void {
        this.docsCache = undefined;
    }

    private async getAllDocsCached(): Promise<DocumentInfo[]> {
        if (!this.moss) {
            return [];
        }

        const now = Date.now();
        if (
            this.docsCache &&
            now - this.docsCache.fetchedAt <= this.docsCacheTtlMs
        ) {
            return this.docsCache.docs;
        }

        if (this.docsFetchPromise) {
            return this.docsFetchPromise;
        }

        this.docsFetchPromise = (async () => {
            await this.ensureIndexExists();
            const docs = await this.moss!.getDocs(this.indexName);
            this.docsCache = {
                fetchedAt: Date.now(),
                docs
            };
            return docs;
        })();

        try {
            return await this.docsFetchPromise;
        } finally {
            this.docsFetchPromise = undefined;
        }
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private describeError(error: unknown): Record<string, unknown> {
        if (error instanceof Error) {
            const own: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(error as unknown as Record<string, unknown>)) {
                own[key] = value;
            }
            return {
                name: error.name,
                message: error.message,
                stack: error.stack,
                ...own
            };
        }
        if (typeof error === "object" && error !== null) {
            return { raw: error };
        }
        return { raw: String(error) };
    }
}
