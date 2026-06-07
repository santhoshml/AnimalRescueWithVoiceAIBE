import type { Response } from "express";

type Client = {
    id: string;
    res: Response;
};

export class CaseEventBus {
    private readonly clientsByCase = new Map<string, Client[]>();

    subscribe(caseId: string, res: Response): () => void {
        const client: Client = { id: crypto.randomUUID(), res };
        const list = this.clientsByCase.get(caseId) ?? [];
        list.push(client);
        this.clientsByCase.set(caseId, list);

        return () => {
            const current = this.clientsByCase.get(caseId) ?? [];
            const next = current.filter((c) => c.id !== client.id);
            if (next.length === 0) {
                this.clientsByCase.delete(caseId);
                return;
            }
            this.clientsByCase.set(caseId, next);
        };
    }

    publish(caseId: string, event: string, payload: unknown) {
        const clients = this.clientsByCase.get(caseId) ?? [];
        if (clients.length === 0) {
            return;
        }

        const body = JSON.stringify(payload);
        for (const client of clients) {
            client.res.write(`event: ${event}\n`);
            client.res.write(`data: ${body}\n\n`);
        }
    }
}

