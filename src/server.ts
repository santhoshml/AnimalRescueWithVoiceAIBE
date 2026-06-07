import "dotenv/config";
import express from "express";
import cors from "cors";
import { AccessToken } from "livekit-server-sdk";
import multer from "multer";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Response } from "express";
import type { NextFunction, Request } from "express";
import { env } from "./config/env.js";
import { CaseStore } from "./services/caseStore.js";
import { CaseEventBus } from "./services/eventBus.js";
import { CaseOrchestrator } from "./services/orchestrator.js";
import { QwenClient } from "./services/qwenClient.js";
import { findRescueCenters } from "./services/resourceService.js";
import { UnsiloedClient, UnsiloedUpstreamError } from "./services/unsiloedClient.js";
import type { CaseRecord, UploadedFile } from "./types/case.js";
import type { CaseStatus } from "./types/case.js";
import { KbStore } from "./services/kbStore.js";
import type { KbDocument } from "./types/kb.js";

const app = express();
app.use(cors());
app.use(express.json());

function formatLogMeta(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return '"[unserializable]"';
    }
}

function sanitizeBody(value: unknown): unknown {
    if (!value || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.slice(0, 20);
    }

    const redactedKeys = new Set(["authorization", "token", "password", "apiKey", "api_key"]);
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
        if (redactedKeys.has(key)) {
            out[key] = "[redacted]";
            continue;
        }
        if (typeof raw === "string" && raw.length > 500) {
            out[key] = `${raw.slice(0, 500)}...`;
            continue;
        }
        out[key] = raw;
    }
    return out;
}

app.use((req, res, next) => {
    const start = Date.now();
    const requestId = crypto.randomUUID().slice(0, 8);
    const contentType = req.headers["content-type"] ?? "unknown";

    console.log(
        `[REQ ${requestId}] ${req.method} ${req.originalUrl} ct=${contentType} query=${formatLogMeta(
            req.query
        )}`
    );

    res.on("finish", () => {
        const durationMs = Date.now() - start;
        console.log(
            `[RES ${requestId}] ${req.method} ${req.originalUrl} status=${res.statusCode} durationMs=${durationMs}`
        );
    });

    next();
});

const caseStore = new CaseStore();
const kbStore = new KbStore();
const eventBus = new CaseEventBus();
const kbEventBus = new CaseEventBus();
const qwen = new QwenClient();
const unsiloed = new UnsiloedClient();
const orchestrator = new CaseOrchestrator(qwen, unsiloed);
const kbIngestionJobs = new Map<string, Promise<void>>();

const uploadRoot = "uploads";
await mkdir(uploadRoot, { recursive: true });
app.use("/uploads", express.static(uploadRoot));

const storage = multer.diskStorage({
    destination: async (_req, _file, cb) => {
        try {
            await mkdir(uploadRoot, { recursive: true });
            cb(null, uploadRoot);
        } catch (error) {
            cb(error as Error, uploadRoot);
        }
    },
    filename: (_req, file, cb) => {
        const suffix = extname(file.originalname) || "";
        cb(null, `${Date.now()}-${crypto.randomUUID()}${suffix}`);
    }
});

const imageUpload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        cb(null, file.mimetype.startsWith("image/"));
    }
});

const protocolUpload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        cb(null, file.mimetype === "application/pdf");
    }
});

function badRequest(res: Response, message: string) {
    res.status(400).json({ error: message });
}

function parseTags(raw: unknown): string[] | undefined {
    if (typeof raw !== "string" || raw.trim().length === 0) {
        return undefined;
    }

    try {
        const maybeJson = JSON.parse(raw) as unknown;
        if (Array.isArray(maybeJson)) {
            const tags = maybeJson
                .map((v) => String(v).trim())
                .filter((v) => v.length > 0);
            return tags.length > 0 ? tags : undefined;
        }
    } catch {
        // Fall back to CSV parser.
    }

    const csv = raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    return csv.length > 0 ? csv : undefined;
}

function kbType(value: unknown): string {
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
    }
    return "general";
}

