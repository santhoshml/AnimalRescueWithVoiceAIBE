export type UrgencyLevel = "emergency" | "medium" | "low";

export type CaseStatus =
    | "open"
    | "triaged"
    | "guidance_provided"
    | "rescue_onway"
    | "rescue_complete"
    | "closed";

export type UploadedFile = {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    localPath: string;
    url?: string;
    uploadedAt: string;
    summary?: string | null;
    speciesGuess?: string | null;
    speciesConfidence?: number | null;
    isLikelyEndangered?: boolean | null;
    endangeredConfidence?: number | null;
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
    confidence?: number | null;
    urgency?: UrgencyLevel;
    recommendedAction?: string;
    sourceDocuments: SourceDocument[];
    rescueCenters: RescueCenter[];
};

export type CaseRecord = {
    id: string;
    publicReferenceId?: string;
    roomName: string;
    status: CaseStatus;
    createdAt: string;
    updatedAt: string;

    callerName?: string;
    callerPhone?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
    locationSource?: "telephony" | "number_lookup" | "ip" | "manual" | string | null;
    locationConfidence?: number | null;
    locationUpdatedAt?: string | null;

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
