import "dotenv/config";
import {
    AutoSubscribe,
    cli,
    defineAgent,
    WorkerOptions,
    voice,
    type JobContext
} from "@livekit/agents";
import { classifyUrgency, type RescueCase } from "./rescueLogic.js";
import { lookupProtocol } from "./docs.js";
import { saveCase } from "./saveCase.js";

type RequiredField =
    | "animal"
    | "location"
    | "injury"
    | "aggression"
    | "collar"
    | "callerName"
    | "callerPhone";

const QUESTIONS: Array<{ field: RequiredField; prompt: string }> = [
    { field: "animal", prompt: "What animal are you reporting?" },
    { field: "location", prompt: "What is the exact location of the animal?" },
    { field: "injury", prompt: "What injuries or condition do you observe?" },
    { field: "aggression", prompt: "Is the animal aggressive, calm, or scared?" },
    { field: "collar", prompt: "Do you see a collar or any tags?" },
    { field: "callerName", prompt: "What is your full name?" },
    { field: "callerPhone", prompt: "What is the best callback phone number?" }
];

async function sayAndWait(session: voice.AgentSession, text: string) {
    const speech = session.say(text, { allowInterruptions: false });
    await speech.waitForPlayout();
}

async function waitForFinalTranscript(session: voice.AgentSession): Promise<string> {
    while (true) {
        const event = await new Promise<{
            transcript: string;
            isFinal: boolean;
        }>((resolve) => {
            session.once(voice.AgentSessionEventTypes.UserInputTranscribed, resolve);
        });

        const transcript = event.transcript.trim();
        if (event.isFinal && transcript.length > 0) {
            console.log(`[STT] Final transcript: ${transcript}`);
            return transcript;
        }
    }
}

async function runDispatchFlow(ctx: JobContext, session: voice.AgentSession) {
    const participant = await ctx.waitForParticipant();
    const participantCaseId = readCaseIdFromParticipant(participant);
    if (!participantCaseId) {
        throw new Error("VOICE_SESSION_UNBOUND_CASE_ID");
    }
    const participantIdentity = readParticipantIdentity(participant);
    const roomName = ctx.room.name;

    const dispatcher = new voice.Agent({
        instructions:
            "You are an emergency animal rescue dispatcher. Ask one question at a time."
    });

    await session.start({
        agent: dispatcher,
        room: ctx.room,
        inputOptions: {
            participantIdentity: participant.identity
        }
    });

    const rescueCase: RescueCase = {};

    await sayAndWait(
        session,
        "Animal rescue dispatch here. I will ask a few short questions, one at a time."
    );

    for (const question of QUESTIONS) {
        console.log("[VOICE] ask", {
            caseId: participantCaseId,
            room: roomName,
            identity: participantIdentity,
            field: question.field
        });
        await sayAndWait(session, question.prompt);
        const answer = await waitForFinalTranscript(session);
        const normalizedAnswer =
            question.field === "callerPhone" ? normalizeSpokenPhone(answer) : answer;
        rescueCase[question.field] = normalizedAnswer;
        console.log("[VOICE] answer", {
            caseId: participantCaseId,
            room: roomName,
            identity: participantIdentity,
            field: question.field,
            value: normalizedAnswer
        });
    }

    rescueCase.urgency = classifyUrgency(rescueCase);

    const protocol = await lookupProtocol(
        `Animal: ${rescueCase.animal}. Injury: ${rescueCase.injury}. Aggression: ${rescueCase.aggression}.`
    );

    const saved = await saveCase(rescueCase, {
        roomName,
        caseId: participantCaseId,
        identity: participantIdentity
    });

    await sayAndWait(
        session,
        `Thank you ${rescueCase.callerName}. Your case is recorded as ${rescueCase.urgency}. Reference ID ${saved.id}.`
    );
    await sayAndWait(session, protocol);
    await sayAndWait(session, "A rescue team will follow up shortly. Goodbye.");
}

function readCaseIdFromParticipant(participant: unknown): string | undefined {
    if (!participant || typeof participant !== "object") {
        return undefined;
    }

    const maybeMetadata = (participant as { metadata?: unknown }).metadata;
    if (typeof maybeMetadata !== "string" || maybeMetadata.trim().length === 0) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(maybeMetadata) as { caseId?: unknown };
        if (typeof parsed.caseId === "string" && parsed.caseId.trim().length > 0) {
            return parsed.caseId.trim();
        }
    } catch {
        // Ignore malformed metadata.
    }

    return undefined;
}

function readParticipantIdentity(participant: unknown): string | undefined {
    if (!participant || typeof participant !== "object") {
        return undefined;
    }
    const identity = (participant as { identity?: unknown }).identity;
    return typeof identity === "string" && identity.trim().length > 0 ? identity : undefined;
}

function normalizeSpokenPhone(input: string): string {
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

    const digitsOnly = expanded.join("").replace(/[^\d+]/g, "");
    return digitsOnly.length > 0 ? digitsOnly : input.trim();
}

export default defineAgent({
    entry: async (ctx: JobContext) => {
        await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

        const ttsModel =
            process.env.TTS_MODEL ??
            (process.env.MINIMAX_API_KEY
                ? process.env.MINIMAX_TTS_MODEL ?? "minimax/speech-02-hd"
                : "cartesia/sonic-2");

        const session = new voice.AgentSession({
            stt: process.env.STT_MODEL ?? "deepgram/nova-3:en",
            tts: ttsModel
        });

        try {
            await runDispatchFlow(ctx, session);
        } finally {
            await session.close();
        }
    }
});

if (import.meta.url === `file://${process.argv[1]}`) {
    cli.runApp(
        new WorkerOptions({
            agent: import.meta.filename
        })
    );
}
