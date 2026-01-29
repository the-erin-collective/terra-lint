import { isMap, isScalar, isSeq, Node, Scalar, isAlias } from 'yaml';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import type { Pack } from '../core/pack.js';
import { ParsedYaml, parseYaml } from '../parser/yaml.js';
import { validateBlockState, validateExpression } from './validation-utils.js';
import { PValue, Origin, createPScalar, createPSeq, createPMap, isPMap, isPSeq, toJS } from './pvalue/types.js';

// Helper function to detect file-like meta references
function isFileLikeMetaRef(raw: string): boolean {
    // raw is like "$biomes/colors.yml:DRAGON_PIT"
    const s = raw.startsWith("$") ? raw.slice(1) : raw;

    if (s.includes(".yml") || s.includes(".yaml") || s.includes("/") || s.includes("\\")) return true;

    // If it has a colon, only accept if the LHS looks path-ish
    const i = s.indexOf(":");
    if (i !== -1) {
        const lhs = s.slice(0, i);
        return lhs.includes("/") || lhs.includes("\\") || lhs.includes(".yml") || lhs.includes(".yaml");
    }
    return false;
}

// Helper function to detect file-like paths
function isFileLikePath(s: string): boolean {
    return s.includes(".yml") || s.includes(".yaml") || s.includes("/") || s.includes("\\");
}