function isUnknownOrEmpty(value: unknown): boolean {
    if (typeof value !== "string") {
        return true;
    }
    const normalized = value.trim().toLowerCase();
    return (
        normalized.length === 0 ||
        normalized === "unknown" ||
        normalized === "undefined" ||
        normalized === "null"
    );
}

function isCaseDisplayable(record: CaseRecord): boolean {
    return !isUnknownOrEmpty(record.animal) && !isUnknownOrEmpty(record.city);
}

function adminAuthPlaceholder(
    _req: Request,
    _res: Response,
    next: NextFunction
) {
    // TODO: Replace with proper admin auth middleware for production.
    next();
}

function getUploadLocalPathFromKbDoc(doc: KbDocument): string {
    const marker = "/uploads/";
    const idx = doc.url.lastIndexOf(marker);
    if (idx === -1) {
        throw new Error("KB document URL does not point to /uploads/");
    }
    const filename = doc.url.slice(idx + marker.length);
    if (!filename || filename.includes("/") || filename.includes("\\")) {
        throw new Error("Invalid KB document upload filename");
    }
    return join(uploadRoot, filename);
}

function publishKbUpdated(doc: KbDocument) {
    kbEventBus.publish("global-kb", "kb.document.updated", doc);
}

async function runKbIngestion(docId: string): Promise<void> {
    const doc = await kbStore.get(docId);
    if (!doc) {
        return;
    }

    const lastTriedAt = new Date().toISOString();
    doc.status = "processing";
    doc.parser.embeddingStatus = "processing";
    doc.parser.parseError = null;
    doc.parser.errorCode = null;
    doc.parser.upstreamStatus = null;
    doc.parser.lastTriedAt = lastTriedAt;
    doc.parser.service = null;
    doc.parser.errorType = null;
    doc.parser.responseSnippet = null;
    doc.parser.requestId = null;
    await kbStore.update(doc);
    publishKbUpdated(doc);

    let current = doc;
    try {
        const localPath = getUploadLocalPathFromKbDoc(doc);
        const parsed = await unsiloed.indexGlobalKbDocument(doc, localPath);
        const originalLength = parsed.extractedText.length;
        const insertedRecords = await kbStore.upsertDocumentChunks(current, parsed.extractedText);
        console.log("KB ingestion chunking summary", {
            documentId: current.id,
            originalDocumentLength: originalLength,
            chunksCreated: insertedRecords,
            recordsInsertedInMoss: insertedRecords
        });

        current.status = "ready";
        current.parser.embeddingStatus = "ready";
        current.parser.pages = parsed.pages;
        current.parser.chunkCount = insertedRecords;
    } catch (error) {
        current.status = "failed";
        current.parser.embeddingStatus = "failed";
        current.parser.parseError =
            error instanceof Error ? error.message : "Ingestion failed";

        if (error instanceof UnsiloedUpstreamError) {
            current.parser.errorCode = error.errorCode;
            current.parser.upstreamStatus = error.upstreamStatus;
            current.parser.service = error.service;
            current.parser.errorType = "UPSTREAM_HTTP_OR_NETWORK";
            current.parser.responseSnippet = error.responseSnippet;
            current.parser.requestId = error.requestId;
            console.error("KB ingestion upstream error", {
                service: error.service,
                errorCode: error.errorCode,
                upstreamStatus: error.upstreamStatus,
                requestId: error.requestId,
                responseSnippet: error.responseSnippet
            });
        } else if (error instanceof Error) {
            current.parser.errorCode = "KB_INGESTION_ERROR";
            current.parser.errorType = error.name;
            console.error("KB ingestion error", {
                name: error.name,
                message: error.message
            });
        }
    }

    current = await kbStore.update(current);
    publishKbUpdated(current);
}

async function getCaseOr404(res: Response, caseId: string): Promise<CaseRecord | null> {
    const found = await caseStore.get(caseId);
    if (!found || !isCaseDisplayable(found)) {
        res.status(404).json({ error: "Case not found" });
        return null;
    }
    return found;
}

