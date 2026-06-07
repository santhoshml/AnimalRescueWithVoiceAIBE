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
        if (!this.isConfigured) {
            return "";
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
                messages: [
                    {
                        role: "system",
                        content:
                            "You are an animal rescue assistant. Summarize the image in 1-2 concise sentences, focusing on visible animal condition and immediate safety signals."
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Provide a concise image summary." },
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
        return data.choices?.[0]?.message?.content?.trim() ?? "";
    }
}
