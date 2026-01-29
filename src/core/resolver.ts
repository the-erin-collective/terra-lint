import { isMap, isScalar, isSeq, Node, Scalar } from 'yaml';
import path from 'path';
import { Pack } from '../core/pack.js';
import { ParsedYaml, ProvenanceMap, ProvenanceEntry, setProvenance } from '../parser/yaml.js';
import { validateBlockState, validateExpression } from './validation-utils.js';

export interface ResolvedResult {
    value: any;
    // origin field is kept for backward compatibility but provenance map is primary
    origin: ParsedYaml;
    range?: any;
    interpolated?: boolean;
    provenance?: ProvenanceMap;
}

export function resolveValue(
    node: Node | null | undefined,
    pack: Pack,
    parentDoc: ParsedYaml,
    fieldPath: string[] = []
): ResolvedResult {
    if (!node) return { value: undefined, origin: parentDoc };

    const pathStr = fieldPath.join('.');
    const lastField = fieldPath[fieldPath.length - 1];

    // Initialize sidecar provenance map
    const provenance: ProvenanceMap = new Map();

    // Field-aware gating: only validate expressions in known expression contexts
    const isExpressionField = pack.isExpressionField(pathStr, lastField);

    // Field-aware gating: only validate block states in known block contexts
    const isBlockField = pack.isBlockField(pathStr, lastField);

    if (isScalar(node)) {
        let val = String(node.value);
        let interpolated = false;

        // Current node's provenance
        const selfProvenance: ProvenanceEntry = {
            file: parentDoc.filePath,
            range: node.range ? {
                start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
            } : undefined as any,
            sourceKind: parentDoc.sourceKind
        };

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
                return {
                    value: Number(val),
                    origin: parentDoc,
                    range: node.range,
                    interpolated: true,
                    provenance // Scalars don't usually need a map unless we track sub-parts, but we return it for consistency
                };
            }
        }

        // Terra MetaValue: $ref (entire scalar)
        if (val.startsWith('$')) {
            return resolveMetaRef(val, pack, parentDoc, node);
        }

        // Handle numeric underscores (e.g., 1_000_000, 1_000.5, 1e1_0)
        // Supports integers, floats, and scientific notation with underscores
        if (/^[\d_]+(\.[\d_]+)?([eE][+-]?[\d_]+)?$/.test(val) && val.includes('_')) {
            const normalized = val.replace(/_/g, '');
            if (!isNaN(Number(normalized))) return { value: Number(normalized), origin: parentDoc, range: node.range, interpolated };
        }

        // Field-Aware Validation
        if (isExpressionField || interpolated) {
            const exprRes = validateExpression(val);
            if (!exprRes.isValid) {
                // Downgrade to warning unless in a strict expression context (palette, slant)
                const isStrictExprContext = pathStr.includes('.palette') || pathStr.includes('.slant');
                pack.diagnostics.push({
                    code: 'MALFORMED_EXPRESSION',
                    message: exprRes.message || `Malformed expression: "${val}"`,
                    severity: isStrictExprContext ? 'error' : 'warning',
                    file: parentDoc.filePath,
                    range: node.range ? {
                        start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                        end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
                    } : undefined
                });
            }
        }

        // Block state validation: only in known block contexts, or if it looks like a block ID
        const looksLikeBlockId = /^[a-z_]+:[a-z_]+/.test(val) || val.toUpperCase().startsWith('BLOCK:');
        if ((isBlockField || looksLikeBlockId) && val.includes('[')) {
            const blockRes = validateBlockState(val);
            if (!blockRes.isValid) {
                // Error in palette layers (likely real), warning elsewhere
                const isInPalette = pathStr.includes('.palette');
                pack.diagnostics.push({
                    code: 'INVALID_BLOCK_STATE',
                    message: blockRes.message || `Invalid block state: "${val}"`,
                    severity: isInPalette ? 'error' : 'warning',
                    file: parentDoc.filePath,
                    range: node.range ? {
                        start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                        end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
                    } : undefined
                });
            }
        }

        const finalValue = val === String(node.value) ? node.value : val;
        // Include self provenance for scalar
        provenance.set('', selfProvenance);

        return {
            value: finalValue,
            origin: parentDoc,
            range: node.range,
            interpolated,
            provenance
        };
    }

    if (isMap(node)) {
        const result: any = {};

        // Populate self provenance for the map itself
        setProvenance(provenance, '', {
            file: parentDoc.filePath,
            range: node.range ? {
                start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
            } : undefined as any,
            sourceKind: parentDoc.sourceKind
        });

        // Attach hidden provenance map to the result object for easy access later (e.g. in extends)
        Object.defineProperty(result, '__terra_provenance', { value: provenance, enumerable: false });

        // Helper to merge provenance maps
        const mergeProvenance = (prefix: string, source: ProvenanceMap) => {
            for (const [key, entry] of source.entries()) {
                const newKey = key === '' ? prefix : `${prefix}${key}`;
                provenance.set(newKey, entry);
            }
        };

        for (const pair of node.items) {
            const { key, value } = pair as any;
            if (isScalar(key)) {
                const keyStr = String(key.value);
                if (keyStr === '<<') {
                    const merged = isSeq(value)
                        ? (value.items as Node[]).map(item => resolveMetaMerge(item, pack, parentDoc))
                        : [resolveMetaMerge(value as Node, pack, parentDoc)];

                    for (const m of merged) {
                        // Phase 1 fix: Only merge plain objects, not arrays or primitives
                        if (m === null || m === undefined) continue;
                        if (Array.isArray(m)) {
                            pack.diagnostics.push({
                                code: 'META_MERGE_NOT_A_MAP',
                                message: 'Cannot merge an array into a map. The merge target resolved to a list, not an object.',
                                severity: 'error',
                                file: parentDoc.filePath,
                                range: value.range ? {
                                    start: { ...parentDoc.lineCounter.linePos(value.range[0]), offset: value.range[0] },
                                    end: { ...parentDoc.lineCounter.linePos(value.range[1]), offset: value.range[1] }
                                } : undefined
                            });
                            continue;
                        }
                        if (typeof m !== 'object') {
                            pack.diagnostics.push({
                                code: 'META_MERGE_NOT_A_MAP',
                                message: `Cannot merge a scalar (${typeof m}) into a map. The merge target must be an object.`,
                                severity: 'error',
                                file: parentDoc.filePath,
                                range: value.range ? {
                                    start: { ...parentDoc.lineCounter.linePos(value.range[0]), offset: value.range[0] },
                                    end: { ...parentDoc.lineCounter.linePos(value.range[1]), offset: value.range[1] }
                                } : undefined
                            });
                            continue;
                        }

                        // Safe to merge: m is a plain object
                        Object.assign(result, m);

                        // Merge provenance from the merged object
                        if ((m as any).__terra_provenance) {
                            // When merging a full object, its keys are at root of result
                            mergeProvenance('', (m as any).__terra_provenance);
                        }
                    }
                } else {
                    const resolved = resolveValue(value as Node, pack, parentDoc, [...fieldPath, keyStr]);
                    result[keyStr] = resolved.value;

                    // Add provenance for this key's value
                    if (resolved.provenance) {
                        mergeProvenance(`/${keyStr}`, resolved.provenance);
                    } else if (resolved.value !== undefined) {
                        // Fallback for primitive values resolved without provenance map
                        setProvenance(provenance, `/${keyStr}`, {
                            file: resolved.origin.filePath,
                            range: resolved.range ? {
                                start: { ...resolved.origin.lineCounter.linePos(resolved.range[0]), offset: resolved.range[0] },
                                end: { ...resolved.origin.lineCounter.linePos(resolved.range[1]), offset: resolved.range[1] }
                            } : undefined as any,
                            sourceKind: resolved.origin.sourceKind
                        });
                    }
                }
            }
        }
        return { value: result, origin: parentDoc, range: node.range, provenance };
    }

    if (isSeq(node)) {
        const result: any[] = [];

        // Populate self provenance for the list itself
        setProvenance(provenance, '', {
            file: parentDoc.filePath,
            range: node.range ? {
                start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
            } : undefined as any,
            sourceKind: parentDoc.sourceKind
        });

        // Attach hidden provenance map
        Object.defineProperty(result, '__terra_provenance', { value: provenance, enumerable: false });

        // Helper to merge provenance maps
        const mergeProvenance = (prefix: string, source: ProvenanceMap) => {
            for (const [key, entry] of source.entries()) {
                const newKey = key === '' ? prefix : `${prefix}${key}`;
                provenance.set(newKey, entry);
            }
        };

        for (let i = 0; i < node.items.length; i++) {
            const item = node.items[i];
            const currentIndex = result.length;

            // List-Merge Compatibility: - <<: ref
            if (isMap(item) && (pathStr.includes('palette') || pathStr.includes('features'))) {
                const mapItems = (item as any).items;
                if (mapItems.length === 1 && isScalar(mapItems[0].key) && mapItems[0].key.value === '<<') {
                    const merged = resolveMetaMerge(mapItems[0].value as Node, pack, parentDoc);
                    if (Array.isArray(merged)) {
                        // Splicing a list
                        merged.forEach((mItem, j) => {
                            result.push(mItem);
                            // If the merged list has provenance, try to map it
                            if ((merged as any).__terra_provenance) {
                                // This is tricky: we'd need to shift indices. 
                                // For now we might lose granular provenance of spliced items unless we iterate carefully.
                                // Ideal: look up provenance of index 'j' in merged list
                                const sourceMap = (merged as any).__terra_provenance as ProvenanceMap;
                                // We can't easily iterate the source map by index without parsing keys.
                                // Simplified approach: If the item itself is an object/array, it has its own provenance.
                            }
                        });
                        // Add provenance for the spliced items (best effort)
                        if ((merged as any).__terra_provenance) {
                            const sourceMap = (merged as any).__terra_provenance as ProvenanceMap;
                            // Map keys like "/0/..." to "/{currentIndex}/..."
                            for (const [key, entry] of sourceMap.entries()) {
                                if (key.startsWith('/')) {
                                    // key is like /0/foo or /0
                                    const firstSlash = key.indexOf('/', 1);
                                    const indexStr = firstSlash === -1 ? key.substring(1) : key.substring(1, firstSlash);
                                    const index = parseInt(indexStr);
                                    if (!isNaN(index)) {
                                        const suffix = firstSlash === -1 ? '' : key.substring(firstSlash);
                                        setProvenance(provenance, `/${currentIndex + index}${suffix}`, entry);
                                    }
                                }
                            }
                        }
                    } else if (typeof merged === 'object' && merged !== null) {
                        result.push(merged);
                        if ((merged as any).__terra_provenance) {
                            mergeProvenance(`/${currentIndex}`, (merged as any).__terra_provenance);
                        }
                    }
                    continue;
                }
            }

            // MetaList: - << ref
            if (isScalar(item) && String((item as Scalar).value).startsWith('<< ')) {
                const refPart = String((item as Scalar).value).substring(3).trim();
                const resolved = resolveMetaRef('$' + refPart, pack, parentDoc, item);
                if (Array.isArray(resolved.value)) {
                    const mergedList = resolved.value;
                    mergedList.forEach((mItem, j) => {
                        result.push(mItem);
                    });
                    // Propagate provenance from the referenced list
                    if (resolved.provenance) {
                        const sourceMap = resolved.provenance;
                        for (const [key, entry] of sourceMap.entries()) {
                            if (key.startsWith('/')) {
                                const firstSlash = key.indexOf('/', 1);
                                const indexStr = firstSlash === -1 ? key.substring(1) : key.substring(1, firstSlash);
                                const index = parseInt(indexStr);
                                if (!isNaN(index)) {
                                    const suffix = firstSlash === -1 ? '' : key.substring(firstSlash);
                                    setProvenance(provenance, `/${currentIndex + index}${suffix}`, entry);
                                }
                            }
                        }
                    }
                } else {
                    result.push(resolved.value);
                    if (resolved.provenance) {
                        mergeProvenance(`/${currentIndex}`, resolved.provenance);
                    } else {
                        setProvenance(provenance, `/${currentIndex}`, {
                            file: resolved.origin.filePath,
                            range: resolved.range ? {
                                start: { ...resolved.origin.lineCounter.linePos(resolved.range[0]), offset: resolved.range[0] },
                                end: { ...resolved.origin.lineCounter.linePos(resolved.range[1]), offset: resolved.range[1] }
                            } : undefined as any,
                            sourceKind: resolved.origin.sourceKind
                        });
                    }
                }
                continue;
            }

            const resolved = resolveValue(item as Node, pack, parentDoc, [...fieldPath, '[]']);
            result.push(resolved.value);

            if (resolved.provenance) {
                mergeProvenance(`/${currentIndex}`, resolved.provenance);
            } else {
                setProvenance(provenance, `/${currentIndex}`, {
                    file: resolved.origin.filePath,
                    range: resolved.range ? {
                        start: { ...resolved.origin.lineCounter.linePos(resolved.range[0]), offset: resolved.range[0] },
                        end: { ...resolved.origin.lineCounter.linePos(resolved.range[1]), offset: resolved.range[1] }
                    } : undefined as any,
                    sourceKind: resolved.origin.sourceKind
                });
            }
        }
        return { value: result, origin: parentDoc, range: node.range, provenance };
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
/**
 * Resolves a merge target node. Returns the resolved value directly.
 * The caller is responsible for validating the type and emitting diagnostics.
 */
function resolveMetaMerge(node: Node, pack: Pack, parentDoc: ParsedYaml): any {
    if (isScalar(node)) {
        const res = resolveValue(node, pack, parentDoc);
        // Return the actual resolved value - caller will validate type
        return res.value;
    }
    if (isSeq(node)) {
        // A sequence of merge targets - resolve each and merge plain objects
        let result: any = {};
        for (const item of node.items) {
            const merged = resolveMetaMerge(item as Node, pack, parentDoc);
            if (merged !== null && merged !== undefined && typeof merged === 'object' && !Array.isArray(merged)) {
                Object.assign(result, merged);
            }
            // Arrays/scalars from nested merge are silently ignored here
            // The outer caller will catch type mismatches at the top level
        }
        return result;
    }
    // Map node - resolve it
    const res = resolveValue(node, pack, parentDoc);
    return res.value;
}