function getParamValue(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return value[0] ?? "";
    }
    return value ?? "";
}

async function saveAndBroadcast(caseRecord: CaseRecord, event = "case.updated") {
    caseRecord.updatedAt = new Date().toISOString();
    const saved = await caseStore.save(caseRecord);
    eventBus.publish(saved.id, event, saved);
    return saved;
}

app.post("/token", async (req, res) => {
    const room = req.body.room || "rescue-demo";
    const identity = req.body.identity || `caller-${Date.now()}`;
    const caseId =
        typeof req.body.caseId === "string" && req.body.caseId.trim().length > 0
            ? req.body.caseId.trim()
            : undefined;
    if (!caseId) {
        return badRequest(res, "caseId is required");
    }
    const caseRecord = await caseStore.get(caseId);
    if (!caseRecord) {
        return res.status(404).json({ error: "Case not found for provided caseId" });
    }

    const token = new AccessToken(
        env.livekitApiKey,
        env.livekitApiSecret,
        {
            identity,
            metadata: JSON.stringify({
                caseId: caseId ?? null
            })
        }
    );

    token.addGrant({
        room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true
    });

    console.log("[VOICE] token issued", {
        caseId,
        room,
        identity,
        writeTargetCaseId: caseRecord.id
    });

    res.json({
        token: await token.toJwt(),
        url: env.livekitUrl,
        room,
        caseId
    });
});

app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "animal-rescue-copilot-api" });
});

app.get("/kb/documents", async (_req, res) => {
    const docs = await kbStore.list();
    res.json(docs);
});

app.post(
    "/kb/documents",
    adminAuthPlaceholder,
    protocolUpload.single("file"),
    async (req, res) => {
        if (!req.file) {
            return badRequest(res, "PDF file is required");
        }

        const host = req.get("host");
        if (!host) {
            return badRequest(res, "Missing host header");
        }

        const now = new Date().toISOString();
        const type = kbType(req.body.type);
        const title =
            typeof req.body.title === "string" && req.body.title.trim().length > 0
                ? req.body.title.trim()
                : req.file.originalname;
        const tags = parseTags(req.body.tags);

        const kbDoc: KbDocument = {
            id: `kb-doc-${crypto.randomUUID()}`,
            title,
            sourceFileName: req.file.originalname,
            type,
            url: `${req.protocol}://${host}/uploads/${req.file.filename}`,
            tags,
            status: "processing",
            uploadedAt: now,
            parser: {
                embeddingStatus: "processing",
                parseError: null,
                errorCode: null,
                upstreamStatus: null,
                retryCount: 0,
                lastTriedAt: now,
                service: null,
                errorType: null,
                responseSnippet: null,
                requestId: null
            }
        };

        const saved = await kbStore.create(kbDoc);
        publishKbUpdated(saved);

        const job = runKbIngestion(saved.id).finally(() => {
            kbIngestionJobs.delete(saved.id);
        });
        kbIngestionJobs.set(saved.id, job);

        res.status(201).json(saved);
    }
);

app.delete("/kb/documents/:id", adminAuthPlaceholder, async (req, res) => {
    const id = getParamValue(req.params.id);
    const doc = await kbStore.get(id);
    if (!doc) {
        return res.status(404).json({ error: "KB document not found" });
    }

    try {
        await unsiloed.deleteGlobalKbDocument(doc.id);
    } catch {
        // Continue delete flow even if de-indexing fails.
    }

    await kbStore.delete(id);
    res.status(204).send();
});

