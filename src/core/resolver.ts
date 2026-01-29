import { isMap, isScalar, isSeq, Node, Scalar } from 'yaml';
import path from 'path';
import { Pack } from '../core/pack.js';
import { ParsedYaml } from '../parser/yaml.js';

export interface ResolvedResult {
    value: any;
    origin: ParsedYaml;
    range?: any;
    interpolated?: boolean;
}

export function resolveValue(
    node: Node | null | undefined,
    pack: Pack,
    parentDoc: ParsedYaml,
    fieldPath: string[] = []
): ResolvedResult {
    if (!node) return { value: undefined, origin: parentDoc };

    const pathStr = fieldPath.join('.');
    const isExpressionField = (
        pathStr.endsWith('.palette') ||
        pathStr.includes('.slant') ||
        pathStr.includes('.features.') ||
        ['BEDROCK', 'threshold', 'multiplier', 'base_y'].includes(fieldPath[fieldPath.length - 1])
    );

    if (isScalar(node)) {
        let val = String(node.value);
        let interpolated = false;

        // Terra MetaString: ${ref} interpolation
        if (val.includes('${')) {
            const regex = /\${([^}]+)}/g;
            let match;
            let result = val;
            while ((match = regex.exec(val)) !== null) {
                const ref = match[1];
                const resolved = resolveMetaRef('$' + ref, pack, parentDoc, node);
                result = result.replace(match[0], String(resolved.value));
            }
            interpolated = true;
            val = result.replace(/\r?\n/g, ' ').trim(); // Handle multi-line expressions

            if (/^-?\d+(\.\d+)?$/.test(val)) {
                return { value: Number(val), origin: parentDoc, range: node.range, interpolated: true };
            }
        }

        // Terra MetaValue: $ref (entire scalar)
        if (val.startsWith('$')) {
            return resolveMetaRef(val, pack, parentDoc, node);
        }

        // Handle numeric underscores (e.g., 1_000_000)
        if (/^\d[0-9_]*$/.test(val) && val.includes('_')) {
            val = val.replace(/_/g, '');
            if (!isNaN(Number(val))) return { value: Number(val), origin: parentDoc, range: node.range, interpolated };
        }

        // Field-Aware Validation
        if (isExpressionField || interpolated) {
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
        }

        const finalValue = val === String(node.value) ? node.value : val;
        return { value: finalValue, origin: parentDoc, range: node.range, interpolated };
    }

    if (isMap(node)) {
        const result: any = {};
        const metadata = new Map<string, { origin: ParsedYaml, range: any }>();
        Object.defineProperty(result, '__terra_origin', { value: parentDoc, enumerable: false });
        Object.defineProperty(result, '__terra_range', { value: node.range, enumerable: false });
        Object.defineProperty(result, '__terra_metadata', { value: metadata, enumerable: false });

        for (const pair of node.items) {
            const { key, value } = pair as any;
            if (isScalar(key)) {
                const keyStr = String(key.value);
                if (keyStr === '<<') {
                    const merged = isSeq(value)
                        ? (value.items as Node[]).map(item => resolveMetaMerge(item, pack, parentDoc))
                        : [resolveMetaMerge(value as Node, pack, parentDoc)];

                    for (const m of merged) {
                        if (m && typeof m === 'object') {
                            Object.assign(result, m);
                            const mMeta = (m as any).__terra_metadata;
                            if (mMeta instanceof Map) {
                                for (const [mk, mv] of mMeta.entries()) metadata.set(mk, mv);
                            }
                        }
                    }
                } else {
                    const resolved = resolveValue(value as Node, pack, parentDoc, [...fieldPath, keyStr]);
                    result[keyStr] = resolved.value;
                    metadata.set(keyStr, { origin: resolved.origin, range: resolved.range });
                }
            }
        }
        return { value: result, origin: parentDoc, range: node.range };
    }

    if (isSeq(node)) {
        const result: any[] = [];
        Object.defineProperty(result, '__terra_origin', { value: parentDoc, enumerable: false });
        Object.defineProperty(result, '__terra_range', { value: node.range, enumerable: false });
        // Sequences don't typically have field-level metadata in the same way, but we track origin for the list items
        for (const item of node.items) {
            // List-Merge Compatibility
            if (isMap(item) && (pathStr.includes('palette') || pathStr.includes('features'))) {
                const mapItems = (item as any).items;
                if (mapItems.length === 1 && isScalar(mapItems[0].key) && (mapItems[0].key.value === '<<' || mapItems[0].key.value === '<<:')) {
                    const merged = resolveMetaMerge(mapItems[0].value as Node, pack, parentDoc);
                    if (Array.isArray(merged)) result.push(...merged);
                    else if (typeof merged === 'object') result.push(merged);
                    continue;
                }
            }

            // MetaList: - << ref
            if (isScalar(item) && String((item as Scalar).value).startsWith('<< ')) {
                const refPart = String((item as Scalar).value).substring(3).trim();
                const resolved = resolveMetaRef('$' + refPart, pack, parentDoc, item);
                if (Array.isArray(resolved.value)) result.push(...resolved.value);
                else result.push(resolved.value);
                continue;
            }

            const resolved = resolveValue(item as Node, pack, parentDoc, [...fieldPath, '[]']);
            result.push(resolved.value);
        }
        return { value: result, origin: parentDoc, range: node.range };
    }

    return { value: undefined, origin: parentDoc };
}

