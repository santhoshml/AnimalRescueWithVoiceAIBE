import { classifyUrgency } from "../rescueLogic.js";
import type { AnalyzeCaseResult, CaseRecord } from "../types/case.js";
import type { KbDocument } from "../types/kb.js";
import { QwenClient } from "./qwenClient.js";
import { findRescueCenters } from "./resourceService.js";
import { UnsiloedClient } from "./unsiloedClient.js";

export class CaseOrchestrator {
    constructor(
        private readonly qwen: QwenClient,
        private readonly unsiloed: UnsiloedClient
    ) {}

    async analyze(
        caseRecord: CaseRecord,
        kbDocuments: KbDocument[],
        caseImageExtracts: string[] = []
    ): Promise<AnalyzeCaseResult> {
        const latestImage = caseRecord.images[caseRecord.images.length - 1];
        let species = caseRecord.context.species ?? "Unknown animal";
        let confidence = caseRecord.context.confidence ?? 0;

        if (latestImage) {
            try {
                const speciesResult = await this.qwen.identifySpeciesFromImage(
                    latestImage.localPath
                );
                species = speciesResult.species;
                confidence = speciesResult.confidence;
            } catch {
                // Keep previous values if model call fails.
            }
        }

        const urgency = classifyUrgency({
            injury: caseRecord.injury,
            aggression: caseRecord.aggression
        });

        const retrievalQuery = [
            `species: ${species}`,
            `injury: ${caseRecord.injury ?? "unknown"}`,
            `aggression: ${caseRecord.aggression ?? "unknown"}`,
            `location: ${caseRecord.location ?? caseRecord.city ?? caseRecord.zip ?? "unknown"}`
        ].join("\n");

        let sourceDocuments = caseRecord.context.sourceDocuments;
        try {
            sourceDocuments = await this.unsiloed.retrieveFromGlobalKb(
                retrievalQuery,
                kbDocuments
            );
        } catch {
            // Use existing source documents if Unsiloed is down.
        }

        const rescueCenters = findRescueCenters({
            city: caseRecord.city,
            zip: caseRecord.zip
        });

        const retrievalContext = sourceDocuments
            .slice(0, 5)
            .map((doc, index) => {
                const excerpt = doc.excerpt?.trim().slice(0, 600) ?? "";
                return `[Doc ${index + 1}] title=${doc.title}\nexcerpt=${excerpt}`;
            })
            .join("\n\n");
        const imageContext = caseImageExtracts
            .slice(0, 5)
            .map((text, index) => `[Image ${index + 1}] ${text.trim().slice(0, 700)}`)
            .join("\n\n");

        const guidancePrompt = [
            "You are an animal rescue copilot.",
            "Return concise step-by-step rescue guidance for first responders.",
            `Species: ${species}`,
            `Urgency: ${urgency}`,
            `Injury: ${caseRecord.injury ?? "unknown"}`,
            `Aggression: ${caseRecord.aggression ?? "unknown"}`,
            `Location: ${caseRecord.location ?? caseRecord.city ?? caseRecord.zip ?? "unknown"}`,
            `Caller context: ${caseRecord.transcript.join(" ")}`,
            "Retrieved KB context:",
            retrievalContext.length > 0 ? retrievalContext : "No retrieved KB context.",
            "Retrieved image context:",
            imageContext.length > 0 ? imageContext : "No retrieved image context."
        ].join("\n");

        console.log("[QWEN] linkage", {
            caseId: caseRecord.id,
            room: caseRecord.roomName,
            hasCallerContext: caseRecord.transcript.join(" ").trim().length > 0,
            hasAnimal: Boolean(caseRecord.animal && caseRecord.animal.trim().length > 0),
            hasInjury: Boolean(caseRecord.injury && caseRecord.injury.trim().length > 0),
            hasAggression: Boolean(caseRecord.aggression && caseRecord.aggression.trim().length > 0),
            imageContextCount: caseImageExtracts.length,
            writeTargetCaseId: caseRecord.id
        });

        let guidanceText = "";
        try {
            guidanceText = await this.qwen.chat([
                {
                    role: "system",
                    content:
                        "You generate safe animal emergency actions. Be practical and cautious."
                },
                { role: "user", content: guidancePrompt }
            ]);
        } catch {
            guidanceText =
                "1) Keep a safe distance.\n2) Minimize noise and avoid direct handling.\n3) Contact a licensed animal rescue center immediately.";
        }

        const guidanceSteps = guidanceText
            .split(/\n+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .slice(0, 6);

        const recommendedAction =
            guidanceSteps[0] ??
            "Maintain distance and contact a licensed animal rescue center.";

        return {
            urgency,
            guidanceSteps,
            context: {
                species,
                confidence,
                urgency,
                recommendedAction,
                sourceDocuments,
                rescueCenters
            }
        };
    }
}
