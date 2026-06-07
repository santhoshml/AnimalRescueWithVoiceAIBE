import "dotenv/config";
import express from "express";
import cors from "cors";
import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";
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

process.on("unhandledRejection", (reason) => {
    console.error("[PROCESS] unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
    console.error("[PROCESS] uncaughtException", error);
});

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
const dispatchClient = new AgentDispatchClient(
    env.livekitUrl,
    env.livekitApiKey,
    env.livekitApiSecret
);
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
    const hasAnimal = typeof record?.animal === "string" && record.animal.trim().length > 0;
    const hasCity = typeof record?.city === "string" && record.city.trim().length > 0;
    const hasZip = typeof record?.zip === "string" && record.zip.trim().length > 0;
    return hasAnimal && (hasCity || hasZip);
}

function normalizeSpokenPhone(input: string): string | null {
    const cleaned = input.toLowerCase().replace(/[^a-z0-9+\s]/g, " ");
    const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
    const digitMap: Record<string, string> = {
        zero: "0",
        oh: "0",
        o: "0",
        one: "1",
        two: "2",
        three: "3",
        four: "4",
        five: "5",
        six: "6",
        seven: "7",
        eight: "8",
        nine: "9"
    };

    const expanded: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i]!;
        if ((token === "double" || token === "triple") && i + 1 < tokens.length) {
            const next = tokens[i + 1]!;
            const mapped = digitMap[next] ?? (/^\d$/.test(next) ? next : "");
            if (mapped) {
                expanded.push(mapped);
                expanded.push(mapped);
                if (token === "triple") {
                    expanded.push(mapped);
                }
                i += 1;
                continue;
            }
        }

        if (digitMap[token]) {
            expanded.push(digitMap[token]);
            continue;
        }
        if (/^\d+$/.test(token)) {
            expanded.push(token);
        }
    }

    const digitsOnly = expanded.join("").replace(/\D/g, "");
    if (digitsOnly.length >= 7) {
        return digitsOnly;
    }
    return null;
}

function toAbsoluteUploadUrl(req: Request, file: UploadedFile): string | undefined {
    if (typeof file.url === "string" && /^https?:\/\//i.test(file.url)) {
        return file.url;
    }

    const host = req.get("host");
    if (!host) {
        return file.url;
    }

    const pathCandidate = (file.url ?? file.localPath).replace(/\\/g, "/");
    const marker = "/uploads/";
    const markerIndex = pathCandidate.lastIndexOf(marker);
    const uploadPath =
        markerIndex >= 0
            ? pathCandidate.slice(markerIndex)
            : pathCandidate.startsWith("uploads/")
              ? `/${pathCandidate}`
              : undefined;

    if (!uploadPath) {
        return file.url;
    }

    return `${req.protocol}://${host}${uploadPath}`;
}

function withCaseResponseShape(req: Request, record: CaseRecord): CaseRecord {
    const normalizeFile = (file: UploadedFile): UploadedFile => ({
        ...file,
        url: toAbsoluteUploadUrl(req, file),
        summary: file.summary ?? null,
        speciesGuess: file.speciesGuess ?? null,
        speciesConfidence:
            typeof file.speciesConfidence === "number" ? file.speciesConfidence : null,
        isLikelyEndangered:
            typeof file.isLikelyEndangered === "boolean" ? file.isLikelyEndangered : null,
        endangeredConfidence:
            typeof file.endangeredConfidence === "number" ? file.endangeredConfidence : null
    });

    const normalizedConfidence =
        typeof record.context.confidence === "number" &&
        Number.isFinite(record.context.confidence)
            ? Math.max(0, Math.min(1, record.context.confidence))
            : null;
    const normalizedLocationConfidence =
        typeof record.locationConfidence === "number" && Number.isFinite(record.locationConfidence)
            ? Math.max(0, Math.min(1, record.locationConfidence))
            : null;

    return {
        ...record,
        locationSource: record.locationSource ?? null,
        locationConfidence: normalizedLocationConfidence,
        locationUpdatedAt: record.locationUpdatedAt ?? null,
        context: {
            ...record.context,
            confidence: normalizedConfidence
        },
        images: record.images.map(normalizeFile),
        protocols: record.protocols.map(normalizeFile)
    };
}