export function resolveMetaRef(ref: string, pack: Pack, parentDoc: ParsedYaml, node?: any): ResolvedResult {
    let pathStr = ref.startsWith('$') ? ref.substring(1) : ref;
    if (pathStr.startsWith('{') && pathStr.endsWith('}')) pathStr = pathStr.substring(1, pathStr.length - 1);

    const parts = pathStr.split(':');
    let filePath: string;
    let pathInFile: string[];

    if (parts.length < 2) {
        filePath = pathStr;
        pathInFile = [];
    } else {
        filePath = parts[0];
        pathInFile = parts.slice(1).join(':').split('.');
    }

    if (!pack || !pack.registry) return { value: ref, origin: parentDoc };

    const normalizedSearch = filePath.replace(/\\/g, '/');
    const allDocs = pack.registry.getAllDocs();

    const precedenceLevels: ParsedYaml[][] = [];
    const roots = [pack.rootPath, ...pack.includePaths];

    for (const r of roots) {
        const rootAbs = path.resolve(r).toLowerCase().replace(/\\/g, '/');
        precedenceLevels.push(allDocs.filter(d => {
            const dfp = path.resolve(d.filePath).toLowerCase().replace(/\\/g, '/');
            return dfp.startsWith(rootAbs);
        }));
    }

    let results: ParsedYaml[] = [];
    for (let i = 0; i < precedenceLevels.length; i++) {
        const docsAtLevel = precedenceLevels[i];
        const rootAbs = path.resolve(roots[i]).toLowerCase().replace(/\\/g, '/');

        // Exact match against relative path from root
        const exact = docsAtLevel.filter(d => {
            const dfp = path.resolve(d.filePath).toLowerCase().replace(/\\/g, '/');
            const relative = dfp.substring(rootAbs.length).replace(/^\//, '');
            return relative === normalizedSearch.toLowerCase();
        });
        if (exact.length > 0) {
            results = exact;
            break;
        }

        // Suffix match (fallback)
        const suffix = docsAtLevel.filter(d => {
            const dfp = d.filePath.replace(/\\/g, '/').toLowerCase();
            return dfp.endsWith(normalizedSearch.toLowerCase()) || dfp.endsWith('/' + normalizedSearch.toLowerCase());
        });
        if (suffix.length > 0) {
            results = suffix;
            break;
        }
    }

    if (results.length === 0) {
        pack.diagnostics.push({
            code: 'META_REF_FILE_MISSING',
            message: `Meta file "${filePath}" not found in pack root or includes.`,
            severity: 'error',
            file: parentDoc.filePath,
            range: node?.range ? {
                start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
            } : undefined
        });
        return { value: ref, origin: parentDoc };
    }

    if (results.length > 1) {
        pack.diagnostics.push({
            code: 'META_REF_AMBIGUOUS',
            message: `Ambiguous meta-reference "${filePath}". Matches multiple files: ${results.map(d => d.filePath).join(', ')}`,
            severity: 'error',
            file: parentDoc.filePath,
            range: node?.range ? {
                start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
            } : undefined
        });
        return { value: ref, origin: parentDoc };
    }

    const doc = results[0];
    let current: Node | null | undefined = doc.doc.contents as any;
    for (const part of pathInFile) {
        let next: Node | null | undefined;
        if (isMap(current)) next = (current as any).get(part, true) as any;
        else if (isSeq(current) && /^\d+$/.test(part)) next = (current as any).items[parseInt(part, 10)];

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
            return { value: ref, origin: parentDoc };
        }
        current = next;
    }

    return resolveValue(current, pack, doc);
}

function resolveMetaMerge(node: Node, pack: Pack, parentDoc: ParsedYaml): any {
    if (isScalar(node)) {
        const res = resolveValue(node, pack, parentDoc);
        return (res.value && typeof res.value === 'object') ? res.value : {};
    }
    if (isSeq(node)) {
        let result = {};
        for (const item of node.items) Object.assign(result, resolveMetaMerge(item as Node, pack, parentDoc));
        return result;
    }
    return resolveValue(node, pack, parentDoc).value;
}
