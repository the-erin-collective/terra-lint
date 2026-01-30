import { parseDocument, isScalar, isAlias, isMap, isSeq, LineCounter, Document, Node } from 'yaml';
import { Diagnostic, Location, Range } from '../types/diagnostic.js';

export interface ProvenanceEntry {
    file: string;
    range: Range;
    sourceKind?: 'root' | 'include';
}

export type ProvenanceMap = Map<string, ProvenanceEntry>; // Key is JSON pointer (e.g., "/stages/0")

export interface ParsedYaml {
    doc: Document;
    text: string;
    lineCounter: LineCounter;
    filePath: string;
    /** Indicates whether this document came from the main pack root or an include path */
    sourceKind?: 'root' | 'include';
}

export function setProvenance(map: ProvenanceMap, path: string | string[], entry: ProvenanceEntry) {
    const pointer = Array.isArray(path)
        ? '/' + path.map(p => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
        : path;
    map.set(pointer, entry);
}

export function getProvenance(map: ProvenanceMap, path: string | string[]): ProvenanceEntry | undefined {
    const pointer = Array.isArray(path)
        ? '/' + path.map(p => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
        : path;
    return map.get(pointer);
}

export function stripBom(s: string): string {
    return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

export function parseYaml(text: string, filePath: string, sourceKind?: 'root' | 'include'): { parsed?: ParsedYaml, diagnostics: Diagnostic[] } {
    const lineCounter = new LineCounter();
    const diagnostics: Diagnostic[] = [];

    try {
        const doc = parseDocument(text, { lineCounter, keepSourceTokens: true });

        for (const error of doc.errors) {
            const pos = error.pos[0] ?? 0;
            const end = error.pos[1] ?? pos;

            const startLoc = lineCounter.linePos(pos);
            const endLoc = lineCounter.linePos(end);

            diagnostics.push({
                code: 'YAML_SYNTAX_ERROR',
                message: error.message,
                severity: 'error',
                file: filePath,
                range: {
                    start: { line: startLoc.line, col: startLoc.col, offset: pos },
                    end: { line: endLoc.line, col: endLoc.col, offset: end }
                }
            });
        }

        if (doc.errors.length > 0) {
            return { diagnostics };
        }

        return {
            parsed: {
                doc,
                text,
                lineCounter,
                filePath,
                sourceKind
            },
            diagnostics
        };

    } catch (e: any) {
        diagnostics.push({
            code: 'YAML_PARSE_EXCEPTION',
            message: e.message,
            severity: 'error',
            file: filePath
        });
        return { diagnostics };
    }
}

export function getNodeRange(node: Node | null | undefined, lineCounter: LineCounter): Range | undefined {
    if (!node || !node.range) return undefined;

    const start = lineCounter.linePos(node.range[0]);
    const end = lineCounter.linePos(node.range[1]);

    return {
        start: { line: start.line, col: start.col, offset: node.range[0] },
        end: { line: end.line, col: end.col, offset: node.range[1] }
    };
}
