import { isMap, isScalar, isSeq, Node, isAlias } from 'yaml';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import type { Pack } from '../core/pack.js';
import { ParsedYaml, parseYaml } from '../parser/yaml.js';
import { validateBlockState, validateExpression } from './validation-utils.js';
import { PValue, Origin, createPScalar, createPSeq, createPMap, toJS } from './pvalue/types.js';

// Helper function to detect file-like meta references with confidence levels
type MetaRefConfidence = "definitely_ref" | "probably_ref" | "unlikely_ref";

function getMetaRefConfidence(s: string): MetaRefConfidence {
    // Definitely a reference: starts with $ and has file-like characteristics
    if (s.startsWith('$')) {
        let ref = s.substring(1);
        
        // Remove braces for evaluation
        if (ref.startsWith('{') && ref.endsWith('}')) {
            ref = ref.substring(1, ref.length - 1);
        }
        
        // Contains extension or path separator -> definitely file-like
        if (isFileLikePath(ref)) {
            return "definitely_ref";
        }
        
        // Contains colon - only treat as probably if left side looks file-like
        if (ref.includes(':')) {
            const lhs = ref.split(':', 1)[0];
            if (isFileLikePath(lhs) || lhs.toLowerCase() === 'meta') {
                return "probably_ref";
            }
            return "unlikely_ref"; // namespaced ids like minecraft:stone
        }
        
        // Contains dot but no extension - probably file-like
        if (ref.includes('.') && !ref.includes('.yml') && !ref.includes('.yaml')) {
            return "probably_ref";
        }
        
        // Single word with no path characteristics - unlikely to be a file
        return "unlikely_ref";
    }
    
    return "unlikely_ref";
}

// Helper function to attempt registry resolution with extensions
function attemptRegistryResolution(filePart: string, pack: Pack, currentFilePath?: string): { docs: ParsedYaml[], ambiguous: boolean } {
    // First try exact match
    let result = findInRegistry(filePart, pack, currentFilePath);
    if (result.docs.length > 0 || result.ambiguous) {
        return result;
    }
    
    // If no extension, try common extensions (works for subpaths too)
    if (!/\.[^/\\]+$/.test(filePart)) {
        for (const ext of ['.yml', '.yaml']) {
            result = findInRegistry(filePart + ext, pack, currentFilePath);
            if (result.docs.length > 0 || result.ambiguous) {
                return result;
            }
        }
    }
    
    return { docs: [], ambiguous: false };
}

// Helper function to detect file-like paths
function isFileLikePath(s: string): boolean {
    return s.includes(".yml") || s.includes(".yaml") || s.includes("/") || s.includes("\\");
}

// Helper function to detect and block directory traversal
function hasDirectoryTraversal(p: string): boolean {
    // Normalize path separators and check for .. segments
    const norm = p.replace(/\\/g, '/');
    return norm.split('/').some(seg => seg === '..');
}

// Helper function for secure path resolution with traversal protection
function securePathResolve(root: string, filePath: string): string | null {
    try {
        const rootAbs = path.resolve(root);
        const resolved = path.resolve(rootAbs, filePath);
        const rel = path.relative(rootAbs, resolved);
        
        // Normalize to POSIX for consistent traversal checking
        const relNorm = rel.replace(/\\/g, '/');
        
        // Block actual traversal: ".." as whole segment or starting with "../"
        if (relNorm === '..' || relNorm.startsWith('../') || path.isAbsolute(rel)) {
            return null; // Directory traversal attempt
        }
        
        return resolved;
    } catch {
        return null;
    }
}

