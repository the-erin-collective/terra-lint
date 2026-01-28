export type Severity = 'error' | 'warning';

export interface Location {
    line: number;
    col: number;
    offset: number;
}

export interface Range {
    start: Location;
    end: Location;
}

export interface Diagnostic {
    code: string;
    message: string;
    severity: Severity;
    file: string;
    range?: Range;
    path?: string[]; // Path within the config object (e.g. ['biomes', 'my_biome', 'type'])
}
