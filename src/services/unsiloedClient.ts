import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { env } from "../config/env.js";
import type { SourceDocument } from "../types/case.js";
import type { KbDocument } from "../types/kb.js";

export class UnsiloedUpstreamError extends Error {
    service: string;
    errorCode: string;
    upstreamStatus: number | null;
    responseSnippet: string | null;
    requestId: string | null;

    constructor(options: {
        message: string;
        service: string;
        errorCode: string;
        upstreamStatus?: number | null;
        responseSnippet?: string | null;
        requestId?: string | null;
    }) {
        super(options.message);
        this.name = "UnsiloedUpstreamError";
        this.service = options.service;
        this.errorCode = options.errorCode;
        this.upstreamStatus = options.upstreamStatus ?? null;
        this.responseSnippet = options.responseSnippet ?? null;
        this.requestId = options.requestId ?? null;
    }
}

export class UnsiloedClient {
    private readonly parsePollIntervalMs = 5_000;
    private readonly parseMaxAttempts = 60;
    private readonly parseHttpMaxRetries = 5;

    private get isConfigured(): boolean {
        return Boolean(
            env.unsiloedApiKey &&
                !env.unsiloedApiKey.includes("your_unsiloed_key") &&
                env.unsiloedApiKey.trim().length > 0
        );
    }

    async indexProtocol(caseId: string, localPath: string) {
        if (!this.isConfigured) {
            return { documentId: `mock-${caseId}-${basename(localPath)}` };
        }

        const jobId = await this.startParseJob(localPath);
        await this.waitForParseResult(jobId);
        return { documentId: jobId };
    }

    async indexGlobalKbDocument(kbDoc: KbDocument, localPath: string) {
        if (!this.isConfigured) {
            return {
                documentId: `mock-kb-${kbDoc.id}`,
                pages: 1,
                chunkCount: 1,
                extractedText: ""
            };
        }

        const jobId = await this.startParseJob(localPath);
        const data = await this.waitForParseResult(jobId);
        const extractedText = this.extractTextFromParseResult(data);

        return {
            documentId: kbDoc.id,
            pages: data.total_pages ?? data.pages,
            chunkCount: data.total_chunks ?? data.chunk_count ?? data.chunks?.length,
            extractedText
        };
    }

