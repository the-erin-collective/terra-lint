
export interface Origin {
    file: string;
    range?: { start: number; end: number };
    fullRange?: {
        start: { line: number; col: number; offset: number };
        end: { line: number; col: number; offset: number };
    };
    via?: "direct" | "meta" | "extends";
}

export type PScalar = { kind: "scalar"; value: string | number | boolean | null; origin: Origin };
export type PSeq = { kind: "seq"; items: PValue[]; origin: Origin };
export type PMap = { kind: "map"; entries: Map<string, PValue>; origin: Origin };

export type PValue = PScalar | PSeq | PMap;

export function isPScalar(v: PValue): v is PScalar { return v.kind === "scalar"; }
export function isPSeq(v: PValue): v is PSeq { return v.kind === "seq"; }
export function isPMap(v: PValue): v is PMap { return v.kind === "map"; }

export function toJS(v: PValue): any {
    switch (v.kind) {
        case "scalar":
            return v.value;
        case "seq":
            return v.items.map(toJS);
        case "map": {
            const obj: any = {};
            for (const [k, pv] of v.entries) {
                obj[k] = toJS(pv);
            }
            return obj;
        }
    }
}

// Helpers to create PValues
export function createPScalar(value: any, origin: Origin): PScalar {
    return { kind: 'scalar', value, origin };
}

export function createPSeq(items: PValue[], origin: Origin): PSeq {
    return { kind: 'seq', items, origin };
}

export function createPMap(entries: Map<string, PValue>, origin: Origin): PMap {
    return { kind: 'map', entries, origin };
}
