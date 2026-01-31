export type Severity = 'error' | 'warning';

export enum FileCategory {
    BIOME = 'biome',
    FEATURE = 'feature',
    PALETTE = 'palette',
    FUNCTION = 'function',
    UNKNOWN = 'unknown'
}

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
    category?: FileCategory; // Auto-detected file category
}

export interface FileStats {
    total: number;
    passed: number;
    warned: number;
    failed: number;
}

export interface CategoryStats {
    total: number;
    passed: number;
    warned: number;
    failed: number;
}

export interface PackStats {
    files: Record<string, FileStats>; // Map of file path to its stats
    categories: Record<FileCategory, CategoryStats>;
}