    async deleteGlobalKbDocument(documentId: string) {
        if (!this.isConfigured) {
            return { deleted: true };
        }

        let response: globalThis.Response;
        try {
            response = await fetch(`${env.unsiloedBaseUrl}/v1/documents/delete`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${env.unsiloedApiKey}`
                },
                body: JSON.stringify({
                    scope: "global_kb",
                    documentId
                })
            });
        } catch (error) {
            throw new UnsiloedUpstreamError({
                message: `Unsiloed network error: ${error instanceof Error ? error.message : "unknown"}`,
                service: "unsiloed",
                errorCode: "UNSILOED_NETWORK_ERROR"
            });
        }

        if (!response.ok) {
            const responseSnippet = (await response.text()).slice(0, 500);
            throw new UnsiloedUpstreamError({
                message: `Unsiloed KB delete failed with status ${response.status}`,
                service: "unsiloed",
                errorCode: "UNSILOED_HTTP_ERROR",
                upstreamStatus: response.status,
                responseSnippet,
                requestId:
                    response.headers.get("x-request-id") ??
                    response.headers.get("x-correlation-id")
            });
        }

        return { deleted: true };
    }

    async extractTextFromImage(localPath: string, mimeType: string): Promise<string> {
        if (!this.isConfigured) {
            return "";
        }

        const jobId = await this.startParseJob(localPath, mimeType || "image/jpeg");
        const data = await this.waitForParseResult(jobId);
        return this.extractTextFromParseResult(data);
    }

    async retrieveProtocols(query: string): Promise<SourceDocument[]> {
        if (!this.isConfigured) {
            return [
                {
                    documentId: "mock-protocol",
                    title: "Local Animal First Response Protocol",
                    excerpt:
                        "Keep distance, minimize stress, avoid direct handling, and contact licensed rehabilitator."
                }
            ];
        }

        const data = await this.tryRetrieve({
            query,
            topK: 3
        });
        if (!data?.results || data.results.length === 0) {
            return [];
        }

        return data.results.map((r) => ({
            documentId: r.id ?? crypto.randomUUID(),
            title: r.title ?? "Protocol Document",
            excerpt: r.excerpt ?? ""
        }));
    }

    async retrieveFromGlobalKb(query: string, kbDocs: KbDocument[]): Promise<SourceDocument[]> {
        if (kbDocs.length === 0) {
            return [];
        }

        if (!this.isConfigured) {
            return kbDocs.slice(0, 3).map((doc) => ({
                documentId: doc.id,
                title: doc.title,
                excerpt: `Guidance sourced from ${doc.type} document.`,
                url: doc.url
            }));
        }

        const readyDocIds = kbDocs.filter((d) => d.status === "ready").map((d) => d.id);
        const data = await this.tryRetrieve({
            scope: "global_kb",
            query,
            topK: 3,
            documentIds: readyDocIds
        });

        if (!data?.results || data.results.length === 0) {
            return kbDocs.slice(0, 3).map((doc) => ({
                documentId: doc.id,
                title: doc.title,
                excerpt: `Guidance sourced from ${doc.type} document.`,
                url: doc.url
            }));
        }

        return data.results.map((r) => {
            const matched = kbDocs.find((d) => d.id === r.id);
            return {
                documentId: r.id ?? crypto.randomUUID(),
                title: r.title ?? matched?.title ?? "KB Document",
                excerpt: r.excerpt ?? "",
                url: r.url ?? matched?.url
            };
        });
    }

    private async startParseJob(localPath: string, mimeType = "application/pdf"): Promise<string> {
        const filename = basename(localPath);
        const bytes = await readFile(localPath);
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: mimeType }), filename);

        const response = await this.fetchWithRateLimitRetry(
            `${env.unsiloedBaseUrl}/parse`,
            {
                method: "POST",
                headers: {
                    "api-key": env.unsiloedApiKey!
                },
                body: form
            },
            "parse submit"
        );

        if (!response.ok) {
            throw new UnsiloedUpstreamError({
                message: `Unsiloed parse submit failed with status ${response.status}`,
                service: "unsiloed",
                errorCode: "UNSILOED_HTTP_ERROR",
                upstreamStatus: response.status,
                responseSnippet: await this.readResponseSnippet(response),
                requestId: this.readRequestId(response)
            });
        }

        const data = (await response.json()) as {
            job_id?: string;
            jobId?: string;
        };
        const jobId = data.job_id ?? data.jobId;
        if (!jobId) {
            throw new UnsiloedUpstreamError({
                message: "Unsiloed parse submit did not return job_id",
                service: "unsiloed",
                errorCode: "UNSILOED_INVALID_RESPONSE"
            });
        }
        return jobId;
    }

    private async waitForParseResult(jobId: string): Promise<{
        status?: string;
        message?: string;
        pages?: number;
        total_pages?: number;
        total_chunks?: number;
        chunk_count?: number;
        chunks?: unknown[];
    }> {
        for (let attempt = 0; attempt < this.parseMaxAttempts; attempt += 1) {
            const response = await this.fetchWithRateLimitRetry(
                `${env.unsiloedBaseUrl}/parse/${jobId}`,
                {
                    method: "GET",
                    headers: {
                        "api-key": env.unsiloedApiKey!
                    }
                },
                "parse status"
            );

            if (!response.ok) {
                throw new UnsiloedUpstreamError({
                    message: `Unsiloed parse status failed with status ${response.status}`,
                    service: "unsiloed",
                    errorCode: "UNSILOED_HTTP_ERROR",
                    upstreamStatus: response.status,
                    responseSnippet: await this.readResponseSnippet(response),
                    requestId: this.readRequestId(response)
                });
            }

            const result = (await response.json()) as {
                status?: string;
                message?: string;
                pages?: number;
                total_pages?: number;
                total_chunks?: number;
                chunk_count?: number;
                chunks?: unknown[];
            };

            const status = (result.status ?? "").toLowerCase();
            if (status === "succeeded" || status === "completed" || status === "ready") {
                return result;
            }
            if (status === "failed" || status === "error") {
                throw new UnsiloedUpstreamError({
                    message: result.message ?? "Unsiloed parse job failed",
                    service: "unsiloed",
                    errorCode: "UNSILOED_PARSE_FAILED"
                });
            }

            await this.sleep(this.parsePollIntervalMs);
        }

        throw new UnsiloedUpstreamError({
            message: "Unsiloed parse job timeout",
            service: "unsiloed",
            errorCode: "UNSILOED_TIMEOUT"
        });
    }

    private async fetchWithRateLimitRetry(
        url: string,
        init: RequestInit,
        opLabel: string
    ): Promise<Response> {
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= this.parseHttpMaxRetries; attempt += 1) {
            try {
                const response = await fetch(url, init);
                if (response.status !== 429) {
                    return response;
                }
                lastError = new UnsiloedUpstreamError({
                    message: `Unsiloed ${opLabel} rate limited with status 429`,
                    service: "unsiloed",
                    errorCode: "UNSILOED_RATE_LIMIT",
                    upstreamStatus: 429,
                    responseSnippet: await this.readResponseSnippet(response),
                    requestId: this.readRequestId(response)
                });
            } catch (error) {
                lastError = error;
                if (attempt === this.parseHttpMaxRetries) {
                    break;
                }
            }

            const backoffMs = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
            console.warn("Unsiloed request throttled/retry", {
                opLabel,
                attempt,
                maxAttempts: this.parseHttpMaxRetries,
                backoffMs
            });
            await this.sleep(backoffMs);
        }

        if (lastError instanceof UnsiloedUpstreamError) {
            throw lastError;
        }
        if (lastError instanceof Error) {
            throw new UnsiloedUpstreamError({
                message: `Unsiloed ${opLabel} network error: ${lastError.message}`,
                service: "unsiloed",
                errorCode: "UNSILOED_NETWORK_ERROR"
            });
        }
        throw new UnsiloedUpstreamError({
            message: `Unsiloed ${opLabel} failed after retries`,
            service: "unsiloed",
            errorCode: "UNSILOED_HTTP_ERROR"
        });
    }

    private async tryRetrieve(payload: {
        query: string;
        topK: number;
        scope?: string;
        documentIds?: string[];
    }): Promise<
        | {
              results?: Array<{ id?: string; title?: string; excerpt?: string; url?: string }>;
          }
        | null
    > {
        const endpoints = [`${env.unsiloedBaseUrl}/v1/retrieve`, `${env.unsiloedBaseUrl}/retrieve`];
        for (const endpoint of endpoints) {
            try {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "api-key": env.unsiloedApiKey!
                    },
                    body: JSON.stringify(payload)
                });

                if (response.status === 404 || response.status === 405) {
                    continue;
                }

                if (!response.ok) {
                    console.warn("Unsiloed retrieve request failed", {
                        endpoint,
                        status: response.status
                    });
                    return null;
                }

                return (await response.json()) as {
                    results?: Array<{ id?: string; title?: string; excerpt?: string; url?: string }>;
                };
            } catch (error) {
                console.warn("Unsiloed retrieve request error", {
                    endpoint,
                    message: error instanceof Error ? error.message : "unknown"
                });
            }
        }

        return null;
    }

    private readRequestId(response: Response): string | null {
        return (
            response.headers.get("x-request-id") ??
            response.headers.get("x-correlation-id") ??
            response.headers.get("request-id")
        );
    }

    private async readResponseSnippet(response: Response): Promise<string | null> {
        const text = await response.text();
        if (!text) {
            return null;
        }
        return text.slice(0, 500);
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private extractTextFromParseResult(data: {
        chunks?: unknown[];
        text?: unknown;
        content?: unknown;
        markdown?: unknown;
        pages?: unknown;
        data?: unknown;
        result?: unknown;
    }): string {
        const fromStringField = [data.text, data.content, data.markdown].find(
            (v) => typeof v === "string" && v.trim().length > 0
        );
        if (typeof fromStringField === "string") {
            return fromStringField;
        }

        const directChunks = this.flattenTextFromPossibleArrays([data.chunks, data.pages]);
        if (directChunks.length > 0) {
            return directChunks;
        }

        const nested = this.deepExtractLikelyText(data);
        if (nested.length > 0) {
            return nested;
        }

        return "";
    }

    private readTextValue(value: unknown): string {
        if (typeof value === "string") {
            return value;
        }
        if (!value || typeof value !== "object") {
            return "";
        }
        const record = value as Record<string, unknown>;
        const candidates = [
            record.text,
            record.content,
            record.markdown,
            record.chunk_text,
            record.chunkText,
            record.page_text,
            record.pageText
        ];
        const picked = candidates.find((v) => typeof v === "string" && v.trim().length > 0);
        return typeof picked === "string" ? picked : "";
    }

    private flattenTextFromPossibleArrays(values: unknown[]): string {
        const pieces: string[] = [];
        for (const value of values) {
            if (!Array.isArray(value)) {
                continue;
            }
            for (const item of value) {
                const text = this.readTextValue(item);
                if (text.length > 0) {
                    pieces.push(text);
                }
            }
        }
        return pieces.join("\n\n");
    }

    private deepExtractLikelyText(root: unknown): string {
        const pieces: string[] = [];
        const seen = new Set<object>();
        const queue: unknown[] = [root];
        const likelyTextKeys = new Set([
            "text",
            "content",
            "markdown",
            "chunk_text",
            "chunkText",
            "page_text",
            "pageText",
            "body"
        ]);

        while (queue.length > 0) {
            const current = queue.shift();
            if (!current || typeof current !== "object") {
                continue;
            }
            if (seen.has(current)) {
                continue;
            }
            seen.add(current);

            if (Array.isArray(current)) {
                for (const item of current) {
                    queue.push(item);
                }
                continue;
            }

            const record = current as Record<string, unknown>;
            for (const [key, value] of Object.entries(record)) {
                if (typeof value === "string" && likelyTextKeys.has(key) && value.trim().length > 0) {
                    pieces.push(value);
                    continue;
                }
                if (value && typeof value === "object") {
                    queue.push(value);
                }
            }
        }

        return pieces.join("\n\n");
    }
}
