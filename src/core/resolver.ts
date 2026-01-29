import { isMap, isScalar, isSeq, Node, Scalar } from 'yaml';
import path from 'path';
import type { Pack } from '../core/pack.js';
import { ParsedYaml } from '../parser/yaml.js';
import { validateBlockState, validateExpression } from './validation-utils.js';
import { PValue, Origin, createPScalar, createPSeq, createPMap, isPMap, isPSeq } from './pvalue/types.js';

export function resolveValue(
    node: Node | null | undefined,
    pack: Pack,
    parentDoc: ParsedYaml,
    fieldPath: string[] = []
): PValue {
    // Default origin for missing nodes is just the file (or parent node's location?)
    // If node is null, we return a null scalar with file origin
    const defaultOrigin: Origin = { file: parentDoc.filePath };
    if (!node) return createPScalar(undefined, defaultOrigin);

    const pathStr = fieldPath.join('.');
    const lastField = fieldPath[fieldPath.length - 1];

    // Field-aware gating
    const isExpressionField = pack.isExpressionField(pathStr, lastField);
    const isBlockField = pack.isBlockField(pathStr, lastField);

    const range = node.range ? { start: node.range[0], end: node.range[1] } : undefined;
    const origin: Origin = {
        file: parentDoc.filePath,
        range,
        fullRange: node.range ? {
            start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
            end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
        } : undefined,
        via: 'direct'
    };

    if (isScalar(node)) {
        let val = String(node.value);
        let interpolated = false;

        // Terra MetaString: ${ref}
        if (val.includes('${')) {
            const regex = /\${([^}]+)}/g;
            let match;
            let result = val;
            while ((match = regex.exec(val)) !== null) {
                const ref = match[1];
                const resolved = resolveMetaRef('$' + ref, pack, parentDoc, node);

                // resolved is PValue. Expect scalar for interpolation.
                // If it's not a scalar, stringify it?
                // resolved.kind check?
                let resolvedVal = '';
                if (resolved.kind === 'scalar') resolvedVal = String(resolved.value);
                else resolvedVal = JSON.stringify(resolved); // Fallback?

                result = result.replace(match[0], resolvedVal);
            }
            interpolated = true;
            val = result.replace(/\r?\n/g, ' ').trim();

            if (/^-?\d+(\.\d+)?$/.test(val)) {
                return createPScalar(Number(val), origin);
            }
        }

        // Terra MetaValue: $ref (entire scalar)
        if (val.startsWith('$')) {
            const resolved = resolveMetaRef(val, pack, parentDoc, node);
            // Mark origin as via meta? 
            // The resolved PValue keeps its own origin. 
            // We might want to wrap it or just return it?
            // "implement MetaValue ($file) returning PValue with 'meta' origin"
            // If we just return resolved, we see the target file.
            // If we want to trace the jump, we can wrap or modify.
            // But PValue is a tree. If resolved is a PSeq, we return that PSeq.

            // To preserve the "jump" info, we could modify the origin.via, but that mutates the resolved node which might be shared?
            // Actually, resolveMetaRef returns a fresh structure (since we parse fresh or clone).
            // But if we cache docs, we must be careful.
            // For now, let's just return resolved. The user wants "origin.via = 'meta'".
            // We can clone the PValue (shallowly) and update origin.

            const metaOrigin: Origin = {
                ...resolved.origin,
                via: 'meta'
                // We keep the target file/range, but mark it arrived via meta.
                // Or do we want the origin to be THIS file?
                // "MetaValue $file:path ... resolved node carries its own provenance ... origin.via = 'meta' (and keep original file+range)"
            };

            // Shallow clone to update origin
            if (resolved.kind === 'scalar') return { ...resolved, origin: metaOrigin };
            if (resolved.kind === 'seq') return { ...resolved, origin: metaOrigin };
            if (resolved.kind === 'map') return { ...resolved, origin: metaOrigin };
        }

        // Numeric underscores
        if (/^[\d_]+(\.[\d_]+)?([eE][+-]?[\d_]+)?$/.test(val) && val.includes('_')) {
            const normalized = val.replace(/_/g, '');
            if (!isNaN(Number(normalized))) {
                return createPScalar(Number(normalized), origin);
            }
        }

        // Field-Aware Validation
        if (isExpressionField || interpolated) {
            const exprRes = validateExpression(val);
            if (!exprRes.isValid) {
                const isStrictExprContext = pathStr.includes('.palette') || pathStr.includes('.slant');
                if (exprRes.errors && exprRes.errors.length > 0) {
                    for (const err of exprRes.errors) {
                        let absRange = undefined;
                        if (!interpolated && node.range) {
                            const startOffset = node.range[0] + err.range.start;
                            const endOffset = node.range[0] + err.range.end;
                            absRange = {
                                start: { ...parentDoc.lineCounter.linePos(startOffset), offset: startOffset },
                                end: { ...parentDoc.lineCounter.linePos(endOffset), offset: endOffset }
                            };
                        }
                        pack.diagnostics.push({
                            code: 'EXPR_SYNTAX_ERROR',
                            message: `Syntax Error: ${err.message}`,
                            severity: isStrictExprContext ? 'error' : 'warning',
                            file: parentDoc.filePath,
                            range: absRange || origin.fullRange
                        });
                    }
                } else {
                    pack.diagnostics.push({
                        code: 'MALFORMED_EXPRESSION',
                        message: exprRes.message || `Malformed expression: "${val}"`,
                        severity: isStrictExprContext ? 'error' : 'warning',
                        file: parentDoc.filePath,
                        range: origin.fullRange
                    });
                }
            }
        }

        // Block state validation
        const looksLikeBlockId = /^[a-z_]+:[a-z_]+/.test(val) || val.toUpperCase().startsWith('BLOCK:');
        if ((isBlockField || looksLikeBlockId) && val.includes('[')) {
            const blockRes = validateBlockState(val);
            if (!blockRes.isValid) {
                const isInPalette = pathStr.includes('.palette');
                pack.diagnostics.push({
                    code: 'INVALID_BLOCK_STATE',
                    message: blockRes.message || `Invalid block state: "${val}"`,
                    severity: isInPalette ? 'error' : 'warning',
                    file: parentDoc.filePath,
                    range: origin.fullRange
                });
            }
        }

        const finalValue = val === String(node.value) ? node.value : val;
        return createPScalar(finalValue, origin);
    }

    if (isMap(node)) {
        const entries = new Map<string, PValue>();

        for (const pair of node.items) {
            const { key, value } = pair as any;
            if (isScalar(key)) {
                const keyStr = String(key.value);

                if (keyStr === '<<') {
                    // Merge
                    const merged = isSeq(value)
                        ? (value.items as Node[]).map(item => {
                            if (isScalar(item)) return resolveMetaRef(String(item.value), pack, parentDoc, item);
                            return resolveValue(item, pack, parentDoc);
                        })
                        : [resolveValue(value as Node, pack, parentDoc, [...fieldPath, '<<'])];

                    // Existing code had logic to handle list of refs.
                    // If `value` is list, we map resolveValue (or resolveMetaRef if logic requires).
                    // In `yaml`, `<<` value is usually scalar ref or map.

                    // Logic fix:
                    const mergeSources: PValue[] = [];
                    if (isSeq(value)) {
                        for (const item of value.items) {
                            // If item is scalar starting with $, resolve ref
                            if (isScalar(item) && String(item.value).startsWith('$')) {
                                mergeSources.push(resolveMetaRef(String(item.value), pack, parentDoc, item));
                            } else {
                                mergeSources.push(resolveValue(item as Node, pack, parentDoc));
                            }
                        }
                    } else {
                        // Single value
                        if (isScalar(value) && String(value.value).startsWith('$')) {
                            mergeSources.push(resolveMetaRef(String(value.value), pack, parentDoc, value));
                        } else {
                            mergeSources.push(resolveValue(value as Node, pack, parentDoc));
                        }
                    }

                    for (const m of mergeSources) {
                        if (m.kind !== 'map') {
                            pack.diagnostics.push({
                                code: 'META_MERGE_NOT_A_MAP',
                                message: `Cannot merge a ${m.kind} into a map.`,
                                severity: 'error',
                                file: parentDoc.filePath,
                                range: origin.fullRange // Blame the merge key's map? Or the specific value?
                            });
                            continue;
                        }

                        // Merge strategies:
                        // "apply referenced maps first ... then apply local keys"
                        // entries map accumulates. 
                        // If we are iterating YAML keys in order, `<<` usually comes early or late?
                        // Standard YAML: merge keys override earlier keys, but later keys override merge.
                        // Usually `<<` is put first.
                        // We are processing keys in order.
                        // If `<<` generates keys, we add them to `entries`.
                        // If a key already exists, do we overwrite?
                        // "local overrides" -> implies local keys processed AFTER or check existence?
                        // If `<<` is at the top, we add its keys.
                        // Later keys will overwrite `entries.set`.
                        // Checking if `<<` is not at top?

                        for (const [k, v] of m.entries) {
                            // We set unconditionally? 
                            // If `entries` already has k (from previous key in this map?), that previous key is "earlier" so it should stay? 
                            // Or `<<` provides defaults?
                            // Usually `<<` provides defaults, i.e. "use these unless I define them".
                            // So if key exists, we DON'T overwrite.
                            if (!entries.has(k)) {
                                entries.set(k, v);
                            }
                        }
                    }
                } else {
                    const resolved = resolveValue(value as Node, pack, parentDoc, [...fieldPath, keyStr]);
                    entries.set(keyStr, resolved);
                }
            }
        }
        return createPMap(entries, origin);
    }

    if (isSeq(node)) {
        const items: PValue[] = [];

        for (let i = 0; i < node.items.length; i++) {
            const item = node.items[i];

            // MetaList: - << ref
            if (isScalar(item) && String(item.value).startsWith('<< ')) {
                const refPart = String(item.value).substring(3).trim();
                const resolved = resolveMetaRef('$' + refPart, pack, parentDoc, item);

                if (resolved.kind === 'seq') {
                    // Splice items
                    items.push(...resolved.items);
                } else {
                    // Treat as single item? Or error?
                    // "must be a PSeq, otherwise emit META_SPLICE_NOT_A_LIST"
                    pack.diagnostics.push({
                        code: 'META_SPLICE_NOT_A_LIST',
                        message: `Meta-splice target is not a list (got ${resolved.kind})`,
                        severity: 'error',
                        file: parentDoc.filePath,
                        range: origin.fullRange // Blame the splice item location
                    });
                }
                continue;
            }

            // List-Merge Compatibility: - <<: ref (Map inside List) -- Is this standard Terra?
            // "List-Merge Compatibility: - <<: ref" lines 262-306 in original resolver.
            // If item is map with single key `<<`.
            if (isMap(item)) {
                const mapItems = (item as any).items;
                if (mapItems.length === 1 && isScalar(mapItems[0].key) && mapItems[0].key.value === '<<') {
                    // Same logic as splice
                    const valNode = mapItems[0].value;
                    let resolved: PValue;
                    if (isScalar(valNode) && String(valNode.value).startsWith('$')) {
                        resolved = resolveMetaRef(String(valNode.value), pack, parentDoc, valNode);
                    } else {
                        resolved = resolveValue(valNode, pack, parentDoc);
                    }

                    if (resolved.kind === 'seq') {
                        items.push(...resolved.items);
                    } else if (resolved.kind !== 'scalar' || resolved.value !== null) { // if null, maybe ignore?
                        // Original code handled 'object' merge.
                        items.push(resolved);
                    }
                    continue;
                }
            }

            items.push(resolveValue(item as Node, pack, parentDoc, [...fieldPath, '[]']));
        }
        return createPSeq(items, origin);
    }

    return createPScalar(undefined, defaultOrigin);
}

