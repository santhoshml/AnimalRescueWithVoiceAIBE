import { MossClient, type DocumentInfo } from "@inferedge/moss";
import { env } from "../config/env.js";
import type { KbDocument } from "../types/kb.js";

export class KbStore {
    private readonly memory = new Map<string, KbDocument>();
    private readonly moss?: MossClient;
    private readonly indexName: string;
    private checkedIndex = false;

    constructor() {
        this.indexName = env.mossKbIndexName;
        if (env.mossProjectId && env.mossProjectKey) {
            this.moss = new MossClient(env.mossProjectId, env.mossProjectKey);
        }
    }

    async create(doc: KbDocument): Promise<KbDocument> {
        this.memory.set(doc.id, doc);
        if (!this.moss) {
            return doc;
        }

        try {
            await this.ensureIndexExists();
            await this.moss.addDocs(this.indexName, [this.toDoc(doc)], { upsert: true });
        } catch {
            // Keep in-memory fallback.
        }
        return doc;
    }

    async update(doc: KbDocument): Promise<KbDocument> {
        return this.create(doc);
    }

    async list(): Promise<KbDocument[]> {
        let records: KbDocument[];
        if (!this.moss) {
            records = [...this.memory.values()];
        } else {
            try {
                await this.ensureIndexExists();
                const docs = await this.moss.getDocs(this.indexName);
                records = docs
                    .filter((d) => d.metadata?.recordKind !== "chunk")
                    .map((d) => this.fromDoc(d))
                    .filter((d) => Boolean(d?.id));
                for (const doc of records) {
                    this.memory.set(doc.id, doc);
                }
            } catch {
                records = [...this.memory.values()];
            }
        }

        records.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
        return records;
    }

    async get(id: string): Promise<KbDocument | null> {
        if (!this.moss) {
            return this.memory.get(id) ?? null;
        }

        try {
            await this.ensureIndexExists();
            const docs = await this.moss.getDocs(this.indexName, { docIds: [id] });
            const found = docs[0];
            if (!found) {
                return this.memory.get(id) ?? null;
            }
            if (found.metadata?.recordKind === "chunk") {
                return this.memory.get(id) ?? null;
            }
            const parsed = this.fromDoc(found);
            this.memory.set(id, parsed);
            return parsed;
        } catch {
            return this.memory.get(id) ?? null;
        }
    }

    async delete(id: string): Promise<boolean> {
        this.memory.delete(id);

        if (!this.moss) {
            return true;
        }

        try {
            await this.ensureIndexExists();
            const docs = await this.moss.getDocs(this.indexName);
            const chunkIds = docs
                .filter((d) => d.metadata?.recordKind === "chunk" && d.metadata?.documentId === id)
                .map((d) => d.id);
            const idsToDelete = [id, ...chunkIds];
            if (idsToDelete.length > 0) {
                await this.moss.deleteDocs(this.indexName, idsToDelete);
            }
            return true;
        } catch {
            return true;
        }
    }

    async upsertDocumentChunks(doc: KbDocument, extractedText: string): Promise<number> {
        if (!this.moss) {
            return 0;
        }

        await this.ensureIndexExists();

        const normalized = extractedText.trim();
        const chunks = this.chunkText(normalized, 700, 500, 800, 100);
        const totalChunks = chunks.length;

        const existing = await this.moss.getDocs(this.indexName);
        const existingChunkIds = existing
            .filter(
                (d) =>
                    d.metadata?.recordKind === "chunk" &&
                    d.metadata?.documentId === doc.id &&
                    !d.id.startsWith(`${doc.id}-chunk-`)
            )
            .map((d) => d.id);
        if (existingChunkIds.length > 0) {
            await this.moss.deleteDocs(this.indexName, existingChunkIds);
        }

        const records: DocumentInfo[] = chunks.map((chunkText, index) => ({
            id: `${doc.id}-chunk-${index}`,
            text: chunkText,
            metadata: {
                recordKind: "chunk",
                documentId: doc.id,
                title: doc.title,
                sourceFileName: doc.sourceFileName ?? "",
                chunkIndex: String(index),
                totalChunks: String(totalChunks),
                type: doc.type
            }
        }));

        if (records.length > 0) {
            await this.moss.addDocs(this.indexName, records, { upsert: true });
        }

        return records.length;
    }

