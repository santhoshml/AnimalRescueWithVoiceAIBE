import type { RescueCase } from "./rescueLogic.js";
import { env } from "./config/env.js";
import type { CaseRecord } from "./types/case.js";

type SaveCaseOptions = {
    roomName?: string;
    caseId: string;
    identity?: string;
};

export async function saveCase(rescueCase: RescueCase, options?: SaveCaseOptions) {
    if (!options?.caseId || options.caseId.trim().length === 0) {
        throw new Error("VOICE_CASE_ID_REQUIRED");
    }

    const now = new Date().toISOString();
    const resolvedRoomName = options?.roomName?.trim().length
        ? options.roomName
        : `voice-${Date.now()}`;
    const resolvedCaseId = options.caseId.trim();
    const existing = await getCaseById(resolvedCaseId);
    if (!existing) {
        throw new Error(`VOICE_CASE_NOT_FOUND:${resolvedCaseId}`);
    }
    if (isUnknownOrEmpty(rescueCase.animal)) {
        throw new Error("VOICE_CASE_INCOMPLETE_ANIMAL");
    }

    const item: CaseRecord = {
        ...existing,
        roomName: resolvedRoomName,
        updatedAt: now,
        status: "guidance_provided",
        animal: rescueCase.animal,
        location: rescueCase.location ?? existing.location,
        city: rescueCase.location ?? existing.city,
        injury: rescueCase.injury,
        aggression: rescueCase.aggression,
        collar: rescueCase.collar,
        callerName: rescueCase.callerName,
        callerPhone: rescueCase.callerPhone,
        urgency: rescueCase.urgency,
        transcript: buildTranscript(rescueCase),
        context: {
            ...existing.context,
            species: rescueCase.animal ?? existing.context.species
        }
    };

    console.log("[VOICE] saveCase target", {
        resolvedCaseId: resolvedCaseId ?? null,
        resolvedRoomName,
        identity: options.identity ?? null,
        targetCaseId: item.id,
        targetCaseRoomName: item.roomName
    });

    const intakeSaved = await patchIntake(item.id, {
        callerName: item.callerName,
        callerPhone: item.callerPhone,
        city: item.city,
        state: item.state,
        zip: item.zip,
        country: item.country,
        animal: item.animal,
        location: item.location,
        injury: item.injury,
        aggression: item.aggression,
        collar: item.collar
    });

    const mergedTranscript = buildTranscript(rescueCase).join(" ");
    if (mergedTranscript.trim().length > 0) {
        await postTranscript(item.id, mergedTranscript.trim());
    }

    await patchStatus(item.id, "guidance_provided");
    return intakeSaved;
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

function buildTranscript(rescueCase: RescueCase): string[] {
    const entries: string[] = [];

    if (rescueCase.animal) {
        entries.push(`Animal reported: ${rescueCase.animal}`);
    }
    if (rescueCase.location) {
        entries.push(`Location reported: ${rescueCase.location}`);
    }
    if (rescueCase.injury) {
        entries.push(`Injury/condition reported: ${rescueCase.injury}`);
    }
    if (rescueCase.aggression) {
        entries.push(`Behavior/aggression reported: ${rescueCase.aggression}`);
    }
    if (rescueCase.collar) {
        entries.push(`Collar/tags reported: ${rescueCase.collar}`);
    }
    if (rescueCase.callerName) {
        entries.push(`Caller name: ${rescueCase.callerName}`);
    }
    if (rescueCase.callerPhone) {
        entries.push(`Caller phone: ${rescueCase.callerPhone}`);
    }

    return entries;
}

function getCaseApiBaseUrl(): string {
    if (process.env.CASE_API_BASE_URL && process.env.CASE_API_BASE_URL.trim().length > 0) {
        return process.env.CASE_API_BASE_URL.trim().replace(/\/+$/, "");
    }
    return `http://127.0.0.1:${env.port}`;
}

async function getCaseById(caseId: string): Promise<CaseRecord | null> {
    const baseUrl = getCaseApiBaseUrl();
    const response = await fetch(`${baseUrl}/cases/${encodeURIComponent(caseId)}`);
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`VOICE_CASE_LOOKUP_FAILED:${response.status}`);
    }
    return (await response.json()) as CaseRecord;
}

async function patchIntake(
    caseId: string,
    body: Partial<CaseRecord>
): Promise<CaseRecord> {
    const baseUrl = getCaseApiBaseUrl();
    const response = await fetch(`${baseUrl}/cases/${encodeURIComponent(caseId)}/intake`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        throw new Error(`VOICE_CASE_INTAKE_UPDATE_FAILED:${response.status}`);
    }
    return (await response.json()) as CaseRecord;
}

async function postTranscript(caseId: string, text: string): Promise<void> {
    const baseUrl = getCaseApiBaseUrl();
    const response = await fetch(`${baseUrl}/cases/${encodeURIComponent(caseId)}/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, final: true })
    });
    if (!response.ok) {
        console.warn("[VOICE] transcript update failed", {
            caseId,
            status: response.status
        });
    }
}

async function patchStatus(caseId: string, status: string): Promise<void> {
    const baseUrl = getCaseApiBaseUrl();
    const response = await fetch(`${baseUrl}/cases/${encodeURIComponent(caseId)}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
    });
    if (!response.ok) {
        console.warn("[VOICE] status update failed", {
            caseId,
            statusCode: response.status
        });
    }
}