export function resolveMetaRef(ref: string, pack: Pack, parentDoc: ParsedYaml, node?: any): PValue {
    // Note: This logic duplicates path finding. Ideally extract 'findDoc(path)' logic.
    // For now, I'll basically inline the logic but return PValue.

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
        pathInFile = parts.slice(1).join(':').split('.'); // handle a:b.c -> file a, path b, c
    }

    const range = node?.range ? { start: node.range[0], end: node.range[1] } : undefined;
    const origin: Origin = {
        file: parentDoc.filePath,
        range,
        fullRange: range ? {
            start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
            end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
        } : undefined,
        via: 'meta'
    };

    if (!pack || !pack.registry) return createPScalar(ref, origin); // Validation fails?

    const normalizedSearch = filePath.replace(/\\/g, '/');
    const allDocs = pack.registry.getAllDocs();
    const roots = [pack.rootPath, ...pack.includePaths];
    let results: ParsedYaml[] = [];

    // Search logic... (Copy-paste abridged)
    for (const r of roots) {
        const rootAbs = path.resolve(r).toLowerCase().replace(/\\/g, '/');
        const docsAtLevel = allDocs.filter(d => path.resolve(d.filePath).toLowerCase().replace(/\\/g, '/').startsWith(rootAbs));

        const exact = docsAtLevel.filter(d => {
            const dfp = path.resolve(d.filePath).toLowerCase().replace(/\\/g, '/');
            const relative = dfp.substring(rootAbs.length).replace(/^\//, '');
            return relative === normalizedSearch.toLowerCase();
        });
        if (exact.length) { results = exact; break; }

        const suffix = docsAtLevel.filter(d => {
            const dfp = d.filePath.replace(/\\/g, '/').toLowerCase();
            return dfp.endsWith(normalizedSearch.toLowerCase()) || dfp.endsWith('/' + normalizedSearch.toLowerCase());
        });
        if (suffix.length) { results = suffix; break; }
    }

    if (results.length === 0) {
        pack.diagnostics.push({
            code: 'META_REF_FILE_MISSING',
            message: `Meta file "${filePath}" not found.`,
            severity: 'error',
            file: parentDoc.filePath,
            range: origin.fullRange
        });
        return createPScalar(ref, origin);
    }
    if (results.length > 1) {
        pack.diagnostics.push({
            code: 'META_REF_AMBIGUOUS',
            message: `Ambiguous meta-reference "${filePath}".`,
            severity: 'error',
            file: parentDoc.filePath,
            range: origin.fullRange
        });
        return createPScalar(ref, origin);
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
                message: `Path "${pathInFile.join('.')}" not found in meta file.`,
                severity: 'error',
                file: parentDoc.filePath,
                range: origin.fullRange
            });
            return createPScalar(ref, origin);
        }
        current = next;
    }

    return resolveValue(current, pack, doc);
}

// Deprecated or integrated helpers
function resolveMetaMerge() { }