// Helper function to find in registry with directory traversal for meta.yml
function findInRegistry(filePart: string, pack: Pack, currentFilePath?: string): { docs: ParsedYaml[], ambiguous: boolean } {
    const allDocs = pack.registry.getAllDocs();
    const normalizedSearch = filePart.replace(/\\/g, '/').toLowerCase();

    // If we have a current file path and looking for meta.yml or meta.yaml, walk up the directory tree
    const fpLower = filePart.toLowerCase();
    if (currentFilePath && (fpLower === 'meta.yml' || fpLower === 'meta.yaml')) {
        let currentDir = path.dirname(path.resolve(currentFilePath));
        const packRootAbs = path.resolve(pack.rootPath);
        const packRootNorm = packRootAbs.replace(/\\/g, '/').toLowerCase();
        
        // Use canonical filename for joining
        const canonicalFileName = fpLower === 'meta.yml' ? 'meta.yml' : 'meta.yaml';
        
        while (currentDir.replace(/\\/g, '/').toLowerCase().startsWith(packRootNorm) || 
               path.resolve(currentDir) === packRootAbs) {
            const localMetaPath = path.join(currentDir, canonicalFileName);
            const localDoc = allDocs.find(d => 
                path.resolve(d.filePath) === path.resolve(localMetaPath)
            );
            if (localDoc) {
                return { docs: [localDoc], ambiguous: false };
            }
            
            // Move up to parent directory
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) break; // Reached root
            currentDir = parentDir;
        }
    }

    // Tiered resolution: exact beats suffix, pack root beats includes
    const tiers = [
        { type: 'exact', roots: [pack.rootPath] },
        { type: 'exact', roots: pack.includePaths },
        { type: 'suffix', roots: [pack.rootPath] },
        { type: 'suffix', roots: pack.includePaths }
    ];

    for (const tier of tiers) {
        const tierResults: ParsedYaml[] = [];
        
        for (const root of tier.roots) {
            const rootAbs = path.resolve(root);
            const rootAbsNorm = rootAbs.replace(/\\/g, '/').toLowerCase();

            const matches = allDocs.filter(d => {
                const dfp = path.resolve(d.filePath);
                const dfpNorm = dfp.replace(/\\/g, '/').toLowerCase();
                
                // Skip docs that aren't under this root (case-insensitive check)
                if (dfpNorm !== rootAbsNorm && !dfpNorm.startsWith(rootAbsNorm + '/')) return false;
                
                const relative = dfp === rootAbs ? '' : dfp.slice(rootAbs.length + 1);
                const normalizedRelative = relative.replace(/\\/g, '/').toLowerCase();
                
                if (tier.type === 'exact') {
                    return normalizedRelative === normalizedSearch;
                } else {
                    return normalizedRelative.endsWith(normalizedSearch) || normalizedRelative.endsWith('/' + normalizedSearch);
                }
            });
            
            tierResults.push(...matches);
        }

        // Remove duplicates within this tier
        const uniqueTierDocs = Array.from(new Map(tierResults.map(d => [path.resolve(d.filePath), d])).values());
        
        if (uniqueTierDocs.length > 0) {
            // Check for ambiguity within this tier
            const ambiguous = uniqueTierDocs.length > 1;
            return { docs: uniqueTierDocs, ambiguous };
        }
    }

    return { docs: [], ambiguous: false };
}

