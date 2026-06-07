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
import { env } from "./config/env.js";
import { CaseStore } from "./services/caseStore.js";
import { QwenClient } from "./services/qwenClient.js";

type RequiredField =
    | "animal"
    | "injury"
    | "aggression"
    | "collar"
    | "callerName"
    | "callerPhone";

const QUESTIONS: Array<{ field: RequiredField; prompt: string }> = [
    { field: "animal", prompt: "What animal are you reporting?" },
    { field: "injury", prompt: "What injuries or condition do you observe?" },
    { field: "aggression", prompt: "Is the animal aggressive, calm, or scared?" },
    { field: "collar", prompt: "Do you see a collar or any tags?" },
    { field: "callerPhone", prompt: "What is the best callback phone number?" }
];
const qwen = new QwenClient();
const caseStore = new CaseStore();

async function sayAndWait(session: voice.AgentSession, text: string) {
    const speech = session.say(text, { allowInterruptions: false });
    const estimatedMs = Math.max(12_000, Math.min(30_000, text.length * 120));
    await promiseWithTimeout(
        speech.waitForPlayout(),
        estimatedMs,
        `VOICE_TTS_PLAYOUT_TIMEOUT: ${text.slice(0, 80)}`
    );
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
    console.log("[VOICE] waiting for participant");
    const participant = await ctx.waitForParticipant();
    console.log("[VOICE] participant joined", {
        room: ctx.room.name,
        identity: readParticipantIdentity(participant) ?? null
    });
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

    console.log("[VOICE] session.start begin");
    await promiseWithTimeout(
        session.start({
            agent: dispatcher,
            room: ctx.room,
            inputOptions: {
                participantIdentity: participant.identity
            }
        }),
        15_000,
        "VOICE_SESSION_START_TIMEOUT"
    );
    console.log("[VOICE] session.start ready");

    const rescueCase: RescueCase = {};

    await sayAndWait(
        session,
        "Hi, this is Animal Rescue Dispatch. I am here to help. I will ask a few quick questions, one at a time."
    );

    await sayAndWait(session, "May I have your full name?");
    const callerName = await waitForFinalTranscript(session);
    rescueCase.callerName = callerName.trim();
    console.log("[VOICE] answer", {
        caseId: participantCaseId,
        room: roomName,
        identity: participantIdentity,
        field: "callerName",
        value: callerName
    });
    await sayAndWait(session, "What location are you calling from right now?");
    const manualLocation = await waitForFinalTranscript(session);
    console.log("[VOICE] location manual", {
        caseId: participantCaseId,
        room: roomName,
        identity: participantIdentity,
        value: manualLocation
    });
    if (manualLocation.trim().length > 0) {
        rescueCase.location = manualLocation.trim();
    }

    let protocolPromise: Promise<string> | null = null;
    let riskStatementPromise: Promise<string> | null = null;

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

        if (question.field === "collar" && !protocolPromise && !riskStatementPromise) {
            rescueCase.urgency = classifyUrgency(rescueCase);
            const riskCaseSnapshot: RescueCase = { ...rescueCase };
            protocolPromise = lookupProtocol(
                `Animal: ${riskCaseSnapshot.animal}. Injury: ${riskCaseSnapshot.injury}. Aggression: ${riskCaseSnapshot.aggression}.`
            );
            riskStatementPromise = protocolPromise.then((protocol) =>
                generateRiskStatement(participantCaseId, riskCaseSnapshot, protocol)
            );
        }
    }

    rescueCase.urgency = classifyUrgency(rescueCase);
    if (!protocolPromise) {
        protocolPromise = lookupProtocol(
            `Animal: ${rescueCase.animal}. Injury: ${rescueCase.injury}. Aggression: ${rescueCase.aggression}.`
        );
    }
    const protocol = await protocolPromise;

    if (!riskStatementPromise) {
        riskStatementPromise = generateRiskStatement(participantCaseId, rescueCase, protocol);
    }

    const saved = await saveCase(rescueCase, {
        roomName,
        caseId: participantCaseId,
        identity: participantIdentity
    });

    await sayAndWait(
        session,
        `Thank you, ${rescueCase.callerName}. I have recorded your case as ${rescueCase.urgency}.`
    );
    await sayAndWait(
        session,
        `Our rescue team will continue with the information you shared on this call. Your reference ID is ${saved.publicReferenceId ?? saved.id}.`
    );
    await sayAndWait(session, protocol);
    await sayAndWait(
        session,
        "Please give me three seconds while I assess the situation and provide a final update."
    );
    const riskStatement = await withTimeout(
        riskStatementPromise,
        3000,
        "Based on the current rescue protocol, this case may have elevated mortality risk without prompt intervention."
    );
    await sayAndWait(session, riskStatement);
    await sayAndWait(session, "After this call, please upload a photo of the animal as soon as you can.");
    const finalGoodbye =
        "Our AI will use the image to identify the species, assess possible injuries, determine urgency, and check whether the animal belongs to a protected or endangered species. Thank you! Goodbye";
    await sayAndWait(session, finalGoodbye);
    await emitSessionComplete(participantCaseId, roomName, participantIdentity, finalGoodbye);
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

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(fallback), timeoutMs);
            })
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

