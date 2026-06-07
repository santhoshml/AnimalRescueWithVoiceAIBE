export type UrgencyLevel = "emergency" | "medium" | "low";

export type CaseStatus = "open" | "triaged" | "guidance_provided" | "closed";

export type UploadedFile = {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    localPath: string;
    uploadedAt: string;
    summary?: string;
};

export type RescueCenter = {
    id: string;
    name: string;
    city: string;
    state: string;
    zip: string;
    phone: string;
    website?: string;
};

export type SourceDocument = {
    documentId: string;
    title: string;
    excerpt: string;
    url?: string;
};

export type ContextPanel = {
    species?: string;
    confidence?: number;
    urgency?: UrgencyLevel;
    recommendedAction?: string;
    sourceDocuments: SourceDocument[];
    rescueCenters: RescueCenter[];
};

export type CaseRecord = {
    id: string;
    roomName: string;
    status: CaseStatus;
    createdAt: string;
    updatedAt: string;

    callerName?: string;
    callerPhone?: string;
    city?: string;
    zip?: string;

    animal?: string;
    location?: string;
    injury?: string;
    aggression?: string;
    collar?: string;
    urgency?: UrgencyLevel;

    transcript: string[];
    images: UploadedFile[];
    protocols: UploadedFile[];

    guidanceSteps: string[];
    analysisWarnings?: string[];
    context: ContextPanel;
};

export type AnalyzeCaseResult = {
    urgency: UrgencyLevel;
    guidanceSteps: string[];
    context: ContextPanel;
};