app.post("/kb/documents/:id/retry", adminAuthPlaceholder, async (req, res) => {
    const id = getParamValue(req.params.id);
    const force = req.body?.force === true;
    const doc = await kbStore.get(id);
    if (!doc) {
        return res.status(404).json({ error: "KB document not found" });
    }

    if (doc.status === "processing" && !force) {
        return res
            .status(409)
            .json({ error: "KB document ingestion is already in progress" });
    }

    if (doc.status !== "failed" && !force) {
        return res
            .status(400)
            .json({ error: "Retry is allowed only for failed documents" });
    }

    doc.status = "processing";
    doc.parser.embeddingStatus = "processing";
    doc.parser.parseError = null;
    doc.parser.errorCode = null;
    doc.parser.upstreamStatus = null;
    doc.parser.retryCount += 1;
    doc.parser.lastTriedAt = new Date().toISOString();
    doc.parser.service = null;
    doc.parser.errorType = null;
    doc.parser.responseSnippet = null;
    doc.parser.requestId = null;

    const updated = await kbStore.update(doc);
    publishKbUpdated(updated);

    const existing = kbIngestionJobs.get(updated.id);
    if (!existing || force) {
        const job = runKbIngestion(updated.id).finally(() => {
            kbIngestionJobs.delete(updated.id);
        });
        kbIngestionJobs.set(updated.id, job);
    }

    res.json(updated);
});

app.post("/cases", async (req, res) => {
    const { callerName, callerPhone, city, zip, roomName, animal } = req.body as {
        callerName?: string;
        callerPhone?: string;
        city?: string;
        zip?: string;
        roomName?: string;
        animal?: string;
    };
    const normalizedCity =
        typeof city === "string" && city.trim().length > 0 ? city.trim() : undefined;
    const normalizedZip =
        typeof zip === "string" && zip.trim().length > 0 ? zip.trim() : undefined;
    const normalizedAnimal =
        typeof animal === "string" && animal.trim().length > 0 ? animal.trim() : undefined;
    if (isUnknownOrEmpty(normalizedAnimal) || isUnknownOrEmpty(normalizedCity)) {
        return badRequest(
            res,
            "Case must include valid animal and city (not unknown/undefined/null/empty)"
        );
    }

    const now = new Date().toISOString();
    const newCase: CaseRecord = {
        id: crypto.randomUUID(),
        roomName: roomName ?? `rescue-${Date.now()}`,
        status: "open",
        createdAt: now,
        updatedAt: now,
        callerName,
        callerPhone,
        animal: normalizedAnimal,
        city: normalizedCity,
        zip: normalizedZip,
        transcript: [],
        images: [],
        protocols: [],
        guidanceSteps: [],
        context: {
            sourceDocuments: [],
            rescueCenters: findRescueCenters({ city: normalizedCity, zip: normalizedZip })
        }
    };

    const saved = await caseStore.save(newCase);
    if (!normalizedCity && !normalizedZip) {
        console.log("[CASE] voice-first case created", {
            caseId: saved.id,
            roomName: saved.roomName,
            city: null,
            zip: null,
            source: "voice-first"
        });
    }
    eventBus.publish(saved.id, "case.created", saved);
    res.status(201).json(saved);
});

app.get("/cases/:caseId", async (req, res) => {
    const record = await getCaseOr404(res, req.params.caseId);
    if (!record) {
        return;
    }
    res.json(record);
});

app.get("/cases", async (req, res) => {
    const pageRaw = req.query.page;
    const pageSizeRaw = req.query.pageSize;
    const statusRaw = req.query.status;

    const page =
        typeof pageRaw === "string" && Number.isFinite(Number(pageRaw))
            ? Number(pageRaw)
            : 1;
    const pageSize =
        typeof pageSizeRaw === "string" && Number.isFinite(Number(pageSizeRaw))
            ? Number(pageSizeRaw)
            : 20;

    const validStatuses: CaseStatus[] = ["open", "triaged", "guidance_provided", "closed"];
    const status =
        typeof statusRaw === "string" && validStatuses.includes(statusRaw as CaseStatus)
            ? (statusRaw as CaseStatus)
            : undefined;

    const result = await caseStore.list({
        page,
        pageSize,
        status
    });
    const displayableItems = result.items.filter((record) => isCaseDisplayable(record));

    res.json({
        items: displayableItems,
        page: result.page,
        pageSize: result.pageSize,
        total: displayableItems.length
    });
});