async function promiseWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
            })
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

async function generateRiskStatement(
    caseId: string,
    rescueCase: RescueCase,
    protocol: string
): Promise<string> {
    const caseWithImages = await caseStore.get(caseId);
    const imageContext = caseWithImages
        ? caseWithImages.images
            .map((img, index) => ({
                index: index + 1,
                filename: img.filename,
                summary: img.summary ?? null,
                speciesGuess: img.speciesGuess ?? null,
                speciesConfidence: img.speciesConfidence ?? null,
                isLikelyEndangered: img.isLikelyEndangered ?? null,
                endangeredConfidence: img.endangeredConfidence ?? null
            }))
            .filter(
                (img) =>
                    (typeof img.summary === "string" && img.summary.trim().length > 0) ||
                    img.isLikelyEndangered !== null
            )
            .map(
                (img) =>
                    `image_${img.index}(${img.filename}): summary=${img.summary ?? "none"}; speciesGuess=${img.speciesGuess ?? "unknown"}; speciesConfidence=${img.speciesConfidence ?? "null"}; isLikelyEndangered=${img.isLikelyEndangered ?? "null"}; endangeredConfidence=${img.endangeredConfidence ?? "null"}`
            )
            .join("\n")
        : "";
    const hasImageContext = imageContext.trim().length > 0;
    const userContext = hasImageContext
        ? [`image_findings=${imageContext}`].join("\n")
        : [
            `animal=${rescueCase.animal ?? "unknown"}`,
            `location=${rescueCase.location ?? "unknown"}`,
            `injury=${rescueCase.injury ?? "unknown"}`,
            `aggression=${rescueCase.aggression ?? "unknown"}`,
            `collar=${rescueCase.collar ?? "unknown"}`,
            `urgency=${rescueCase.urgency ?? "unknown"}`,
            `protocol=${protocol}`
        ].join("\n");

    try {
        const response = await qwen.chat([
            {
                role: "system",
                content:
                    hasImageContext
                        ? "You are an animal rescue risk assistant. Output exactly one sentence based only on provided image findings. Include: (1) estimated mortality risk percentage and (2) intervention urgency. Mention endangered status only when it is likely endangered; otherwise do not mention endangered status at all. Keep it concise and non-alarmist."
                        : "You are an animal rescue risk assistant. Output exactly one sentence. Include: (1) estimated mortality risk percentage and (2) intervention urgency. Mention endangered status only when it is likely endangered; otherwise do not mention endangered status at all. Keep it concise and non-alarmist."
            },
            {
                role: "user",
                content: `Generate one final spoken risk statement from this case context:\n${userContext}`
            }
        ]);
        const oneLine = response.replace(/\s+/g, " ").trim();
        if (oneLine.length > 0) {
            return oneLine;
        }
    } catch {
        // fallback below
    }

    return "Based on the current rescue protocol, this case may have elevated mortality risk without prompt intervention.";
}

export default defineAgent({
    entry: async (ctx: JobContext) => {
        await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

        const baseTtsModel =
            process.env.TTS_MODEL ??
            (process.env.MINIMAX_API_KEY
                ? process.env.MINIMAX_TTS_MODEL ?? "minimax/speech-02-hd"
                : "cartesia/sonic-2");
        const ttsModel = pickRandomGenderVoiceModel(baseTtsModel);

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

function pickRandomGenderVoiceModel(baseModel: string): string {
    if (baseModel.includes(":")) {
        return baseModel;
    }
    const maleVoice = process.env.TTS_VOICE_MALE?.trim();
    const femaleVoice = process.env.TTS_VOICE_FEMALE?.trim();
    const choices = [maleVoice, femaleVoice].filter((v): v is string => Boolean(v));
    if (choices.length === 0) {
        return baseModel;
    }
    const selected = choices[Math.floor(Math.random() * choices.length)]!;
    console.log("[VOICE] selected tts voice", {
        model: baseModel,
        selectedVoice: selected,
        mode: "random_male_female"
    });
    return `${baseModel}:${selected}`;
}

async function emitSessionComplete(
    caseId: string,
    room: string | undefined,
    identity: string | undefined,
    finalMessage: string
): Promise<void> {
    const baseUrl =
        process.env.CASE_API_BASE_URL?.trim().replace(/\/+$/, "") ??
        `http://127.0.0.1:${env.port}`;
    try {
        const response = await fetch(
            `${baseUrl}/cases/${encodeURIComponent(caseId)}/session-complete`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    room,
                    identity: identity ?? null,
                    finalMessage
                })
            }
        );
        if (!response.ok) {
            console.warn("[VOICE] session_complete emit failed", {
                caseId,
                room,
                identity: identity ?? null,
                status: response.status
            });
        }
    } catch (error) {
        console.warn("[VOICE] session_complete emit failed", {
            caseId,
            room,
            identity: identity ?? null,
            message: error instanceof Error ? error.message : "unknown"
        });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    cli.runApp(
        new WorkerOptions({
            agent: import.meta.filename,
            agentName: env.livekitAgentName
        })
    );
}