// Helper function to parse meta-ref candidate
function parseMetaRefCandidate(raw: string): { filePart: string; pathInFile: string[]; hasColon: boolean; looksWindowsAbs: boolean } | null {
    if (!raw.startsWith('$')) return null;
    
    let pathStr = raw.substring(1);
    if (pathStr.startsWith('{') && pathStr.endsWith('}')) pathStr = pathStr.substring(1, pathStr.length - 1);

    // Handle Windows absolute paths like C:\... - don't split on colon there
    if (/^[A-Za-z]:[\\/]/.test(pathStr)) {
        return {
            filePart: pathStr,
            pathInFile: [],
            hasColon: false,
            looksWindowsAbs: true
        };
    }

    // Split on first colon only for meta refs
    const colonIndex = pathStr.indexOf(':');
    let filePath: string;
    let pathInFile: string[];
    const hasColon = colonIndex !== -1;

    if (colonIndex === -1) {
        filePath = pathStr;
        pathInFile = [];
    } else {
        filePath = pathStr.substring(0, colonIndex);
        const remainingPath = pathStr.substring(colonIndex + 1);
        pathInFile = remainingPath ? remainingPath.split('.') : [];
    }

    return {
        filePart: filePath,
        pathInFile,
        hasColon,
        looksWindowsAbs: false
    };
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
                const ref = match[1].trim();
                const rawRef = '$' + ref;
                
                // Guard: only resolve references with sufficient confidence
                const confidence = getMetaRefConfidence(rawRef);
                if (confidence === 'unlikely_ref') {
                    // If it's unlikely to be a ref, treat it as literal text
                    out += val.slice(last, match.index);
                    out += '${' + ref + '}';
                    last = match.index + match[0].length;
                    continue;
                }

                const resolved = resolveMetaRef(rawRef, pack, parentDoc, node);
                
                // Don't rewrite "skipped" into "meta" - only wrap if actually resolved
                if (resolved.origin?.via === 'meta-skipped') {
                    out += val.slice(last, match.index);
                    out += '${' + ref + '}';
                    last = match.index + match[0].length;
                    continue;
                }

                // For successful resolution, use the actual ref as metaSiteRaw
                const metaSiteRaw = '${' + ref + '}';
                
                // If it's not a scalar, stringify it?
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
        if (val.startsWith('$')) {
            const parsed = parseMetaRefCandidate(val);
            if (parsed) {
                // Security: block directory traversal attempts
                if (hasDirectoryTraversal(parsed.filePart)) {
                    const range = node?.range ? { start: node.range[0], end: node.range[1] } : undefined;
                    const fullRange = range ? {
                        start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
                        end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
                    } : undefined;
                    
                    pack.diagnostics.push({
                        code: 'META_REF_TRAVERSAL',
                        message: `Meta-reference contains directory traversal which is not allowed: "${parsed.filePart}"`,
                        severity: 'error',
                        file: parentDoc.filePath,
                        range: fullRange
                    });
                    
                    const origin: Origin = {
                        via: 'direct',
                        file: parentDoc.filePath,
                        authoring: {
                            kind: 'scalar',
                            scalarType: 'string',
                            raw: val
                        },
                        fullRange
                    };
                    return createPScalar(val, origin);
                }

                // Use the original resolveMetaRef - it will use our enhanced findInRegistry
                const resolved = resolveMetaRef(val, pack, parentDoc, node);
                
                // Don't rewrite "skipped" into "meta" - only wrap if actually resolved
                if (resolved.origin?.via === 'meta-skipped') {
                    return resolved;
                }
                
                const metaSite = {
                    file: parentDoc.filePath,
                    range: node.range ? { start: node.range[0], end: node.range[1] } : undefined,
                    kind: 'scalar' as const,
                    raw: String(node.value)
                };

                const metaOrigin: Origin = {
                    ...resolved.origin,
                    via: 'meta',
                    metaSite
                };

                if (resolved.kind === 'scalar') return { ...resolved, origin: metaOrigin };
                if (resolved.kind === 'seq') return { ...resolved, origin: metaOrigin };
                if (resolved.kind === 'map') return { ...resolved, origin: metaOrigin };
            }
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
                                
                                const confidence = getMetaRefConfidence(refCandidate);
                                if (confidence !== 'unlikely_ref') {
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
                            
                            const confidence = getMetaRefConfidence(refCandidate);
                            if (confidence !== 'unlikely_ref') {
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
                const raw = refPart.startsWith('$') ? refPart : ('$' + refPart);
                const resolved = resolveMetaRef(raw, pack, parentDoc, item);

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
    // Base origin for all meta refs (defaults to meta-skipped)
    const range = node?.range ? { start: node.range[0], end: node.range[1] } : undefined;
    const baseOrigin: Origin = {
        via: 'meta-skipped',
        file: parentDoc.filePath,
        authoring: {
            kind: 'scalar',
            scalarType: 'string',
            raw: ref
        },
        fullRange: range ? {
            start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
            end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
        } : undefined
    };

    // Reuse parseMetaRefCandidate for consistent behavior
    const parsed = parseMetaRefCandidate(ref);
    if (!parsed) {
        // If parsing fails, return meta-skipped literal
        return createPScalar(ref, baseOrigin);
    }

    // Security: reject Windows absolute paths entirely
    if (parsed.looksWindowsAbs) {
        const fullRange = range ? {
            start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
            end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
        } : undefined;
        
        pack.diagnostics.push({
            code: 'META_REF_TRAVERSAL',
            message: `Meta-reference contains absolute path which is not allowed: "${parsed.filePart}"`,
            severity: 'error',
            file: parentDoc.filePath,
            range: fullRange
        });
        
        return createPScalar(ref, baseOrigin);
    }

    // Security: block directory traversal attempts
    if (hasDirectoryTraversal(parsed.filePart)) {
        const fullRange = range ? {
            start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
            end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
        } : undefined;
        
        pack.diagnostics.push({
            code: 'META_REF_TRAVERSAL',
            message: `Meta-reference contains directory traversal which is not allowed: "${parsed.filePart}"`,
            severity: 'error',
            file: parentDoc.filePath,
            range: fullRange
        });
        
        return createPScalar(ref, baseOrigin);
    }

    if (!pack || !pack.registry) return createPScalar(ref, baseOrigin);

    // Get confidence level to decide resolution strategy
    const confidence = getMetaRefConfidence(ref);
    
    // Always attempt registry resolution first
    const registryResult = attemptRegistryResolution(parsed.filePart, pack, parentDoc.filePath);
    
    if (registryResult.ambiguous) {
        pack.diagnostics.push({
            code: 'META_REF_AMBIGUOUS',
            message: `Ambiguous meta-reference "${parsed.filePart}". Multiple files match.`,
            severity: 'error',
            file: parentDoc.filePath,
            range: baseOrigin.fullRange
        });
        return createPScalar(ref, baseOrigin);
    }

    if (registryResult.docs.length > 0) {
        const doc = registryResult.docs[0];
        let current: Node | null | undefined = doc.doc.contents as any;
        for (const part of parsed.pathInFile) {
            let next: Node | null | undefined;
            if (isMap(current)) next = (current as any).get(part, true) as any;
            else if (isSeq(current) && /^\d+$/.test(part)) next = (current as any).items[parseInt(part, 10)];

            if (next === undefined || next === null) {
                pack.diagnostics.push({
                    code: 'META_REF_PATH_MISSING',
                    message: `Path "${parsed.pathInFile.join('.')}" not found in meta file.`,
                    severity: 'error',
                    file: parentDoc.filePath,
                    range: baseOrigin.fullRange
                });
                return createPScalar(ref, baseOrigin);
            }
            current = next;
        }

        const resolved = resolveValue(current, pack, doc);
        const metaSiteKind = node ? 
            (isScalar(node) ? 'scalar' : isMap(node) ? 'map' : isSeq(node) ? 'seq' : 'scalar') : 
            'scalar';
        return markAsMetaDerived(resolved, parentDoc.filePath, range, String(node?.value || ref), metaSiteKind);
    }

    // If not found in registry, decide whether to attempt filesystem fallback
    if (confidence === 'definitely_ref') {
        // Try filesystem fallback for definite refs
        const fsRes = tryFilesystemFallback(parsed.filePart, pack, parentDoc);
        
        if (fsRes.kind === "ambiguous") {
            pack.diagnostics.push({
                code: 'META_REF_AMBIGUOUS',
                message: `Ambiguous meta-reference "${parsed.filePart}". Multiple files match:\n` +
                         fsRes.candidates.slice(0, 5).join("\n") + (fsRes.candidates.length > 5 ? "\n..." : ""),
                severity: 'error',
                file: parentDoc.filePath,
                range: baseOrigin.fullRange
            });
            return createPScalar(ref, baseOrigin);
        }
        
        if (fsRes.kind === "found") {
            const fallbackDoc = fsRes.doc;
            let current: Node | null | undefined = fallbackDoc.doc.contents as any;
            for (const part of parsed.pathInFile) {
                let next: Node | null | undefined;
                if (isMap(current)) next = (current as any).get(part, true) as any;
                else if (isSeq(current) && /^\d+$/.test(part)) next = (current as any).items[parseInt(part, 10)];

                if (next === undefined || next === null) {
                    pack.diagnostics.push({
                        code: 'META_REF_PATH_MISSING',
                        message: `Path "${parsed.pathInFile.join('.')}" not found in meta file.`,
                        severity: 'error',
                        file: parentDoc.filePath,
                        range: baseOrigin.fullRange
                    });
                    return createPScalar(ref, baseOrigin);
                }
                current = next;
            }

            const resolved = resolveValue(current, pack, fallbackDoc);
            const metaSiteKind = node ? 
                (isScalar(node) ? 'scalar' : isMap(node) ? 'map' : isSeq(node) ? 'seq' : 'scalar') : 
                'scalar';
            return markAsMetaDerived(resolved, parentDoc.filePath, range, String(node?.value || ref), metaSiteKind);
        }

        // For definite refs that we couldn't resolve, report missing file
        pack.diagnostics.push({
            code: 'META_REF_FILE_MISSING',
            message: `Meta file "${parsed.filePart}" not found.`,
            severity: 'error',
            file: parentDoc.filePath,
            range: baseOrigin.fullRange
        });
        return createPScalar(ref, baseOrigin);
    }

    // For probably refs that failed registry resolution, attempt filesystem fallback
    // only if it looks file-like to avoid expensive disk scanning
    if (confidence === 'probably_ref') {
        // Only try filesystem fallback if it looks file-like or is meta.yml/meta.yaml
        if (isFileLikePath(parsed.filePart) || parsed.filePart === 'meta.yml' || parsed.filePart === 'meta.yaml') {
            const fsRes = tryFilesystemFallback(parsed.filePart, pack, parentDoc);
            
            if (fsRes.kind === "ambiguous") {
                pack.diagnostics.push({
                    code: 'META_REF_AMBIGUOUS',
                    message: `Ambiguous meta-reference "${parsed.filePart}". Multiple files match:\n` +
                             fsRes.candidates.slice(0, 5).join("\n") + (fsRes.candidates.length > 5 ? "\n..." : ""),
                    severity: 'error',
                    file: parentDoc.filePath,
                    range: baseOrigin.fullRange
                });
                return createPScalar(ref, baseOrigin);
            }
            
            if (fsRes.kind === "found") {
                const fallbackDoc = fsRes.doc;
                let current: Node | null | undefined = fallbackDoc.doc.contents as any;
                for (const part of parsed.pathInFile) {
                    let next: Node | null | undefined;
                    if (isMap(current)) next = (current as any).get(part, true) as any;
                    else if (isSeq(current) && /^\d+$/.test(part)) next = (current as any).items[parseInt(part, 10)];

                    if (next === undefined || next === null) {
                        pack.diagnostics.push({
                            code: 'META_REF_PATH_MISSING',
                            message: `Path "${parsed.pathInFile.join('.')}" not found in meta file.`,
                            severity: 'error',
                            file: parentDoc.filePath,
                            range: baseOrigin.fullRange
                        });
                        return createPScalar(ref, baseOrigin);
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
        
        // For probably refs that failed all resolution attempts, treat as literal
        return createPScalar(ref, baseOrigin);
    }

    // For unlikely refs, treat as literal with meta-skipped
    return createPScalar(ref, baseOrigin);
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
        // Try exact match first with secure resolution
        let fullPath = securePathResolve(root, filePath);
        if (fullPath && existsSync(fullPath) && (fullPath.endsWith('.yml') || fullPath.endsWith('.yaml'))) {
            foundFiles.push({path: fullPath, root});
        }
        
        // Try with .yml extension
        if (!filePath.endsWith('.yml') && !filePath.endsWith('.yaml')) {
            fullPath = securePathResolve(root, filePath + '.yml');
            if (fullPath && existsSync(fullPath)) {
                foundFiles.push({path: fullPath, root});
            }
            
            // Try with .yaml extension
            fullPath = securePathResolve(root, filePath + '.yaml');
            if (fullPath && existsSync(fullPath)) {
                foundFiles.push({path: fullPath, root});
            }
        }
    }
    
    // Check for ambiguity
    if (foundFiles.length > 1) {
        return { 
            kind: "ambiguous", 
            candidates: foundFiles.map(f => {
                if (f.root === pack.rootPath) {
                    // File is in pack root - show relative to pack root
                    return path.relative(pack.rootPath, f.path);
                } else {
                    // File is in include path - show include-relative path with label
                    const includeName = path.basename(f.root);
                    const relativeToInclude = path.relative(f.root, f.path);
                    return `include(${includeName})/${relativeToInclude}`;
                }
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