app.patch("/cases/:caseId/intake", async (req, res) => {
    const record = await getCaseOr404(res, req.params.caseId);
    if (!record) {
        return;
    }

    const body = req.body as Partial<CaseRecord>;
    if (body.city === undefined && body.zip === undefined && !record.city && !record.zip) {
        return badRequest(res, "Case must have city or zip");
    }

    record.callerName = body.callerName ?? record.callerName;
    record.callerPhone = body.callerPhone ?? record.callerPhone;
    record.city = body.city ?? record.city;
    record.zip = body.zip ?? record.zip;
    record.animal = body.animal ?? record.animal;
    record.location = body.location ?? record.location;
    record.injury = body.injury ?? record.injury;
    record.aggression = body.aggression ?? record.aggression;
    record.collar = body.collar ?? record.collar;

    const saved = await saveAndBroadcast(record);
    res.json(saved);
});

app.post("/cases/:caseId/transcript", async (req, res) => {
    const record = await getCaseOr404(res, req.params.caseId);
    if (!record) {
        return;
    }

    const { text, final } = req.body as { text?: string; final?: boolean };
    if (!text || text.trim().length === 0) {
        return badRequest(res, "Transcript text is required");
    }

    if (final !== false) {
        record.transcript.push(text.trim());
    }

    const saved = await saveAndBroadcast(record, "transcript.updated");
    res.json(saved);
});

app.post(
    "/cases/:caseId/upload/image",
    imageUpload.single("file"),
    async (req, res) => {
        const record = await getCaseOr404(res, getParamValue(req.params.caseId));
        if (!record) {
            return;
        }

        if (!req.file) {
            return badRequest(res, "Image file is required");
        }

        const uploaded: UploadedFile = {
            id: crypto.randomUUID(),
            filename: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
            localPath: req.file.path,
            uploadedAt: new Date().toISOString()
        };

        record.images.push(uploaded);
        let imageSummary = "";
        try {
            imageSummary = await qwen.summarizeImage(uploaded.localPath);
            if (imageSummary.trim().length > 0) {
                uploaded.summary = imageSummary.trim();
            }
        } catch (error) {
            console.warn("[IMAGE] summary failed", {
                caseId: record.id,
                imageId: uploaded.id,
                message: error instanceof Error ? error.message : "unknown"
            });
        }

        let extractedText = "";
        try {
            extractedText = await unsiloed.extractTextFromImage(
                uploaded.localPath,
                uploaded.mimeType
            );
        } catch (error) {
            console.warn("[IMAGE] extraction failed", {
                caseId: record.id,
                imageId: uploaded.id,
                message: error instanceof Error ? error.message : "unknown"
            });
        }

        try {
            const indexedText = [extractedText.trim(), imageSummary.trim()]
                .filter((v) => v.length > 0)
                .join("\n\n");
            await caseStore.upsertCaseImageExtraction(record.id, uploaded, indexedText);
            console.log("[IMAGE] extraction indexed", {
                caseId: record.id,
                imageId: uploaded.id,
                extractedLength: extractedText.length,
                summaryLength: imageSummary.length
            });
        } catch (error) {
            console.warn("[IMAGE] index failed", {
                caseId: record.id,
                imageId: uploaded.id,
                message: error instanceof Error ? error.message : "unknown"
            });
        }
        const saved = await saveAndBroadcast(record, "image.uploaded");
        res.status(201).json(saved);
    }
);

app.post(
    "/cases/:caseId/upload/protocol",
    protocolUpload.single("file"),
    async (req, res) => {
        res.setHeader(
            "Warning",
            '299 - "Deprecated endpoint: use POST /kb/documents for global knowledge base uploads"'
        );

        const record = await getCaseOr404(res, getParamValue(req.params.caseId));
        if (!record) {
            return;
        }

        if (!req.file) {
            return badRequest(res, "Protocol PDF is required");
        }

        const uploaded: UploadedFile = {
            id: crypto.randomUUID(),
            filename: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
            localPath: req.file.path,
            uploadedAt: new Date().toISOString()
        };

        record.protocols.push(uploaded);

        try {
            await unsiloed.indexProtocol(record.id, req.file.path);
        } catch {
            // For MVP, continue even if indexing fails.
        }

        const saved = await saveAndBroadcast(record, "protocol.uploaded");
        res.status(201).json(saved);
    }
);