function makePublicReferenceId(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 4; i += 1) {
        out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
}

const allowedCaseStatuses: readonly CaseStatus[] = [
    "open",
    "triaged",
    "guidance_provided",
    "rescue_onway",
    "rescue_complete",
    "closed"
] as const;

async function generateUniquePublicReferenceId(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = makePublicReferenceId();
        const existing = await caseStore.list({ page: 1, pageSize: 500 });
        if (!existing.items.some((item) => item.publicReferenceId === candidate)) {
            return candidate;
        }
    }
    return makePublicReferenceId();
}

type InferredLocation = {
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
    locationSource: "telephony" | "number_lookup" | "ip";
    locationConfidence: number;
    fallbackReason?: string;
};

function normalizeLocationString(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function pickLocationCandidate(raw: unknown): {
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
} | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const record = raw as Record<string, unknown>;
    const city = normalizeLocationString(record.city);
    const state = normalizeLocationString(record.state);
    const zip = normalizeLocationString(record.zip ?? record.postalCode ?? record.postal_code);
    const country = normalizeLocationString(record.country ?? record.countryCode ?? record.country_code);
    if (!city && !state && !zip && !country) {
        return null;
    }
    return { city, state, zip, country };
}

function getClientIp(req: Request): string | undefined {
    const xff = req.headers["x-forwarded-for"];
    const forwarded = typeof xff === "string" ? xff.split(",")[0]?.trim() : undefined;
    const ip = forwarded || req.ip || undefined;
    return ip?.replace(/^::ffff:/, "");
}

function isPrivateIp(ip: string): boolean {
    return (
        ip.startsWith("10.") ||
        ip.startsWith("192.168.") ||
        ip.startsWith("172.16.") ||
        ip.startsWith("172.17.") ||
        ip.startsWith("172.18.") ||
        ip.startsWith("172.19.") ||
        ip.startsWith("172.2") ||
        ip.startsWith("172.30.") ||
        ip.startsWith("172.31.") ||
        ip === "127.0.0.1" ||
        ip === "::1"
    );
}

function inferLocationFromRequest(req: Request): InferredLocation | null {
    const body = req.body as Record<string, unknown> | undefined;
    const telephonyCandidate = pickLocationCandidate(
        body?.telephony ?? body?.callMetadata ?? body?.providerMetadata
    );
    if (telephonyCandidate) {
        return {
            ...telephonyCandidate,
            locationSource: "telephony",
            locationConfidence: 0.95
        };
    }

    const numberLookupCandidate = pickLocationCandidate(
        body?.numberLookup ?? body?.number_lookup ?? body?.callerNumberLookup
    );
    if (numberLookupCandidate) {
        return {
            ...numberLookupCandidate,
            locationSource: "number_lookup",
            locationConfidence: 0.75
        };
    }

    const ip = getClientIp(req);
    if (ip && !isPrivateIp(ip)) {
        // Coarse fallback only for demo: country-level.
        return {
            country: "US",
            locationSource: "ip",
            locationConfidence: 0.25
        };
    }

    return null;
}

