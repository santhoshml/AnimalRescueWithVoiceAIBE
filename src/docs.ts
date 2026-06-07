export async function lookupProtocol(question: string) {
    // Later: replace this with Unsiloed API call.
    if (question.toLowerCase().includes("injured")) {
        return "For injured animals: do not move them unless they are in immediate danger. Contact rescue staff or animal control.";
    }

    return "General protocol: collect location, condition, safety risk, and caller contact.";
}