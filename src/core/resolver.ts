import { isMap, isScalar, isSeq, Node, YAMLMap, Scalar } from 'yaml';
import { Pack } from '../core/pack.js';
import { ParsedYaml } from '../parser/yaml.js';

export function resolveValue(node: Node | null | undefined, pack: Pack, parentDoc: ParsedYaml): any {
    if (!node) return undefined;

    if (isScalar(node)) {
        let val = String(node.value);

        // Handle numeric underscores (e.g., 1_000_000)
        if (/^\d[0-9_]*$/.test(val) && val.includes('_')) {
            val = val.replace(/_/g, '');
            if (!isNaN(Number(val))) return Number(val);
        }

        // Syntax: Absolute Value Pipes
        const pipeCount = (val.match(/\|/g) || []).length;
        if (pipeCount > 0 && pipeCount % 2 !== 0) {
            pack.diagnostics.push({
                code: 'MALFORMED_EXPRESSION',
                message: `Unbalanced absolute value pipes in expression: "${val}"`,
                severity: 'error',
                file: parentDoc.filePath,
                range: node.range ? {
                    start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                    end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
                } : undefined
            });
        }

        // Syntax: Block States
        // Only treat as block state if '[' appears before any '{'
        const firstBracket = val.indexOf('[');
        const firstBrace = val.indexOf('{');
        if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
            const closeIndex = val.lastIndexOf(']');
            let isValid = true;
            if (closeIndex === -1 || closeIndex < firstBracket || val.split('[').length !== 2 || val.split(']').length !== 2) {
                isValid = false;
            } else {
                const statesPart = val.substring(firstBracket + 1, closeIndex);
                if (statesPart.trim()) {
                    const pairs = statesPart.split(',');
                    for (const pair of pairs) {
                        const eqIndex = pair.indexOf('=');
                        if (eqIndex === -1 || eqIndex === 0 || eqIndex === pair.length - 1) {
                            isValid = false;
                            break;
                        }
                    }
                }
            }
            if (!isValid) {
                pack.diagnostics.push({
                    code: 'INVALID_BLOCK_STATE',
                    message: `Invalid block state syntax: "${val}". Expected "id[key=value, ...]"`,
                    severity: 'error',
                    file: parentDoc.filePath,
                    range: node.range ? {
                        start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                        end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
                    } : undefined
                });
            }
        }

        if (val.startsWith('$')) {
            // Handle $file.yml:path.to.thing
            return resolveMetaRef(val, pack, parentDoc, node);
        }
        if (val.startsWith('<<')) {
            const ref = val.substring(2).trim();
            return resolveMetaRef('$' + ref, pack, parentDoc, node);
        }

        // return the cleaned string or number
        return val === String(node.value) ? node.value : val;
    }

    if (isMap(node)) {
        const result: any = {};
        for (const pair of node.items) {
            const { key, value } = pair as any;
            if (isScalar(key)) {
                const keyStr = String(key.value);
                if (keyStr === '<<') {
                    // Handle meta merge
                    const merged = resolveMetaMerge(value as Node, pack, parentDoc);
                    Object.assign(result, merged);
                } else {
                    result[keyStr] = resolveValue(value as Node, pack, parentDoc);
                }
            }
        }
        return result;
    }

    if (isSeq(node)) {
        const result: any[] = [];
        for (const item of node.items) {
            const resolved = resolveValue(item as Node, pack, parentDoc);
            if (Array.isArray(resolved)) {
                result.push(...resolved);
            } else {
                result.push(resolved);
            }
        }
        return result;
    }

    return undefined;
}

function resolveMetaRef(ref: string, pack: Pack, parentDoc: ParsedYaml, node?: any): any {
    // Handle $file.yml:path.to.thing or $file.yml:top-level-key
    let pathStr = ref.substring(1);
    if (pathStr.startsWith('{') && pathStr.endsWith('}')) {
        pathStr = pathStr.substring(1, pathStr.length - 1);
    } else if (pathStr.includes('{')) {
        // Handle cases like ${file:path} or ${file:path} - 1
        const match = pathStr.match(/{([^}]+)}/);
        if (match) {
            pathStr = match[1];
        }
    }

    const parts = pathStr.split(':');
    if (parts.length < 2) return ref;

    const filePath = parts[0];
    // Path can be separated by : or . in some Terra versions, or just one segment
    const pathInFile = parts.slice(1).join(':').split('.');

    if (!pack || !pack.registry) {
        return ref;
    }

    const allDocs = pack.registry.getAllDocs();
    const exactMatches = allDocs.filter(d => d.filePath === filePath);

    const suffixMatches = exactMatches.length
        ? exactMatches
        : allDocs.filter(d =>
            d.filePath.endsWith(filePath) ||
            d.filePath.endsWith('/' + filePath) ||
            d.filePath.endsWith('\\' + filePath)
        );

    if (suffixMatches.length === 0) {
        pack.diagnostics.push({
            code: 'META_REF_FILE_MISSING',
            message: `Meta reference file "${filePath}" not found in pack.`,
            severity: 'error',
            file: parentDoc.filePath,
            range: node?.range ? {
                start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
            } : undefined
        });
        return ref;
    }

    if (suffixMatches.length > 1) {
        pack.diagnostics.push({
            code: 'META_REF_AMBIGUOUS',
            message: `Meta reference "${filePath}" matched multiple files: ${suffixMatches.map(d => d.filePath).join(', ')}. Use a more specific path.`,
            severity: 'error',
            file: parentDoc.filePath,
            range: node?.range ? {
                start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
            } : undefined
        });
        return ref;
    }

    const doc = suffixMatches[0];

    let current: Node | null | undefined = doc.doc.contents as any;
    for (const part of pathInFile) {
        if (isMap(current)) {
            current = current.get(part, true) as any;
        } else if (isSeq(current) && /^\d+$/.test(part)) {
            const index = parseInt(part, 10);
            current = (current as any).items[index];
        } else {
            pack.diagnostics.push({
                code: 'META_REF_PATH_MISSING',
                message: `Path "${pathInFile.join('.')}" not found in meta file "${filePath}". Missing: "${part}"`,
                severity: 'error',
                file: parentDoc.filePath,
                range: node?.range ? {
                    start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                    end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
                } : undefined
            });
            return ref;
        }
    }

    return resolveValue(current, pack, doc);
}

function resolveMetaMerge(node: Node, pack: Pack, parentDoc: ParsedYaml): any {
    if (isScalar(node)) {
        const val = resolveValue(node, pack, parentDoc);
        return typeof val === 'object' ? val : {};
    }
    if (isSeq(node)) {
        let result = {};
        for (const item of node.items) {
            Object.assign(result, resolveMetaMerge(item as Node, pack, parentDoc));
        }
        return result;
    }
    return resolveValue(node, pack, parentDoc);
}
