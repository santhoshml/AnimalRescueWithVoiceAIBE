export type KbDocumentStatus = "ready" | "processing" | "failed";

export type KbDocumentType =
    | "volunteer_directory"
    | "emergency_protocol"
    | "intake_rules"
    | "vet_partners"
    | "general"
    | string;

export type KbParserMetadata = {
    pages?: number;
    chunkCount?: number;
    embeddingStatus: "processing" | "ready" | "failed";
    parseError: string | null;
    errorCode: string | null;
    upstreamStatus: number | null;
    retryCount: number;
    lastTriedAt: string | null;
    service?: string | null;
    errorType?: string | null;
    responseSnippet?: string | null;
    requestId?: string | null;
};

export type KbDocument = {
    id: string;
    title: string;
    sourceFileName?: string;
    type: KbDocumentType;
    url: string;
    tags?: string[];
    status: KbDocumentStatus;
    uploadedAt: string;
    parser: KbParserMetadata;
};
