import type { RescueCenter } from "../types/case.js";

const CENTERS: RescueCenter[] = [
    {
        id: "ca-sf-001",
        name: "San Francisco Wildlife Care Alliance",
        city: "San Francisco",
        state: "CA",
        zip: "94110",
        phone: "+1-415-555-0101",
        website: "https://example.org/sf-wildlife"
    },
    {
        id: "ca-sj-001",
        name: "South Bay Wildlife Rescue",
        city: "San Jose",
        state: "CA",
        zip: "95112",
        phone: "+1-408-555-0199"
    },
    {
        id: "ca-sac-001",
        name: "Sacramento Animal Response Center",
        city: "Sacramento",
        state: "CA",
        zip: "95814",
        phone: "+1-916-555-0182"
    },
    {
        id: "wa-sea-001",
        name: "Seattle Urban Wildlife Hotline",
        city: "Seattle",
        state: "WA",
        zip: "98104",
        phone: "+1-206-555-0110"
    },
    {
        id: "ny-nyc-001",
        name: "NYC Wildlife Rehabilitation Network",
        city: "New York",
        state: "NY",
        zip: "10013",
        phone: "+1-212-555-0151"
    }
];

export function findRescueCenters(params: { city?: string; zip?: string }): RescueCenter[] {
    const city = params.city?.trim().toLowerCase();
    const zip = params.zip?.trim();

    if (zip) {
        const exactZip = CENTERS.filter((c) => c.zip === zip);
        if (exactZip.length > 0) {
            return exactZip;
        }

        const prefix = zip.slice(0, 3);
        const byPrefix = CENTERS.filter((c) => c.zip.startsWith(prefix));
        if (byPrefix.length > 0) {
            return byPrefix;
        }
    }

    if (city) {
        const byCity = CENTERS.filter((c) => c.city.toLowerCase() === city);
        if (byCity.length > 0) {
            return byCity;
        }
    }

    return CENTERS.slice(0, 3);
}

