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

        // Terra MetaString: ${ref} interpolation
        if (val.includes('${')) {
            const regex = /\${([^}]+)}/g;
            let match;
            let result = val;
            while ((match = regex.exec(val)) !== null) {
                const ref = match[1];
                const resolved = resolveMetaRef('$' + ref, pack, parentDoc, node);
                result = result.replace(match[0], String(resolved));
            }
            // If the whole thing was one interpolation and resulted in a number, return as number
            if (/^-?\d+(\.\d+)?$/.test(result)) return Number(result);
            return result;
        }

        // Terra MetaValue: $ref (entire scalar)
        if (val.startsWith('$')) {
            // Handle $file.yml:path.to.thing
            return resolveMetaRef(val, pack, parentDoc, node);
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
                // Terra MetaMap: "<<" (quoted) OR Standard YAML Merge: "<<" (unquoted key)
                if (keyStr === '<<') {
                    if (isSeq(value)) {
                        for (const item of value.items) {
                            Object.assign(result, resolveMetaMerge(item as Node, pack, parentDoc));
                        }
                    } else {
                        Object.assign(result, resolveMetaMerge(value as Node, pack, parentDoc));
                    }
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
            // Terra MetaList: - << ref
            if (isScalar(item) && String((item as Scalar).value).startsWith('<< ')) {
                const ref = String((item as Scalar).value).substring(3).trim();
                const resolved = resolveMetaRef('$' + ref, pack, parentDoc, item);
                if (Array.isArray(resolved)) {
                    result.push(...resolved);
                } else {
                    result.push(resolved);
                }
                continue;
            }

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
    // ref could be "$file.yml:path" or "file.yml:path" (if called from MetaString)
    let pathStr = ref.startsWith('$') ? ref.substring(1) : ref;

    if (pathStr.startsWith('{') && pathStr.endsWith('}')) {
        pathStr = pathStr.substring(1, pathStr.length - 1);
    }

    // Split into file and path. Terra uses : but occasionally . if it's a direct handle
    const parts = pathStr.split(':');
    let filePath: string;
    let pathInFile: string[];

    if (parts.length < 2) {
        // Just a filename? $options.yml (resolves whole file)
        filePath = pathStr;
        pathInFile = [];
    } else {
        filePath = parts[0];
        pathInFile = parts.slice(1).join(':').split('.');
    }

    if (!pack || !pack.registry) return ref;

    const normalizedSearch = filePath.replace(/\\/g, '/');
    const allDocs = pack.registry.getAllDocs();
    const exactMatches = allDocs.filter(d => d.filePath.replace(/\\/g, '/') === normalizedSearch);

    const suffixMatches = exactMatches.length
        ? exactMatches
        : allDocs.filter(d => {
            const dfp = d.filePath.replace(/\\/g, '/');
            return dfp.endsWith(normalizedSearch) ||
                dfp.endsWith('/' + normalizedSearch);
        });

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
        let next: Node | null | undefined;
        if (isMap(current)) {
            next = (current as any).get(part, true) as any;
        } else if (isSeq(current) && /^\d+$/.test(part)) {
            const index = parseInt(part, 10);
            next = (current as any).items[index];
        }

        if (next === undefined || next === null) {
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
        current = next;
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
