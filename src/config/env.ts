import "dotenv/config";

function getRequired(name: string): string {
    const value = process.env[name];
    if (!value || value.trim().length === 0) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export const env = {
    port: Number(process.env.PORT ?? 3001),

    livekitUrl: getRequired("LIVEKIT_URL"),
    livekitApiKey: getRequired("LIVEKIT_API_KEY"),
    livekitApiSecret: getRequired("LIVEKIT_API_SECRET"),
    livekitAgentName: process.env.LIVEKIT_AGENT_NAME ?? "animal-rescue-dispatcher",

    awsRegion: process.env.AWS_REGION,
    dynamodbTable: process.env.DYNAMODB_TABLE,

    mossProjectId: process.env.MOSS_PROJECT_ID,
    mossProjectKey: process.env.MOSS_PROJECT_KEY,
    mossIndexName: process.env.MOSS_INDEX_NAME ?? "wildlife-cases",
    mossKbIndexName: process.env.MOSS_KB_INDEX_NAME ?? "wildlife-kb",

    qwenApiKey: process.env.QWEN_API_KEY,
    qwenBaseUrl:
        process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    qwenChatModel: process.env.QWEN_CHAT_MODEL ?? "qwen-plus",
    qwenVisionModel: process.env.QWEN_VISION_MODEL ?? "qwen-vl-max",

    unsiloedApiKey: process.env.UNSILOED_API_KEY,
    unsiloedBaseUrl: process.env.UNSILOED_BASE_URL ?? "https://api.unsiloed.ai"
};
