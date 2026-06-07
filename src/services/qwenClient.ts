import { readFile } from "node:fs/promises";
import { env } from "../config/env.js";

type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

type SpeciesResult = {
    species: string;
    confidence: number;
};

export type VisionAssessment = {
    summary: string;
    speciesGuess: string | null;
    speciesConfidence: number | null;
    isLikelyEndangered: boolean | null;
    endangeredConfidence: number | null;
};

type VisionAssessmentRaw = {
    summary?: unknown;
    speciesGuess?: unknown;
    speciesConfidence?: unknown;
    isLikelyEndangered?: unknown;
    endangeredConfidence?: unknown;
};

function parseJsonObject<T>(content: string): T | null {
    const trimmed = content.trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = (fenceMatch?.[1] ?? trimmed).trim();
    try {
        return JSON.parse(candidate) as T;
    } catch {
        return null;
    }
}

function normalize01(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }
    return Math.max(0, Math.min(1, value));
}

export class QwenClient {
    private get isConfigured(): boolean {
        return Boolean(
            env.qwenApiKey &&
                !env.qwenApiKey.includes("your_qwen_key") &&
                env.qwenApiKey.trim().length > 0
        );
    }

    async chat(messages: ChatMessage[]): Promise<string> {
        if (!this.isConfigured) {
            return "Move slowly, keep distance from the animal, and contact a local licensed animal rescue center.";
        }

        console.log("[QWEN] chat request", {
            model: env.qwenChatModel,
            messages
        });

        const response = await fetch(`${env.qwenBaseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.qwenApiKey}`
            },
            body: JSON.stringify({
                model: env.qwenChatModel,
                messages,
                temperature: 0.2
            })
        });

        if (!response.ok) {
            throw new Error(`Qwen chat failed: ${response.status}`);
        }

        const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content?.trim() ?? "";
        console.log("[QWEN] chat response", {
            model: env.qwenChatModel,
            content
        });
        return content;
    }

    async identifySpeciesFromImage(localPath: string): Promise<SpeciesResult> {
        if (!this.isConfigured) {
            return { species: "Unknown animal", confidence: 0.35 };
        }

        const bytes = await readFile(localPath);
        const dataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;

        const response = await fetch(`${env.qwenBaseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.qwenApiKey}`
            },
            body: JSON.stringify({
                model: env.qwenVisionModel,
                temperature: 0.1,
                response_format: { type: "json_object" },
                messages: [
                    {
                        role: "system",
                        content:
                            "Identify the likely animal from the image. Return JSON with keys: species (string), confidence (0-1 number)."
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Identify this animal." },
                            { type: "image_url", image_url: { url: dataUrl } }
                        ]
                    }
                ]
            })
        });

        if (!response.ok) {
            throw new Error(`Qwen vision failed: ${response.status}`);
        }

        const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
            return { species: "Unknown animal", confidence: 0.3 };
        }

        const parsed = JSON.parse(content) as Partial<SpeciesResult>;
        return {
            species: parsed.species ?? "Unknown animal",
            confidence: Number(parsed.confidence ?? 0.3)
        };
    }

    async summarizeImage(localPath: string): Promise<string> {
        const analysis = await this.analyzeImage(localPath);
        return analysis?.summary ?? "";
    }

    async analyzeImage(localPath: string): Promise<VisionAssessment | null> {
        if (!this.isConfigured) {
            return null;
        }

        const bytes = await readFile(localPath);
        const dataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;

        const response = await fetch(`${env.qwenBaseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.qwenApiKey}`
            },
            body: JSON.stringify({
                model: env.qwenVisionModel,
                temperature: 0.1,
                response_format: { type: "json_object" },
                messages: [
                    {
                        role: "system",
                        content:
                            "You are an animal rescue vision assistant. Return strict JSON with keys: summary (string, 1-2 concise sentences), speciesGuess (string|null), speciesConfidence (number 0..1|null), isLikelyEndangered (boolean|null), endangeredConfidence (number 0..1|null). Use null for unknown values."
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "Analyze this rescue image and return the JSON object only."
                            },
                            { type: "image_url", image_url: { url: dataUrl } }
                        ]
                    }
                ]
            })
        });

        if (!response.ok) {
            throw new Error(`Qwen image summary failed: ${response.status}`);
        }

        const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content?.trim() ?? "";
        if (content.length === 0) {
            return null;
        }
        const parsed = parseJsonObject<VisionAssessmentRaw>(content);
        if (!parsed) {
            return {
                summary: content,
                speciesGuess: null,
                speciesConfidence: null,
                isLikelyEndangered: null,
                endangeredConfidence: null
            };
        }

        return {
            summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
            speciesGuess:
                typeof parsed.speciesGuess === "string" && parsed.speciesGuess.trim().length > 0
                    ? parsed.speciesGuess.trim()
                    : null,
            speciesConfidence: normalize01(parsed.speciesConfidence),
            isLikelyEndangered:
                typeof parsed.isLikelyEndangered === "boolean" ? parsed.isLikelyEndangered : null,
            endangeredConfidence: normalize01(parsed.endangeredConfidence)
        };
    }
}