    private async ensureIndexExists() {
        if (!this.moss || this.checkedIndex) {
            return;
        }

        try {
            await this.moss.getIndex(this.indexName);
            this.checkedIndex = true;
            return;
        } catch {
            // Create on first use.
        }

        await this.moss.createIndex(this.indexName, [
            {
                id: "__seed__",
                text: JSON.stringify({
                    id: "__seed__",
                    title: "seed",
                    type: "general",
                    url: "",
                    status: "ready",
                    uploadedAt: new Date().toISOString(),
                    parser: {
                        embeddingStatus: "ready",
                        parseError: null,
                        errorCode: null,
                        upstreamStatus: null,
                        retryCount: 0,
                        lastTriedAt: null,
                        service: null,
                        errorType: null,
                        responseSnippet: null,
                        requestId: null
                    }
                }),
                metadata: {
                    type: "general",
                    status: "ready"
                }
            }
        ]);
        await this.moss.deleteDocs(this.indexName, ["__seed__"]);
        this.checkedIndex = true;
    }

    private toDoc(doc: KbDocument): DocumentInfo {
        return {
            id: doc.id,
            text: JSON.stringify(doc),
            metadata: {
                recordKind: "document",
                type: doc.type,
                status: doc.status
            }
        };
    }

    private fromDoc(doc: DocumentInfo): KbDocument {
        const parsed = JSON.parse(doc.text) as Partial<KbDocument>;
        return {
            id: parsed.id ?? crypto.randomUUID(),
            title: parsed.title ?? "Untitled Document",
            sourceFileName: parsed.sourceFileName,
            type: parsed.type ?? "general",
            url: parsed.url ?? "",
            tags: parsed.tags,
            status: parsed.status ?? "processing",
            uploadedAt: parsed.uploadedAt ?? new Date().toISOString(),
            parser: {
                embeddingStatus: parsed.parser?.embeddingStatus ?? "processing",
                parseError: parsed.parser?.parseError ?? null,
                errorCode: parsed.parser?.errorCode ?? null,
                upstreamStatus: parsed.parser?.upstreamStatus ?? null,
                retryCount: parsed.parser?.retryCount ?? 0,
                lastTriedAt: parsed.parser?.lastTriedAt ?? null,
                service: parsed.parser?.service ?? null,
                errorType: parsed.parser?.errorType ?? null,
                responseSnippet: parsed.parser?.responseSnippet ?? null,
                requestId: parsed.parser?.requestId ?? null,
                pages: parsed.parser?.pages,
                chunkCount: parsed.parser?.chunkCount
            }
        };
    }

    private chunkText(
        text: string,
        targetSize: number,
        minSize: number,
        maxSize: number,
        overlap: number
    ): string[] {
        if (!text) {
            return [];
        }

        const chunks: string[] = [];
        let start = 0;
        while (start < text.length) {
            const hardEnd = Math.min(start + maxSize, text.length);
            let end = Math.min(start + targetSize, hardEnd);

            if (end < text.length) {
                const windowStart = Math.min(start + minSize, end);
                const breakAt = text.lastIndexOf(" ", end);
                if (breakAt > windowStart) {
                    end = breakAt;
                }
            }

            const piece = text.slice(start, end).trim();
            if (piece.length > 0) {
                chunks.push(piece);
            }

            if (end >= text.length) {
                break;
            }

            const nextStart = Math.max(end - overlap, start + 1);
            if (nextStart <= start) {
                break;
            }
            start = nextStart;
        }
        return chunks;
    }
}
