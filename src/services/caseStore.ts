import { MossClient, type DocumentInfo } from "@inferedge/moss";
import type { CaseRecord, CaseStatus, UploadedFile } from "../types/case.js";
import { env } from "../config/env.js";

export class CaseStore {
    private readonly memory = new Map<string, CaseRecord>();
    private readonly moss?: MossClient;
    private readonly indexName: string;
    private checkedIndex = false;

    constructor() {
        this.indexName = env.mossIndexName;
        if (env.mossProjectId && env.mossProjectKey) {
            this.moss = new MossClient(env.mossProjectId, env.mossProjectKey);
        }
    }

    async get(caseId: string): Promise<CaseRecord | null> {
        if (!this.moss) {
            return this.memory.get(caseId) ?? null;
        }

        try {
            await this.ensureIndexExists();
            const docs = await this.moss.getDocs(this.indexName, { docIds: [caseId] });
            const doc = docs[0];
            if (!doc) {
                return this.memory.get(caseId) ?? null;
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
            await this.moss.addDocs(this.indexName, [this.caseToDoc(record)], {
                upsert: true
            });
        } catch {
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
        await this.moss.addDocs(
            this.indexName,
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
    }

    async getCaseImageExtracts(caseId: string): Promise<string[]> {
        if (!this.moss) {
            return [];
        }

        try {
            await this.ensureIndexExists();
            const docs = await this.moss.getDocs(this.indexName);
            return docs
                .filter((doc) => doc.metadata?.recordKind === "case_image")
                .filter((doc) => doc.metadata?.caseId === caseId)
                .map((doc) => doc.text.trim())
                .filter((text) => text.length > 0);
        } catch {
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
            await this.ensureIndexExists();
            const docs = await this.moss.getDocs(this.indexName);
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
                await this.ensureIndexExists();
                const docs = await this.moss.getDocs(this.indexName);
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
        } catch {
            // Create on first use.
        }

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

        this.checkedIndex = true;
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
}