export function resolveValue(
    node: Node | null | undefined,
    pack: Pack,
    parentDoc: ParsedYaml,
    fieldPath: string[] = []
): PValue {
    // Handle YAML aliases by resolving them first
    if (node && isAlias(node)) {
        return resolveValue(node.resolve(parentDoc.doc), pack, parentDoc, fieldPath);
    }
    
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
    
    // Capture authoring kind from YAML node
    let authoring;
    if (isScalar(node)) {
        const scalarType = typeof node.value === 'string' ? 'string' as const :
                          typeof node.value === 'number' ? 'number' as const :
                          typeof node.value === 'boolean' ? 'boolean' as const :
                          node.value === null ? 'null' as const : 'unknown' as const;
        authoring = {
            kind: 'scalar' as const,
            scalarType,
            raw: String(node.value)
        };
    } else if (isMap(node)) {
        authoring = { kind: 'map' as const };
    } else if (isSeq(node)) {
        authoring = { kind: 'seq' as const };
    }
    
    const origin: Origin = {
        file: parentDoc.filePath,
        range,
        fullRange: node.range ? {
            start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
            end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
        } : undefined,
        via: 'direct',
        authoring
    };

    if (isScalar(node)) {
        let val = String(node.value);
        let interpolated = false;

        // Terra MetaString: ${ref}
        if (val.includes('${')) {
            const regex = /\${([^}]+)}/g;
            let out = "";
            let last = 0;
            let match;
            while ((match = regex.exec(val)) !== null) {
                const ref = match[1];
                const rawRef = '$' + ref;
                
                // Guard: only resolve file-like references
                if (!isFileLikeMetaRef(rawRef)) {
                    // If it's not file-like, treat it as literal text
                    out += val.slice(last, match.index);
                    out += '${' + ref + '}';
                    last = match.index + match[0].length;

                    pack.diagnostics.push({
                        code: 'META_STRING_NON_FILE_REF',
                        message: `MetaString reference "${ref}" doesn't look like a file/path reference.`,
                        severity: 'warning',
                        file: parentDoc.filePath,
                        range: origin.fullRange
                    });
                    continue;
                }
                
                const resolved = resolveMetaRef(rawRef, pack, parentDoc, node);

                // resolved is PValue. Expect scalar for interpolation.
                // If it's not a scalar, stringify it?
                // resolved.kind check?
                let resolvedVal = '';
                if (resolved.kind === 'scalar') resolvedVal = String(resolved.value);
                else {
                    resolvedVal = JSON.stringify(toJS(resolved));
                    pack.diagnostics.push({
                        code: 'META_STRING_NON_SCALAR',
                        message: `MetaString interpolation of non-scalar value (${resolved.kind}). Consider using a scalar value.`,
                        severity: 'warning',
                        file: parentDoc.filePath,
                        range: origin.fullRange
                    });
                }

                out += val.slice(last, match.index);
                out += resolvedVal;
                last = match.index + match[0].length;
            }
            out += val.slice(last);
            interpolated = true;
            val = out.replace(/\r?\n/g, ' ').trim();

            // Create metaSite for MetaString interpolation
            const metaSite = {
                file: parentDoc.filePath,
                range: node.range ? { start: node.range[0], end: node.range[1] } : undefined,
                kind: 'scalar' as const,
                raw: String(node.value)
            };

            // Update origin for interpolated result
            const metaStringOrigin: Origin = {
                ...origin,
                via: 'meta',
                metaSite,
                authoring: {
                    kind: 'scalar' as const,
                    scalarType: typeof val === 'string' ? 'string' :
                                typeof val === 'number' ? 'number' :
                                typeof val === 'boolean' ? 'boolean' :
                                val === null ? 'null' : 'unknown',
                    raw: val
                }
            };

            if (/^-?\d+(\.\d+)?$/.test(val)) {
                const numericVal = Number(val);
                const numericOrigin: Origin = {
                    ...metaStringOrigin,
                    authoring: {
                        ...metaStringOrigin.authoring!,
                        scalarType: 'number',
                        raw: val
                    }
                };
                return createPScalar(numericVal, numericOrigin);
            }
            return createPScalar(val, metaStringOrigin);
        }

        // Terra MetaValue: $ref (entire scalar)
        if (val.startsWith('$') && isFileLikeMetaRef(val)) {
            const resolved = resolveMetaRef(val, pack, parentDoc, node);
            
            // Create metaSite information - MetaValue is always from a scalar
            const metaSite = {
                file: parentDoc.filePath,
                range: node.range ? { start: node.range[0], end: node.range[1] } : undefined,
                kind: 'scalar' as const,
                raw: String(node.value)
            };

            // Shallow clone to update origin while preserving authoring
            const metaOrigin: Origin = {
                ...resolved.origin,
                via: 'meta',
                metaSite
                // Keep resolved.origin.authoring intact - it belongs to the referenced file's node
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
                        const message = interpolated 
                            ? `Syntax Error: ${err.message} (at expression offset ${err.range.start}-${err.range.end})`
                            : `Syntax Error: ${err.message}`;
                        pack.diagnostics.push({
                            code: 'EXPR_SYNTAX_ERROR',
                            message,
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

        // Block state validation - only trigger on actual block state syntax
        const looksLikeBlockId = /^[a-z_]+:[a-z_]+/.test(val) || val.toUpperCase().startsWith('BLOCK:');
        const hasBlockStateBrackets = /(^|BLOCK:)[a-z0-9_]+:[a-z0-9_/.-]+\[[^\]]*\]/i.test(val);
        if ((isBlockField || looksLikeBlockId) && hasBlockStateBrackets) {
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
        
        // First pass: collect all merge sources
        const mergeSources: Array<{source: PValue, node: Node}> = [];
        const localPairs: Array<{keyStr: string, value: Node}> = [];

        for (const pair of node.items) {
            const { key, value } = pair as any;
            if (isScalar(key)) {
                const keyStr = String(key.value);

                if (keyStr === '<<') {
                    // Handle merge sources - check if value is an alias
                    let mergeValue = value;
                    if (isAlias(value)) {
                        mergeValue = value.resolve(parentDoc.doc);
                    }
                    
                    if (isSeq(mergeValue)) {
                        for (const item of mergeValue.items) {
                            // If item is scalar, treat as meta ref (with or without $)
                            if (isScalar(item)) {
                                const itemVal = String(item.value);
                                const refCandidate = itemVal.startsWith('$') ? itemVal : '$' + itemVal;
                                
                                if (isFileLikeMetaRef(refCandidate)) {
                                    mergeSources.push({source: resolveMetaRef(refCandidate, pack, parentDoc, item), node: item as Node});
                                } else {
                                    // Not file-like -> merge is invalid
                                    const mergeRange = item.range ? {
                                        start: { ...parentDoc.lineCounter.linePos(item.range[0]), offset: item.range[0] },
                                        end: { ...parentDoc.lineCounter.linePos(item.range[1]), offset: item.range[1] }
                                    } : undefined;

                                    pack.diagnostics.push({
                                        code: 'META_MERGE_NOT_A_MAP',
                                        message: `Cannot merge "${itemVal}" into a map. Expected a map reference like "path.yml:key".`,
                                        severity: 'error',
                                        file: parentDoc.filePath,
                                        range: mergeRange
                                    });
                                }
                            } else {
                                mergeSources.push({source: resolveValue(item as Node, pack, parentDoc), node: item as Node});
                            }
                        }
                    } else {
                        // Single value
                        if (isScalar(mergeValue)) {
                            const valueVal = String(mergeValue.value);
                            // Only treat as meta ref if it has meta-ref characteristics
                            const refCandidate = valueVal.startsWith('$') ? valueVal : '$' + valueVal;
                            if (isFileLikeMetaRef(refCandidate)) {
                                mergeSources.push({source: resolveMetaRef(refCandidate, pack, parentDoc, mergeValue), node: mergeValue});
                            } else {
                                // Plain scalar - this is an error for map merge
                                const mergeRange = mergeValue.range ? {
                                    start: { ...parentDoc.lineCounter.linePos(mergeValue.range[0]), offset: mergeValue.range[0] },
                                    end: { ...parentDoc.lineCounter.linePos(mergeValue.range[1]), offset: mergeValue.range[1] }
                                } : undefined;
                                
                                pack.diagnostics.push({
                                    code: 'META_MERGE_NOT_A_MAP',
                                    message: `Cannot merge a scalar into a map. Expected a map or meta-reference.`,
                                    severity: 'error',
                                    file: parentDoc.filePath,
                                    range: mergeRange
                                });
                            }
                        } else {
                            mergeSources.push({source: resolveValue(mergeValue as Node, pack, parentDoc), node: mergeValue});
                        }
                    }
                } else {
                    // Collect local keys for later processing
                    localPairs.push({ keyStr, value });
                }
            }
        }

        // Second pass: apply merge sources first (defaults)
        for (const {source: m, node: mergeNode} of mergeSources) {
            if (m.kind !== 'map') {
                const mergeRange = mergeNode.range ? {
                    start: { ...parentDoc.lineCounter.linePos(mergeNode.range[0]), offset: mergeNode.range[0] },
                    end: { ...parentDoc.lineCounter.linePos(mergeNode.range[1]), offset: mergeNode.range[1] }
                } : undefined;
                
                pack.diagnostics.push({
                    code: 'META_MERGE_NOT_A_MAP',
                    message: `Cannot merge a ${m.kind} into a map.`,
                    severity: 'error',
                    file: parentDoc.filePath,
                    range: mergeRange
                });
                continue;
            }

            // Apply merge defaults (don't overwrite existing keys)
            for (const [k, v] of m.entries) {
                if (!entries.has(k)) {
                    entries.set(k, v);
                }
            }
        }

        // Third pass: apply local keys (overwrite defaults)
        for (const { keyStr, value } of localPairs) {
            const resolved = resolveValue(value as Node, pack, parentDoc, [...fieldPath, keyStr]);
            entries.set(keyStr, resolved);
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
                    const spliceRange = item.range ? {
                        start: { ...parentDoc.lineCounter.linePos(item.range[0]), offset: item.range[0] },
                        end: { ...parentDoc.lineCounter.linePos(item.range[1]), offset: item.range[1] }
                    } : undefined;
                    
                    pack.diagnostics.push({
                        code: 'META_SPLICE_NOT_A_LIST',
                        message: `Meta-splice target is not a list (got ${resolved.kind})`,
                        severity: 'error',
                        file: parentDoc.filePath,
                        range: spliceRange
                    });
                }
                continue;
            }

            // Terra List-Merge: - <<: $ref (Map inside List)
            if (isMap(item)) {
                const mapItems = (item as any).items;
                if (mapItems.length === 1 && isScalar(mapItems[0].key) && mapItems[0].key.value === '<<') {
                    // Same logic as splice
                    const valNode = mapItems[0].value;
                    let resolved: PValue;
                    if (isScalar(valNode)) {
                        const v = String(valNode.value);
                        const ref = v.startsWith('$') ? v : '$' + v;
                        resolved = resolveMetaRef(ref, pack, parentDoc, valNode);
                    } else {
                        resolved = resolveValue(valNode as Node, pack, parentDoc);
                    }

                    if (resolved.kind === 'seq') {
                        items.push(...resolved.items);
                    } else {
                        // This is the Terra-specific case where we want to merge a sequence into a list
                        // If the resolved value is a map, that's an error for list merge
                        const listMergeRange = item.range ? {
                            start: { ...parentDoc.lineCounter.linePos(item.range[0]), offset: item.range[0] },
                            end: { ...parentDoc.lineCounter.linePos(item.range[1]), offset: item.range[1] }
                        } : undefined;
                        
                        pack.diagnostics.push({
                            code: 'META_LIST_MERGE_NOT_A_LIST',
                            message: `Cannot merge a ${resolved.kind} into a list.`,
                            severity: 'error',
                            file: parentDoc.filePath,
                            range: listMergeRange
                        });
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

    // Hard guard: don't treat non-file-like refs as meta refs at all
    if (!isFileLikeMetaRef(ref)) {
        const range = node?.range ? { start: node.range[0], end: node.range[1] } : undefined;
        const fullRange = range ? {
            start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
            end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
        } : undefined;
        const origin: Origin = {
            via: 'direct',
            file: parentDoc.filePath,
            authoring: {
                kind: 'scalar',
                scalarType: 'string',
                raw: ref
            },
            fullRange
        };
        return createPScalar(ref, origin);
    }

    let pathStr = ref.startsWith('$') ? ref.substring(1) : ref;
    if (pathStr.startsWith('{') && pathStr.endsWith('}')) pathStr = pathStr.substring(1, pathStr.length - 1);

    // Handle Windows absolute paths like C:\... - don't split on colon there
    let filePath: string;
    let pathInFile: string[];

    if (/^[A-Za-z]:[\\/]/.test(pathStr)) {
        // Windows absolute path - treat entire string as file path
        filePath = pathStr;
        pathInFile = [];
    } else {
        // Split on first colon only for meta refs
        const colonIndex = pathStr.indexOf(':');
        if (colonIndex === -1) {
            filePath = pathStr;
            pathInFile = [];
        } else {
            filePath = pathStr.substring(0, colonIndex);
            const remainingPath = pathStr.substring(colonIndex + 1);
            pathInFile = remainingPath ? remainingPath.split('.') : [];
        }
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
            const dfp = path.resolve(d.filePath).toLowerCase().replace(/\\/g, '/');
            const relative = dfp.substring(rootAbs.length).replace(/^\//, '');
            return relative.endsWith(normalizedSearch.toLowerCase());
        });
        if (suffix.length) { results = suffix; break; }
    }

    if (results.length === 0) {
        // Only try filesystem fallback for file-like paths
        if (isFileLikePath(filePath)) {
            const fsRes = tryFilesystemFallback(filePath, pack, parentDoc);
            
            if (fsRes.kind === "ambiguous") {
                pack.diagnostics.push({
                    code: 'META_REF_AMBIGUOUS',
                    message: `Ambiguous meta-reference "${filePath}". Multiple files match:\n` +
                             fsRes.candidates.slice(0, 5).join("\n") + (fsRes.candidates.length > 5 ? "\n..." : ""),
                    severity: 'error',
                    file: parentDoc.filePath,
                    range: origin.fullRange
                });
                return createPScalar(ref, origin);
            }
            
            if (fsRes.kind === "found") {
                const fallbackDoc = fsRes.doc;
                let current: Node | null | undefined = fallbackDoc.doc.contents as any;
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

                const resolved = resolveValue(current, pack, fallbackDoc);
                const metaSiteKind = node ? 
                    (isScalar(node) ? 'scalar' : isMap(node) ? 'map' : isSeq(node) ? 'seq' : 'scalar') : 
                    'scalar';
                return markAsMetaDerived(resolved, parentDoc.filePath, range, String(node?.value || ref), metaSiteKind);
            }
        }

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

    const resolved = resolveValue(current, pack, doc);
    // Determine the metaSite kind from the reference node
    const metaSiteKind = node ? 
        (isScalar(node) ? 'scalar' : isMap(node) ? 'map' : isSeq(node) ? 'seq' : 'scalar') : 
        'scalar';
    return markAsMetaDerived(resolved, parentDoc.filePath, range, String(node?.value || ref), metaSiteKind);
}

// Helper function to mark PValue as meta-derived
function markAsMetaDerived(pvalue: PValue, metaSiteFile: string, metaSiteRange?: { start: number; end: number }, metaSiteRaw?: string, metaSiteKind?: "scalar" | "map" | "seq"): PValue {
    const metaSite = {
        file: metaSiteFile,
        range: metaSiteRange,
        kind: metaSiteKind || 'scalar', // Default to scalar since most meta refs are from scalars
        raw: metaSiteRaw
    };

    const metaOrigin: Origin = {
        ...pvalue.origin,
        via: 'meta',
        metaSite
        // Keep pvalue.origin.authoring intact - it belongs to the referenced file's node
    };

    // Shallow clone to update origin
    if (pvalue.kind === 'scalar') return { ...pvalue, origin: metaOrigin };
    if (pvalue.kind === 'seq') return { ...pvalue, origin: metaOrigin };
    if (pvalue.kind === 'map') return { ...pvalue, origin: metaOrigin };
    return pvalue;
}

// Helper function for filesystem fallback
type FsFallbackResult =
  | { kind: "found"; doc: ParsedYaml }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "missing" };

function tryFilesystemFallback(filePath: string, pack: Pack, parentDoc: ParsedYaml): FsFallbackResult {
    const roots = [pack.rootPath, ...pack.includePaths];
    const foundFiles: Array<{path: string, root: string}> = [];
    
    // First, collect all potential matches to check for ambiguity
    for (const root of roots) {
        // Try exact match first
        let fullPath = path.join(root, filePath);
        if (existsSync(fullPath) && (fullPath.endsWith('.yml') || fullPath.endsWith('.yaml'))) {
            foundFiles.push({path: fullPath, root});
        }
        
        // Try with .yml extension
        if (!filePath.endsWith('.yml') && !filePath.endsWith('.yaml')) {
            fullPath = path.join(root, filePath + '.yml');
            if (existsSync(fullPath)) {
                foundFiles.push({path: fullPath, root});
            }
            
            // Try with .yaml extension
            fullPath = path.join(root, filePath + '.yaml');
            if (existsSync(fullPath)) {
                foundFiles.push({path: fullPath, root});
            }
        }
    }
    
    // Check for ambiguity
    if (foundFiles.length > 1) {
        return { 
            kind: "ambiguous", 
            candidates: foundFiles.map(f => {
                // Try to make path relative to the most appropriate root
                const relativeToPack = path.relative(pack.rootPath, f.path);
                const relativeToInclude = f.root !== pack.rootPath ? 
                    ` (from include: ${path.relative(f.root, f.path)})` : '';
                return relativeToPack + relativeToInclude;
            })
        };
    }
    
    if (foundFiles.length === 0) {
        return { kind: "missing" };
    }
    
    // Load the single found file
    const {path: fullPath} = foundFiles[0];
    try {
        const content = readFileSync(fullPath, 'utf8');
        const { parsed } = parseYaml(content, fullPath, 'root');
        if (parsed) {
            pack.registry.addParsedDoc(parsed, pack);
            return { kind: "found", doc: parsed };
        }
    } catch (e) {
        // Continue to return missing
    }
    
    return { kind: "missing" };
}

// Deprecated or integrated helpers
function resolveMetaMerge() { }

