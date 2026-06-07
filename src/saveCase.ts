import type { RescueCase } from "./rescueLogic.js";
import { CaseStore } from "./services/caseStore.js";
import type { CaseRecord } from "./types/case.js";

const caseStore = new CaseStore();

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
    const existing = await caseStore.get(resolvedCaseId);
    if (!existing) {
        throw new Error(`VOICE_CASE_NOT_FOUND:${resolvedCaseId}`);
    }
    if (isUnknownOrEmpty(rescueCase.animal) || isUnknownOrEmpty(rescueCase.location)) {
        throw new Error("VOICE_CASE_INCOMPLETE_ANIMAL_OR_CITY");
    }

    const item: CaseRecord = {
        ...existing,
        roomName: resolvedRoomName,
        updatedAt: now,
        status: "guidance_provided",
        animal: rescueCase.animal,
        location: rescueCase.location,
        city: rescueCase.location,
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

    await caseStore.save(item);

    return item;
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