app.post("/cases/:caseId/analyze", async (req, res) => {
    const record = await getCaseOr404(res, req.params.caseId);
    if (!record) {
        return;
    }
    const force = req.body?.force === true;
    if (
        !force &&
        record.status === "guidance_provided" &&
        record.guidanceSteps.length > 0
    ) {
        console.log("[QWEN] analyze idempotent-hit", {
            caseId: record.id,
            room: record.roomName,
            writeTargetCaseId: record.id
        });
        return res.json(record);
    }

    const allKbDocs = await kbStore.list();
    const kbDocs = allKbDocs.filter((doc) => doc.status === "ready");
    if (kbDocs.length === 0) {
        const warning =
            "No ready global KB documents found. Analyze is running with fallback behavior.";
        console.warn(warning, {
            caseId: record.id,
            totalKbDocs: allKbDocs.length
        });
        record.analysisWarnings = [warning];
    } else {
        record.analysisWarnings = [];
    }
    const caseImageExtracts = await caseStore.getCaseImageExtracts(record.id);
    const result = await orchestrator.analyze(record, kbDocs, caseImageExtracts);
    record.urgency = result.urgency;
    record.guidanceSteps = result.guidanceSteps;
    record.context = result.context;
    record.status = "guidance_provided";

    const saved = await saveAndBroadcast(record, "analysis.completed");
    res.json(saved);
});

app.get("/cases/:caseId/recommendations", async (req, res) => {
    const record = await getCaseOr404(res, req.params.caseId);
    if (!record) {
        return;
    }

    const cityParam = req.query.city;
    const zipParam = req.query.zip;
    const city = typeof cityParam === "string" ? cityParam : record.city;
    const zip = typeof zipParam === "string" ? zipParam : record.zip;

    const rescueCenters = findRescueCenters({ city, zip });
    record.context.rescueCenters = rescueCenters;
    if (record.status === "open") {
        record.status = "triaged";
    }

    const saved = await saveAndBroadcast(record, "recommendations.updated");
    res.json({ caseId: record.id, rescueCenters: saved.context.rescueCenters });
});

app.post("/cases/:caseId/close", async (req, res) => {
    const record = await getCaseOr404(res, req.params.caseId);
    if (!record) {
        return;
    }

    record.status = "closed";
    const saved = await saveAndBroadcast(record, "case.closed");
    res.json(saved);
});

app.get("/events/kb", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(`event: ready\n`);
    res.write(`data: ${JSON.stringify({ scope: "global-kb" })}\n\n`);

    const unsubscribe = kbEventBus.subscribe("global-kb", res);
    req.on("close", () => {
        unsubscribe();
        res.end();
    });
});

app.get("/events/:caseId", async (req, res) => {
    const record = await getCaseOr404(res, req.params.caseId);
    if (!record) {
        return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(`event: ready\n`);
    res.write(`data: ${JSON.stringify({ caseId: record.id })}\n\n`);

    const unsubscribe = eventBus.subscribe(record.id, res);
    req.on("close", () => {
        unsubscribe();
        res.end();
    });
});

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number"
            ? ((error as { status: number }).status as number)
            : 500;

    const message =
        error instanceof Error ? error.message : "Unexpected internal server error";
    const stack = error instanceof Error ? error.stack : undefined;

    console.error(
        `[ERR] ${req.method} ${req.originalUrl} status=${status} message=${message} body=${formatLogMeta(
            sanitizeBody(req.body)
        )}`
    );
    if (stack) {
        console.error(stack);
    }

    if (res.headersSent) {
        return;
    }

    res.status(status).json({ error: message });
});

app.listen(env.port, () => {
    console.log(`Animal Rescue Copilot API running on http://localhost:${env.port}`);
});
