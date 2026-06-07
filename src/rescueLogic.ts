export type RescueCase = {
    animal?: string;
    location?: string;
    injury?: string;
    aggression?: string;
    collar?: string;
    callerName?: string;
    callerPhone?: string;
    urgency?: "emergency" | "medium" | "low";
};

export function classifyUrgency(c: RescueCase) {
    const text = `${c.injury} ${c.aggression}`.toLowerCase();

    if (
        text.includes("bleeding") ||
        text.includes("hit by car") ||
        text.includes("unconscious") ||
        text.includes("trapped") ||
        text.includes("aggressive")
    ) {
        return "emergency";
    }

    if (text.includes("limping") || text.includes("scared")) {
        return "medium";
    }

    return "low";
}