async function inferAndApplyLocation(caseRecord: CaseRecord, req: Request, trigger: string) {
    const inferred = inferLocationFromRequest(req);
    if (!inferred) {
        console.log("[LOCATION] inference unavailable", {
            caseId: caseRecord.id,
            trigger,
            fallbackReason: "no_usable_source"
        });
        return;
    }

    if (caseRecord.locationSource === "manual") {
        console.log("[LOCATION] manual location preserved", {
            caseId: caseRecord.id,
            trigger,
            source: caseRecord.locationSource
        });
        return;
    }

    const currentScore = caseRecord.locationConfidence ?? -1;
    if (
        currentScore > inferred.locationConfidence &&
        (caseRecord.city || caseRecord.state || caseRecord.zip || caseRecord.country)
    ) {
        console.log("[LOCATION] existing higher-confidence location retained", {
            caseId: caseRecord.id,
            trigger,
            currentScore,
            inferredScore: inferred.locationConfidence
        });
        return;
    }

    caseRecord.city = inferred.city ?? caseRecord.city;
    caseRecord.state = inferred.state ?? caseRecord.state;
    caseRecord.zip = inferred.zip ?? caseRecord.zip;
    caseRecord.country = inferred.country ?? caseRecord.country;
    caseRecord.locationSource = inferred.locationSource;
    caseRecord.locationConfidence = inferred.locationConfidence;
    caseRecord.locationUpdatedAt = new Date().toISOString();

    const saved = await saveAndBroadcast(caseRecord, "case.location.updated");
    console.log("[LOCATION] inferred", {
        caseId: saved.id,
        trigger,
        chosenSource: inferred.locationSource,
        city: saved.city ?? null,
        state: saved.state ?? null,
        zip: saved.zip ?? null,
        country: saved.country ?? null,
        confidence: inferred.locationConfidence
    });
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
    if (!found) {
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
    const normalized: CaseRecord = {
        ...caseRecord,
        updatedAt: new Date().toISOString(),
        locationSource: caseRecord.locationSource ?? null,
        locationConfidence:
            typeof caseRecord.locationConfidence === "number" &&
            Number.isFinite(caseRecord.locationConfidence)
                ? Math.max(0, Math.min(1, caseRecord.locationConfidence))
                : null,
        locationUpdatedAt: caseRecord.locationUpdatedAt ?? null,
        context: {
            ...caseRecord.context,
            confidence:
                typeof caseRecord.context.confidence === "number" &&
                Number.isFinite(caseRecord.context.confidence)
                    ? Math.max(0, Math.min(1, caseRecord.context.confidence))
                    : null
        },
        images: caseRecord.images.map((f) => ({ ...f, summary: f.summary ?? null })),
        protocols: caseRecord.protocols.map((f) => ({ ...f, summary: f.summary ?? null }))
    };
    const saved = await caseStore.save(normalized);
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

    const refreshedCase = caseRecord;

    const token = new AccessToken(
        env.livekitApiKey,
        env.livekitApiSecret,
        {
            identity,
            metadata: JSON.stringify({
                caseId,
                inferredLocation: {
                    city: refreshedCase.city ?? null,
                    state: refreshedCase.state ?? null,
                    zip: refreshedCase.zip ?? null,
                    country: refreshedCase.country ?? null,
                    source: refreshedCase.locationSource ?? null,
                    confidence: refreshedCase.locationConfidence ?? null
                }
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
        writeTargetCaseId: refreshedCase.id
    });

    res.json({
        token: await token.toJwt(),
        url: env.livekitUrl,
        room,
        caseId
    });
});

app.post("/agent/dispatch", async (req, res) => {
    const room =
        typeof req.body?.room === "string" && req.body.room.trim().length > 0
            ? req.body.room.trim()
            : "";
    const caseId =
        typeof req.body?.caseId === "string" && req.body.caseId.trim().length > 0
            ? req.body.caseId.trim()
            : "";
    const identity =
        typeof req.body?.identity === "string" && req.body.identity.trim().length > 0
            ? req.body.identity.trim()
            : undefined;

    if (!room) {
        return badRequest(res, "room is required");
    }
    if (!caseId) {
        return badRequest(res, "caseId is required");
    }

    const record = await caseStore.get(caseId);
    if (!record) {
        return res.status(404).json({ error: "Case not found for provided caseId" });
    }

    try {
        const dispatches = await dispatchClient.listDispatch(room);
        const alreadyDispatched = dispatches.find(
            (d) => d.agentName === env.livekitAgentName
        );
        if (alreadyDispatched) {
            console.log("[VOICE] agent dispatch idempotent-hit", {
                caseId,
                room,
                identity: identity ?? null,
                agentName: env.livekitAgentName,
                dispatchId: alreadyDispatched.id
            });
            return res.json({
                ok: true,
                room,
                caseId,
                agentName: env.livekitAgentName,
                dispatchId: alreadyDispatched.id,
                reused: true
            });
        }

        const dispatch = await dispatchClient.createDispatch(room, env.livekitAgentName, {
            metadata: JSON.stringify({
                caseId,
                identity: identity ?? null
            })
        });

        console.log("[VOICE] agent dispatch created", {
            caseId,
            room,
            identity: identity ?? null,
            agentName: env.livekitAgentName,
            dispatchId: dispatch.id
        });
        return res.status(201).json({
            ok: true,
            room,
            caseId,
            agentName: env.livekitAgentName,
            dispatchId: dispatch.id
        });
    } catch (error) {
        console.error("[VOICE] agent dispatch failed", {
            caseId,
            room,
            identity: identity ?? null,
            agentName: env.livekitAgentName,
            message: error instanceof Error ? error.message : "unknown"
        });
        return res.status(502).json({
            error: "Failed to dispatch agent",
            code: "AGENT_DISPATCH_FAILED"
        });
    }
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

    const now = new Date().toISOString();
    const newCase: CaseRecord = {
        id: crypto.randomUUID(),
        publicReferenceId: await generateUniquePublicReferenceId(),
        roomName: roomName ?? `rescue-${Date.now()}`,
        status: "open",
        createdAt: now,
        updatedAt: now,
        callerName,
        callerPhone: callerPhone ? normalizeSpokenPhone(callerPhone) ?? callerPhone : undefined,
        animal: normalizedAnimal,
        city: normalizedCity,
        state: undefined,
        zip: normalizedZip,
        country: undefined,
        locationSource: null,
        locationConfidence: null,
        locationUpdatedAt: null,
        transcript: [],
        images: [],
        protocols: [],
        guidanceSteps: [],
        context: {
            confidence: null,
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
    res.status(201).json(withCaseResponseShape(req, saved));
});

app.get("/cases/:caseId", async (req, res) => {
    const record = await getCaseOr404(res, req.params.caseId);
    if (!record) {
        return;
    }
    res.json(withCaseResponseShape(req, record));
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

    const status =
        typeof statusRaw === "string" && allowedCaseStatuses.includes(statusRaw as CaseStatus)
            ? (statusRaw as CaseStatus)
            : undefined;

    const result = await caseStore.list({
        page,
        pageSize,
        status
    });
    const displayableItems = result.items.filter((record) => isCaseDisplayable(record));

    res.json({
        items: displayableItems.map((record) => withCaseResponseShape(req, record)),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total
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
    if (typeof body.callerPhone === "string") {
        record.callerPhone = normalizeSpokenPhone(body.callerPhone) ?? body.callerPhone.trim();
    }
    const previousLocation = {
        city: record.city,
        state: record.state,
        zip: record.zip,
        country: record.country,
        source: record.locationSource
    };
    record.city = body.city ?? record.city;
    record.state = body.state ?? record.state;
    record.zip = body.zip ?? record.zip;
    record.country = body.country ?? record.country;
    record.animal = body.animal ?? record.animal;
    record.location = body.location ?? record.location;
    record.injury = body.injury ?? record.injury;
    record.aggression = body.aggression ?? record.aggression;
    record.collar = body.collar ?? record.collar;
    if (
        body.city !== undefined ||
        body.state !== undefined ||
        body.zip !== undefined ||
        body.country !== undefined
    ) {
        record.locationSource = "manual";
        record.locationConfidence = 1;
        record.locationUpdatedAt = new Date().toISOString();
        console.log("[LOCATION] manual override", {
            caseId: record.id,
            previousLocation
        });
    }

    const saved = await saveAndBroadcast(record);
    res.json(withCaseResponseShape(req, saved));
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
        const normalizedPhone = normalizeSpokenPhone(text);
        if (normalizedPhone) {
            record.callerPhone = normalizedPhone;
        }
    }
    const saved = await saveAndBroadcast(record, "transcript.updated");
    res.json(withCaseResponseShape(req, saved));
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
            url: `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`,
            uploadedAt: new Date().toISOString()
        };

        record.images.push(uploaded);
        let imageSummary = "";
        try {
            const vision = await qwen.analyzeImage(uploaded.localPath);
            if (vision) {
                if (vision.summary.trim().length > 0) {
                    uploaded.summary = vision.summary.trim();
                    imageSummary = vision.summary.trim();
                }
                uploaded.speciesGuess = vision.speciesGuess;
                uploaded.speciesConfidence = vision.speciesConfidence;
                uploaded.isLikelyEndangered = vision.isLikelyEndangered;
                uploaded.endangeredConfidence = vision.endangeredConfidence;
            }
        } catch (error) {
            console.warn("[IMAGE] analysis failed", {
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
        res.status(201).json(withCaseResponseShape(req, saved));
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
            url: `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`,
            uploadedAt: new Date().toISOString()
        };

        record.protocols.push(uploaded);

        try {
            await unsiloed.indexProtocol(record.id, req.file.path);
        } catch {
            // For MVP, continue even if indexing fails.
        }

        const saved = await saveAndBroadcast(record, "protocol.uploaded");
        res.status(201).json(withCaseResponseShape(req, saved));
    }
);

app.post("/cases/:caseId/analyze", async (req, res) => {
    const record = await getCaseOr404(res, req.params.caseId);
    if (!record) {
        return;
    }
    const force = req.body?.force === true;
    if (!force && record.status === "open") {
        return res.status(409).json({
            error: "Case is still open. Start/join voice session before analyze.",
            code: "CASE_NOT_READY_FOR_ANALYZE",
            caseId: record.id
        });
    }
    const hasVoiceIntake =
        record.transcript.some((t) => typeof t === "string" && t.trim().length > 0) ||
        !isUnknownOrEmpty(record.callerName) ||
        !isUnknownOrEmpty(record.callerPhone) ||
        !isUnknownOrEmpty(record.injury) ||
        !isUnknownOrEmpty(record.aggression) ||
        !isUnknownOrEmpty(record.location) ||
        !isUnknownOrEmpty(record.city) ||
        !isUnknownOrEmpty(record.zip);

    if (!force && !hasVoiceIntake) {
        return res.status(409).json({
            error: "Case intake is incomplete. Analyze after voice intake begins.",
            code: "CASE_INTAKE_INCOMPLETE",
            caseId: record.id
        });
    }

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
    res.json(withCaseResponseShape(req, saved));
});

app.post("/cases/:caseId/session-complete", async (req, res) => {
    const caseId = getParamValue(req.params.caseId).trim();
    if (!caseId) {
        return badRequest(res, "caseId is required");
    }
    const record = await getCaseOr404(res, caseId);
    if (!record) {
        return;
    }

    const payload = {
        caseId: record.id,
        room: typeof req.body?.room === "string" ? req.body.room : record.roomName,
        identity: typeof req.body?.identity === "string" ? req.body.identity : null,
        finalMessage:
            typeof req.body?.finalMessage === "string" ? req.body.finalMessage : null,
        completedAt: new Date().toISOString()
    };
    eventBus.publish(record.id, "session_complete", payload);
    eventBus.publish(record.id, "agent_final_message", payload);
    res.status(202).json({ ok: true, ...payload });
});

app.patch("/cases/:caseId/status", async (req, res) => {
    const caseId = getParamValue(req.params.caseId).trim();
    if (!caseId) {
        return res.status(404).json({ error: "Case not found" });
    }

    const record = await getCaseOr404(res, caseId);
    if (!record) {
        return;
    }

    const rawStatus = req.body?.status;
    if (typeof rawStatus !== "string" || rawStatus.trim().length === 0) {
        return badRequest(res, "status is required");
    }

    const nextStatus = rawStatus.trim() as CaseStatus;
    if (!allowedCaseStatuses.includes(nextStatus)) {
        return badRequest(
            res,
            `Invalid status. Allowed values: ${allowedCaseStatuses.join(", ")}`
        );
    }

    record.status = nextStatus;
    const saved = await saveAndBroadcast(record, "case.status.updated");
    res.json(withCaseResponseShape(req, saved));
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
    res.json(withCaseResponseShape(req, saved));
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
