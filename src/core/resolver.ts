import { isMap, isScalar, isSeq, Node, isAlias } from 'yaml';
import * as path from 'path';
import * as fs from 'fs';
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
        
        // Contains YAML extension -> definitely file-like
        if (hasYamlExtension(ref)) {
            return "definitely_ref";
        }
        
        // Contains colon - check if left side looks file-like
        if (ref.includes(':')) {
            const lhs = ref.split(':', 1)[0];
            const lhsLower = lhs.toLowerCase();
            // YAML extension on left side = definitely file-like (common Terra pattern)
            if (hasYamlExtension(lhs) || lhsLower === 'meta.yml' || lhsLower === 'meta.yaml') {
                return "definitely_ref";
            }
            // If left side has path separators, it's likely a file path
            if (lhs.includes('/') || lhs.includes('\\')) {
                return "probably_ref";
            }
            return "unlikely_ref"; // namespaced ids like minecraft:stone
        }
        
        // Special case: bare "meta" without extension - treat as probably_ref (shorthand for meta.yml)
        if (ref.toLowerCase() === 'meta') {
            return "probably_ref";
        }
        
        // Be more conservative with slashes - only treat as definitely if also has yml/yaml extension
        if (ref.includes('/') || ref.includes('\\')) {
            if (ref.endsWith('.yml') || ref.endsWith('.yaml')) {
                return "definitely_ref";
            }
            return "probably_ref"; // Has path separators but no extension - probably a file
        }
        
        // Only treat as probably if it has clear file indicators
        if (ref.includes('.')) {
            // Only treat as probably if it has path separators or ends with yml/yaml
            if (ref.includes('/') || ref.includes('\\') || hasYamlExtension(ref)) {
                return "probably_ref";
            }
            return "unlikely_ref"; // Likely version numbers, domain-like IDs, dotted identifiers
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

// Helper function to detect YAML file extensions (strict matching)
function hasYamlExtension(s: string): boolean {
    const t = s.toLowerCase();
    return t.endsWith('.yml') || t.endsWith('.yaml');
}

// Helper function to normalize file paths for consistent matching
function normalizeFilePath(filePath: string): string {
    // Convert to forward slashes for consistency
    let normalized = filePath.replace(/\\/g, '/');
    
    // Collapse multiple slashes to single slash
    normalized = normalized.replace(/\/+/g, '/');
    
    // Remove ./ segments (but keep ../ for security checks)
    normalized = normalized.replace(/\/\.\//g, '/');
    
    // Remove leading ./ if present
    if (normalized.startsWith('./')) {
        normalized = normalized.substring(2);
    }
    
    return normalized;
}

// Helper function to detect and block dangerous directory traversal
function hasDirectoryTraversal(p: string): boolean {
    // Normalize path separators and check for dangerous segments
    const norm = p.replace(/\\/g, '/');
    const segs = norm.split('/');
    return segs.some(seg => 
        seg === '..' ||           // Directory traversal (dangerous)
        seg.includes('\0')        // Null bytes (defensive)
    );
    // Note: We allow '.' and empty segments ('') as they're common in legit paths
    // and are handled safely by our containment checks
}

// Helper function to get a safe candidate path (may not exist)
// Returns a path that is guaranteed to be under the root, but caller must check existence
function getSafeCandidatePath(root: string, filePath: string): string | null {
    try {
        const rootAbs = path.resolve(root);
        const candidate = path.resolve(rootAbs, filePath);

        // Block path traversal by lexical containment first
        if (!isUnder(candidate, rootAbs)) return null;

        // If it doesn't exist yet, we can still safely return candidate
        if (!fs.existsSync(candidate)) return candidate;

        // If it exists, harden against symlink escapes
        const rootReal = fs.realpathSync(rootAbs);
        const candReal = fs.realpathSync(candidate);
        if (!isUnder(candReal, rootReal)) return null;

        return candidate;
    } catch {
        return null;
    }
}

// Helper function to check if a path is under another path (cross-platform safe)
function isUnder(childPath: string, parentPath: string): boolean {
    const childAbs = path.resolve(childPath);
    const parentAbs = path.resolve(parentPath);
    
    // Use path.relative for cross-platform safe containment check
    const rel = path.relative(parentAbs, childAbs);
    
    // It's under if:
    // - Is empty (same path) OR
    // - Doesn't start with '..' or '..' + separator
    // - Is not '..' (parent directory)
    // - Is not absolute (path.relative would return absolute for completely different drives)
    return rel === '' || 
           (!rel.startsWith('..' + path.sep) && 
            rel !== '..' && 
            !path.isAbsolute(rel));
}

// Helper function to find in registry with directory traversal for meta.yml
function findInRegistry(filePart: string, pack: Pack, currentFilePath?: string): { docs: ParsedYaml[], ambiguous: boolean } {
    const allDocs = pack.registry.getAllDocs();
    const normalizedSearch = filePart.replace(/\\/g, '/').toLowerCase();

    // If we have a current file path and looking for meta.yml or meta.yaml, walk up the directory tree
    const fpLower = filePart.toLowerCase();
    if (currentFilePath && (fpLower === 'meta.yml' || fpLower === 'meta.yaml')) {
        // Find which root contains the current file
        const rootsToConsider = [pack.rootPath, ...pack.includePaths];
        const currentFileAbs = path.resolve(currentFilePath);
        
        const ownerRoot = rootsToConsider.find(root => isUnder(currentFileAbs, root));
        
        if (ownerRoot) {
            let currentDir = path.dirname(currentFileAbs);
            const ownerRootAbs = path.resolve(ownerRoot);
            
            // Use canonical filename for joining
            const canonicalFileName = fpLower === 'meta.yml' ? 'meta.yml' : 'meta.yaml';
            
            // Walk up until we reach the owning root using safe containment checks
            while (isUnder(currentDir, ownerRootAbs)) {
                const localMetaPath = path.join(currentDir, canonicalFileName);
                const localMetaPathAbs = path.resolve(localMetaPath);
                
                // Check if this document is the meta.yml we're looking for
                const matchingDocs = allDocs.filter(d => path.resolve(d.filePath).toLowerCase() === localMetaPathAbs.toLowerCase());
                
                if (matchingDocs.length > 0) {
                    return { docs: matchingDocs, ambiguous: matchingDocs.length > 1 };
                }
                
                // Move up to parent directory
                const parentDir = path.dirname(currentDir);
                if (parentDir === currentDir) break; // Reached root
                currentDir = parentDir;
            }
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

            const matches = allDocs.filter(d => {
                const dfp = path.resolve(d.filePath);
                
                // Skip docs that aren't under this root
                if (!isUnder(dfp, rootAbs)) return false;
                
                // Use path.relative for robust cross-platform path computation
                const relative = path.relative(rootAbs, dfp);
                const normalizedRelative = relative.replace(/\\/g, '/').toLowerCase();
                
                if (tier.type === 'exact') {
                    return normalizedRelative === normalizedSearch;
                } else {
                    return normalizedRelative === normalizedSearch
                        || normalizedRelative.endsWith('/' + normalizedSearch);
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
function parseMetaRefCandidate(raw: string): { filePart: string; pathInFile: string[]; hasColon: boolean; looksWindowsAbs: boolean; hasMultipleColons: boolean } | null {
    if (!raw.startsWith('$')) return null;
    
    let pathStr = raw.substring(1);
    if (pathStr.startsWith('{') && pathStr.endsWith('}')) pathStr = pathStr.substring(1, pathStr.length - 1);

    // Handle Windows absolute paths like C:\... - don't split on colon there
    if (/^[A-Za-z]:[\\/]/.test(pathStr)) {
        return {
            filePart: pathStr,
            pathInFile: [],
            hasColon: false,
            looksWindowsAbs: true,
            hasMultipleColons: false
        };
    }

    // Check for multiple colons (unusual in Terra)
    const colonCount = (pathStr.match(/:/g) || []).length;
    const hasMultipleColons = colonCount > 1;

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
        filePart: filePath, // Keep original for security checks, normalize later
        pathInFile,
        hasColon,
        looksWindowsAbs: false,
        hasMultipleColons
    };
}

export function resolveValue(
    node: Node | null | undefined,
    pack: Pack,
    parentDoc: ParsedYaml,
    fieldPath: string[] = [],
    aliasDepth: number = 0
): PValue {
    // Prevent infinite recursion from alias cycles
    if (aliasDepth > 50) {
        const origin: Origin = {
            via: 'direct',
            file: parentDoc.filePath,
            authoring: {
                kind: 'scalar',
                scalarType: 'string',
                raw: '[ALIAS_CYCLE]'
            },
            fullRange: node?.range ? {
                start: { ...parentDoc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                end: { ...parentDoc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
            } : undefined
        };
        
        pack.diagnostics.push({
            code: 'ALIAS_CYCLE',
            message: 'Alias cycle detected: maximum alias resolution depth exceeded',
            severity: 'error',
            file: parentDoc.filePath,
            range: origin.fullRange
        });
        
        return createPScalar('[ALIAS_CYCLE]', origin);
    }

    // Handle YAML aliases by resolving them first
    if (node && isAlias(node)) {
        return resolveValue(node.resolve(parentDoc.doc), pack, parentDoc, fieldPath, aliasDepth + 1);
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

        // Terra MetaString: ${ref}
        if (val.includes('${')) {
            const regex = /\${([^}]+)}/g;
            let out = "";
            let last = 0;
            let match;
            let didResolveAny = false;
            
            while ((match = regex.exec(val)) !== null) {
                const ref = match[1].trim();
                const rawRef = ref.startsWith('$') ? ref : '$' + ref;
                const metaSiteRaw = '${' + ref + '}';
                
                // Guard: only resolve references with sufficient confidence
                const confidence = getMetaRefConfidence(rawRef);
                if (confidence === 'unlikely_ref') {
                    // If it's unlikely to be a ref, treat it as literal text
                    // But add a warning if it looks like it was intended to be a file ref
                    if (ref.includes('/') || ref.includes('.') || ref.toLowerCase().includes('meta')) {
                        pack.diagnostics.push({
                            code: 'META_STRING_NON_FILE_REF',
                            message: `MetaString reference "${ref}" doesn't look like a file/path reference and was not resolved.`,
                            severity: 'warning',
                            file: parentDoc.filePath,
                            range: origin.fullRange
                        });
                    }
                    
                    out += val.slice(last, match.index);
                    out += '${' + ref + '}';
                    last = match.index + match[0].length;
                    continue;
                }

                // Create interpolation range object for accurate diagnostics
                const interpSite: RangeLike = node.range
                    ? { range: [node.range[0] + match.index, node.range[0] + match.index + match[0].length] }
                    : { range: null };

                const resolved = resolveMetaRef(rawRef, pack, parentDoc, interpSite, metaSiteRaw);
                
                // Don't rewrite "skipped" into "meta" - only wrap if actually resolved
                if (resolved.origin?.via === 'meta-skipped') {
                    out += val.slice(last, match.index);
                    out += '${' + ref + '}';
                    last = match.index + match[0].length;
                    continue;
                }

                // Mark that we actually resolved something
                didResolveAny = true;

                // For successful resolution, use the actual ref as metaSiteRaw (already declared above)
                
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
            
            // Only mark as interpolated/meta if we actually resolved something
            if (didResolveAny) {
                const interpolatedVal = out.replace(/\r?\n/g, ' ').trim();

                // Validate expressions in interpolated strings
                if (isExpressionField) {
                    const exprRes = validateExpression(interpolatedVal);
                    if (!exprRes.isValid) {
                        const isStrictExprContext = pathStr.includes('.palette') || pathStr.includes('.slant');
                        if (exprRes.errors && exprRes.errors.length > 0) {
                            for (const err of exprRes.errors) {
                                // For interpolated strings, use full range instead of trying to map sub-ranges
                                // because interpolation changes character positions
                                pack.diagnostics.push({
                                    code: 'EXPR_SYNTAX_ERROR',
                                    message: `Syntax Error: ${err.message} (at expression offset ${err.range.start}-${err.range.end})`,
                                    severity: isStrictExprContext ? 'error' : 'warning',
                                    file: parentDoc.filePath,
                                    range: origin.fullRange
                                });
                            }
                        } else {
                            pack.diagnostics.push({
                                code: 'MALFORMED_EXPRESSION',
                                message: exprRes.message || `Malformed expression: "${interpolatedVal}"`,
                                severity: isStrictExprContext ? 'error' : 'warning',
                                file: parentDoc.filePath,
                                range: origin.fullRange
                            });
                        }
                    }
                }

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
                        scalarType: typeof interpolatedVal === 'string' ? 'string' :
                                    typeof interpolatedVal === 'number' ? 'number' :
                                    typeof interpolatedVal === 'boolean' ? 'boolean' :
                                    interpolatedVal === null ? 'null' : 'unknown',
                        raw: interpolatedVal
                    }
                };

                // Enhanced numeric parsing to match scalar handling (supports underscores and exponents)
                if (/^[\d_]+(\.[\d_]+)?([eE][+-]?[\d_]+)?$/.test(interpolatedVal)) {
                    const normalized = interpolatedVal.replace(/_/g, '');
                    if (!isNaN(Number(normalized))) {
                        const numericVal = Number(normalized);
                        const numericOrigin: Origin = {
                            ...metaStringOrigin,
                            authoring: {
                                ...metaStringOrigin.authoring!,
                                scalarType: 'number',
                                raw: interpolatedVal
                            }
                        };
                        return createPScalar(numericVal, numericOrigin);
                    }
                }
                return createPScalar(interpolatedVal, metaStringOrigin);
            } else {
                // Nothing resolved, return original scalar unchanged (preserve original type)
                return createPScalar(node.value, origin);
            }
        }

        // Terra MetaValue: $ref (entire scalar)
        if (val.startsWith('$')) {
            // Use the original resolveMetaRef - it will handle security checks
            const resolved = resolveMetaRef(val, pack, parentDoc, toRangeLike(node));
            
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

        // Numeric underscores
        if (/^[\d_]+(\.[\d_]+)?([eE][+-]?[\d_]+)?$/.test(val) && val.includes('_')) {
            const normalized = val.replace(/_/g, '');
            if (!isNaN(Number(normalized))) {
                return createPScalar(Number(normalized), origin);
            }
        }

        // Field-Aware Validation
        if (isExpressionField) {
            const exprRes = validateExpression(val);
            if (!exprRes.isValid) {
                const isStrictExprContext = pathStr.includes('.palette') || pathStr.includes('.slant');
                if (exprRes.errors && exprRes.errors.length > 0) {
                    for (const err of exprRes.errors) {
                        let absRange = undefined;
                        if (node.range) {
                            const startOffset = node.range[0] + err.range.start;
                            const endOffset = node.range[0] + err.range.end;
                            absRange = {
                                start: { ...parentDoc.lineCounter.linePos(startOffset), offset: startOffset },
                                end: { ...parentDoc.lineCounter.linePos(endOffset), offset: endOffset }
                            };
                        }
                        const message = `Syntax Error: ${err.message}`;
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
                                    mergeSources.push({source: resolveMetaRef(refCandidate, pack, parentDoc, toRangeLike(item, 'scalar')), node: item as Node});
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
                                mergeSources.push({source: resolveValue(item as Node, pack, parentDoc, fieldPath, aliasDepth), node: item as Node});
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
                                mergeSources.push({source: resolveMetaRef(refCandidate, pack, parentDoc, toRangeLike(mergeValue, 'scalar')), node: mergeValue});
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
                            mergeSources.push({source: resolveValue(mergeValue as Node, pack, parentDoc, fieldPath, aliasDepth), node: mergeValue});
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
            const resolved = resolveValue(value as Node, pack, parentDoc, [...fieldPath, keyStr], aliasDepth);
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
                const resolved = resolveMetaRef(raw, pack, parentDoc, toRangeLike(item, 'seq'));

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
                        resolved = resolveMetaRef(ref, pack, parentDoc, toRangeLike(valNode, 'map'));
                    } else {
                        resolved = resolveValue(valNode as Node, pack, parentDoc, fieldPath, aliasDepth);
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

            items.push(resolveValue(item as Node, pack, parentDoc, [...fieldPath, '[]'], aliasDepth));
        }
        return createPSeq(items, origin);
    }

    return createPScalar(undefined, defaultOrigin);
}

// Helper type for range-only objects (not full YAML Nodes)
type RangeTuple = readonly [number, number, number?];
type RangeLike = { range?: RangeTuple | null; kind?: 'scalar' | 'seq' | 'map' };

// Helper function to convert Node to RangeLike with site kind detection
function toRangeLike(node?: Node | null, kind?: 'scalar' | 'seq' | 'map'): RangeLike {
    return { 
        range: node?.range ? [node.range[0], node.range[1], node.range[2]] : null,
        kind: kind || 'scalar'
    };
}

export function resolveMetaRef(ref: string, pack: Pack, parentDoc: ParsedYaml, node?: RangeLike, metaSiteRaw?: string): PValue {
    // Quick confidence check to avoid unnecessary cycle bookkeeping
    const confidence = getMetaRefConfidence(ref);
    if (confidence === 'unlikely_ref') {
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
        return createPScalar(ref, baseOrigin);
    }

    // Parse for cycle detection
    const parsed = parseMetaRefCandidate(ref);
    if (!parsed) {
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
        return createPScalar(ref, baseOrigin);
    }

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

    // Security: reject all absolute paths (Windows, Unix, UNC)
    if (parsed.looksWindowsAbs || 
        path.isAbsolute(parsed.filePart) || 
        parsed.filePart.startsWith('\\\\') || 
        parsed.filePart.startsWith('//')) {
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

    // Warn about unusual multiple colon patterns
    if (parsed.hasMultipleColons) {
        const fullRange = range ? {
            start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
            end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
        } : undefined;
        
        pack.diagnostics.push({
            code: 'META_REF_MULTIPLE_COLONS',
            message: `Meta-reference "${ref}" contains multiple colons, which is unusual in Terra. Only the first colon is used for file/path separation.`,
            severity: 'warning',
            file: parentDoc.filePath,
            range: fullRange
        });
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

    // Normalize file path for consistent matching (after security checks)
    const normalizedFilePart = normalizeFilePath(parsed.filePart);

    if (!pack || !pack.registry) return createPScalar(ref, baseOrigin);
    
    // Always attempt registry resolution first
    const registryResult = attemptRegistryResolution(normalizedFilePart, pack, parentDoc.filePath);
    
    if (registryResult.ambiguous) {
        // Build candidate list for registry ambiguity
        const candidates = registryResult.docs.slice(0, 5).map(doc => {
            const docPath = doc.filePath;
            // Show relative to pack root or include path using safe containment checks
            if (isUnder(docPath, pack.rootPath)) {
                return path.relative(pack.rootPath, docPath);
            } else {
                // Find deepest matching include root for deterministic behavior
                let bestIncludeRoot = null;
                let bestIncludeRootLength = -1;
                
                for (const root of pack.includePaths) {
                    if (isUnder(docPath, root) && root.length > bestIncludeRootLength) {
                        bestIncludeRoot = root;
                        bestIncludeRootLength = root.length;
                    }
                }
                
                if (bestIncludeRoot) {
                    const includeName = path.basename(bestIncludeRoot);
                    return `include(${includeName})/${path.relative(bestIncludeRoot, docPath)}`;
                }
                return docPath;
            }
        });
        
        pack.diagnostics.push({
            code: 'META_REF_AMBIGUOUS',
            message: `Meta-reference "${parsed.filePart}" is ambiguous. Multiple files match:\n` +
                     candidates.join("\n") + (registryResult.docs.length > 5 ? "\n..." : ""),
            severity: 'error',
            file: parentDoc.filePath,
            range: baseOrigin.fullRange
        });
        return createPScalar(ref, baseOrigin);
    }

    if (registryResult.docs.length > 0) {
        const doc = registryResult.docs[0];
        let resolution = resolveFromDoc(doc, parsed.pathInFile, pack);
        
        // For meta.yml files, if path not found in registry version, try parent directories
        if (!resolution.success && normalizedFilePart.toLowerCase() === 'meta.yml') {
            const parentMetaDocs = findParentMetaFiles(normalizedFilePart, pack, parentDoc);
            
            for (const parentDoc of parentMetaDocs) {
                resolution = resolveFromDoc(parentDoc, parsed.pathInFile, pack);
                if (resolution.success) {
                    // Use the parent meta file that worked
                    const cycleKey = `${path.resolve(parentDoc.filePath)}:${parsed.pathInFile.join('.')}`;
                    
                    if (pack.metaRefStack.has(cycleKey)) {
                        const fullRange = range ? {
                            start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
                            end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
                        } : undefined;
                        
                        pack.diagnostics.push({
                            code: 'META_REF_CYCLE',
                            message: `Meta-reference cycle detected: "${ref}" creates a circular reference`,
                            severity: 'error',
                            file: parentDoc.filePath,
                            range: fullRange
                        });
                        
                        return createPScalar(ref, baseOrigin);
                    }
                    
                    pack.metaRefStack.add(cycleKey);
                    
                    try {
                        const metaSiteKind = node?.kind || 'scalar';
                        return markAsMetaDerived(resolution.result!, parentDoc.filePath, range, metaSiteRaw || ref, metaSiteKind);
                    } finally {
                        pack.metaRefStack.delete(cycleKey);
                    }
                }
            }
        }
        
        // Create cycle key from actual resolved target
        const cycleKey = `${path.resolve(doc.filePath)}:${parsed.pathInFile.join('.')}`;
        
        // Check for cycles
        if (pack.metaRefStack.has(cycleKey)) {
            const fullRange = range ? {
                start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
                end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
            } : undefined;
            
            pack.diagnostics.push({
                code: 'META_REF_CYCLE',
                message: `Meta-reference cycle detected: "${ref}" creates a circular reference`,
                severity: 'error',
                file: parentDoc.filePath,
                range: fullRange
            });
            
            return createPScalar(ref, baseOrigin);
        }
        
        // Add to stack for cycle detection
        pack.metaRefStack.add(cycleKey);
        
        try {
            if (!resolution.success) {
                pack.diagnostics.push({
                    code: 'META_REF_PATH_MISSING',
                    message: resolution.error || 'Unknown error',
                    severity: 'error',
                    file: parentDoc.filePath,
                    range: baseOrigin.fullRange
                });
                return createPScalar(ref, baseOrigin);
            }

            const metaSiteKind = node?.kind || 'scalar'; // Use detected site kind or default to scalar
            return markAsMetaDerived(resolution.result!, parentDoc.filePath, range, metaSiteRaw || ref, metaSiteKind);
        } finally {
            // Remove from stack when done (important for proper cycle detection)
            pack.metaRefStack.delete(cycleKey);
        }
    }

    // If not found in registry, decide whether to attempt filesystem fallback
    if (confidence === 'definitely_ref') {
        const fsRes = tryFilesystemFallback(normalizedFilePart, pack, parentDoc);
        
        if (fsRes.kind === "ambiguous") {
            pack.diagnostics.push({
                code: 'META_REF_AMBIGUOUS',
                message: `Meta-reference "${parsed.filePart}" is ambiguous. Multiple files match:\n` +
                         fsRes.candidates.slice(0, 5).join("\n") + (fsRes.candidates.length > 5 ? "\n..." : ""),
                severity: 'error',
                file: parentDoc.filePath,
                range: baseOrigin.fullRange
            });
            return createPScalar(ref, baseOrigin);
        }
        
        if (fsRes.kind === "found") {
            const fallbackDoc = fsRes.doc;
            
            // Create cycle key from actual resolved target
            const cycleKey = `${path.resolve(fallbackDoc.filePath)}:${parsed.pathInFile.join('.')}`;
            
            // Check for cycles
            if (pack.metaRefStack.has(cycleKey)) {
                const fullRange = range ? {
                    start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
                    end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
                } : undefined;
                
                pack.diagnostics.push({
                    code: 'META_REF_CYCLE',
                    message: `Meta-reference cycle detected: "${ref}" creates a circular reference`,
                    severity: 'error',
                    file: parentDoc.filePath,
                    range: fullRange
                });
                
                return createPScalar(ref, baseOrigin);
            }
            
            // Add to stack for cycle detection
            pack.metaRefStack.add(cycleKey);
            
            try {
                const resolution = resolveFromDoc(fallbackDoc, parsed.pathInFile, pack);
                if (!resolution.success) {
                    pack.diagnostics.push({
                        code: 'META_REF_PATH_MISSING',
                        message: resolution.error || 'Unknown error',
                        severity: 'error',
                        file: parentDoc.filePath,
                        range: baseOrigin.fullRange
                    });
                    return createPScalar(ref, baseOrigin);
                }

                const metaSiteKind = node?.kind || 'scalar'; // Use detected site kind or default to scalar
                return markAsMetaDerived(resolution.result!, parentDoc.filePath, range, metaSiteRaw || ref, metaSiteKind);
            } finally {
                // Remove from stack when done (important for proper cycle detection)
                pack.metaRefStack.delete(cycleKey);
            }
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
        // Only try filesystem fallback if it has clear file-like signals
        if (hasYamlExtension(normalizedFilePart) || 
            normalizedFilePart === 'meta.yml' || 
            normalizedFilePart === 'meta.yaml' ||
            normalizedFilePart.includes('/')) {
            const fsRes = tryFilesystemFallback(normalizedFilePart, pack, parentDoc);
            
            if (fsRes.kind === "ambiguous") {
                pack.diagnostics.push({
                    code: 'META_REF_AMBIGUOUS',
                    message: `Meta-reference "${parsed.filePart}" is ambiguous. Multiple files match:\n` +
                             fsRes.candidates.slice(0, 5).join("\n") + (fsRes.candidates.length > 5 ? "\n..." : ""),
                    severity: 'error',
                    file: parentDoc.filePath,
                    range: baseOrigin.fullRange
                });
                return createPScalar(ref, baseOrigin);
            }
            
            if (fsRes.kind === "found") {
                const fallbackDoc = fsRes.doc;
                
                // Create cycle key from actual resolved target
                const cycleKey = `${path.resolve(fallbackDoc.filePath)}:${parsed.pathInFile.join('.')}`;
                
                // Check for cycles
                if (pack.metaRefStack.has(cycleKey)) {
                    const fullRange = range ? {
                        start: { ...parentDoc.lineCounter.linePos(range.start), offset: range.start },
                        end: { ...parentDoc.lineCounter.linePos(range.end), offset: range.end }
                    } : undefined;
                    
                    pack.diagnostics.push({
                        code: 'META_REF_CYCLE',
                        message: `Meta-reference cycle detected: "${ref}" creates a circular reference`,
                        severity: 'error',
                        file: parentDoc.filePath,
                        range: fullRange
                    });
                    
                    return createPScalar(ref, baseOrigin);
                }
                
                // Add to stack for cycle detection
                pack.metaRefStack.add(cycleKey);
                
                try {
                    const resolution = resolveFromDoc(fallbackDoc, parsed.pathInFile, pack);
                    if (!resolution.success) {
                        pack.diagnostics.push({
                            code: 'META_REF_PATH_MISSING',
                            message: resolution.error || 'Unknown error',
                            severity: 'error',
                            file: parentDoc.filePath,
                            range: baseOrigin.fullRange
                        });
                        return createPScalar(ref, baseOrigin);
                    }

                    const metaSiteKind = node?.kind || 'scalar'; // Use detected site kind or default to scalar
                    return markAsMetaDerived(resolution.result!, parentDoc.filePath, range, metaSiteRaw || ref, metaSiteKind);
                } finally {
                    // Remove from stack when done (important for proper cycle detection)
                    pack.metaRefStack.delete(cycleKey);
                }
            }
        }
        
        // For probably refs that failed all resolution attempts, treat as literal with warning
        pack.diagnostics.push({
            code: 'META_REF_PROBABLY_LITERAL',
            message: `Meta-reference "${ref}" was treated as literal. It looked like a file reference but could not be resolved.`,
            severity: 'warning',
            file: parentDoc.filePath,
            range: baseOrigin.fullRange
        });
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

// Helper function to resolve value from a parsed document
function resolveFromDoc(
    doc: ParsedYaml, 
    pathInFile: string[], 
    pack: Pack
): { success: boolean; result?: PValue; error?: string } {
    let current: Node | null | undefined = doc.doc.contents as any;
    for (const part of pathInFile) {
        let next: Node | null | undefined;
        if (isMap(current)) next = (current as any).get(part, true) as any;
        else if (isSeq(current) && /^\d+$/.test(part)) next = (current as any).items[parseInt(part, 10)];

        if (next === undefined || next === null) {
            return { 
                success: false, 
                error: `Path "${pathInFile.join('.')}" not found in meta file.` 
            };
        }
        current = next;
    }

    const resolved = resolveValue(current, pack, doc);
    return { success: true, result: resolved };
}

// Helper function to find meta.yml files in parent directories
function findParentMetaFiles(filePath: string, pack: Pack, parentDoc: ParsedYaml): ParsedYaml[] {
    const results: ParsedYaml[] = [];
    const roots = [pack.rootPath, ...pack.includePaths];
    
    if (filePath.toLowerCase() !== 'meta.yml' && filePath.toLowerCase() !== 'meta.yaml') {
        return results;
    }
    
    const currentFileAbs = path.resolve(parentDoc.filePath);
    const currentDir = path.dirname(currentFileAbs);
    const ownerRoot = roots.find(root => isUnder(currentFileAbs, root));
    
    if (!ownerRoot) return results;
    
    const ownerRootAbs = path.resolve(ownerRoot);
    const canonicalFileName = filePath.toLowerCase();
    
    // Walk up from current directory towards the root, but skip the first level (already tried)
    let searchDir = path.dirname(currentDir); // Start one level up from current dir
    
    while (isUnder(searchDir, ownerRootAbs)) {
        const metaPath = path.join(searchDir, canonicalFileName);
        const metaPathAbs = path.resolve(metaPath);
        
        if (fs.existsSync(metaPathAbs) && (metaPathAbs.toLowerCase().endsWith('.yml') || metaPathAbs.toLowerCase().endsWith('.yaml'))) {
            // Security: Apply symlink hardening before reading
            try {
                const rootReal = fs.realpathSync(ownerRootAbs);
                const candReal = fs.realpathSync(metaPathAbs);
                if (!isUnder(candReal, rootReal)) {
                    // Symlink escape detected, skip this file
                    searchDir = path.dirname(searchDir);
                    continue;
                }
            } catch (e) {
                // Realpath failed, skip this file for safety
                searchDir = path.dirname(searchDir);
                continue;
            }
            
            const { parsed } = parseYaml(fs.readFileSync(metaPathAbs, 'utf8'), metaPathAbs, 'root');
            if (parsed) {
                pack.registry.addParsedDoc(parsed, pack);
                results.push(parsed);
            }
        }
        
        // Move up to parent directory
        const parentDir = path.dirname(searchDir);
        if (parentDir === searchDir) break; // Reached root
        searchDir = parentDir;
    }
    
    return results;
}

// Helper function for filesystem fallback
type FsFallbackResult =
  | { kind: "found"; doc: ParsedYaml }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "missing" };

function tryFilesystemFallback(filePath: string, pack: Pack, parentDoc: ParsedYaml): FsFallbackResult {
    const roots = [pack.rootPath, ...pack.includePaths];
    const foundFiles: Array<{path: string, root: string}> = [];
    
    // Special handling for meta.yml/meta.yaml: walk up directories from current file
    // If found, return immediately to avoid ambiguity with pack root meta files
    const fpLower = filePath.toLowerCase();
    if (fpLower === 'meta.yml' || fpLower === 'meta.yaml') {
        const currentFileAbs = path.resolve(parentDoc.filePath);
        const currentDir = path.dirname(currentFileAbs);
        const ownerRoot = roots.find(root => isUnder(currentFileAbs, root));
        
        if (ownerRoot) {
            const ownerRootAbs = path.resolve(ownerRoot);
            const canonicalFileName = fpLower; // Use lowercase for consistent filesystem lookup
            
            // Walk up until we reach the owning root using safe containment checks
            let searchDir = currentDir;
            while (isUnder(searchDir, ownerRootAbs)) {
                const metaPath = path.join(searchDir, canonicalFileName);
                const metaPathAbs = path.resolve(metaPath);
                
                if (fs.existsSync(metaPathAbs) && (metaPathAbs.toLowerCase().endsWith('.yml') || metaPathAbs.toLowerCase().endsWith('.yaml'))) {
                    // Security: Apply symlink hardening before reading
                    try {
                        const rootReal = fs.realpathSync(ownerRootAbs);
                        const candReal = fs.realpathSync(metaPathAbs);
                        if (!isUnder(candReal, rootReal)) {
                            // Symlink escape detected, skip this file
                            continue;
                        }
                    } catch (e) {
                        // Realpath failed, skip this file for safety
                        continue;
                    }
                    
                    // Found local meta.yml, return immediately to avoid ambiguity
                    const { parsed } = parseYaml(fs.readFileSync(metaPathAbs, 'utf8'), metaPathAbs, 'root');
                    if (parsed) {
                        pack.registry.addParsedDoc(parsed, pack);
                        return { kind: "found", doc: parsed };
                    } else {
                        // File exists but couldn't be parsed
                        let filePathDisplay = path.relative(pack.rootPath, metaPathAbs);
                        // If file came from include path, show include-relative path for clarity
                        if (ownerRoot !== pack.rootPath) {
                            const includeName = path.basename(ownerRoot);
                            const relativeToInclude = path.relative(ownerRoot, metaPathAbs);
                            filePathDisplay = `include(${includeName})/${relativeToInclude}`;
                        }
                        pack.diagnostics.push({
                            code: 'META_REF_READ_FAILED',
                            message: `Meta file "${filePathDisplay}" exists but could not be parsed (empty or invalid YAML)`,
                            severity: 'error',
                            file: parentDoc.filePath,
                            range: undefined
                        });
                        return { kind: "missing" };
                    }
                }
                
                // Move up to parent directory
                const parentDir = path.dirname(searchDir);
                if (parentDir === searchDir) break; // Reached root
                searchDir = parentDir;
            }
        }
    }
    
    // First, collect all potential matches to check for ambiguity
    for (const root of roots) {
        // Try exact match first with secure resolution
        let fullPath = getSafeCandidatePath(root, filePath);
        if (fullPath && fs.existsSync(fullPath) && (fullPath.toLowerCase().endsWith('.yml') || fullPath.toLowerCase().endsWith('.yaml'))) {
            foundFiles.push({path: fullPath, root});
        }
        
        // Try with .yml extension
        if (!fpLower.endsWith('.yml') && !fpLower.endsWith('.yaml')) {
            fullPath = getSafeCandidatePath(root, filePath + '.yml');
            if (fullPath && fs.existsSync(fullPath) && fullPath.toLowerCase().endsWith('.yml')) {
                foundFiles.push({path: fullPath, root});
            }
            
            // Try with .yaml extension
            fullPath = getSafeCandidatePath(root, filePath + '.yaml');
            if (fullPath && fs.existsSync(fullPath) && fullPath.toLowerCase().endsWith('.yaml')) {
                foundFiles.push({path: fullPath, root});
            }
        }
    }
    
    // Deduplicate by resolved absolute path to prevent false ambiguity
    const uniqueFiles = Array.from(new Map(foundFiles.map(f => [path.resolve(f.path), f])).values());
    
    // Check for ambiguity
    if (uniqueFiles.length > 1) {
        return { 
            kind: "ambiguous", 
            candidates: uniqueFiles.map(f => {
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
    
    if (uniqueFiles.length === 0) {
        return { kind: "missing" };
    }
    
    // Load the single found file
    const {path: fullPath} = uniqueFiles[0];
    try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const { parsed } = parseYaml(content, fullPath, 'root');
        if (parsed) {
            pack.registry.addParsedDoc(parsed, pack);
            return { kind: "found", doc: parsed };
        } else {
            // File exists but parsing returned no document
            let filePathDisplay = path.relative(pack.rootPath, fullPath);
            const owningRoot = [pack.rootPath, ...pack.includePaths].find(root => isUnder(fullPath, root));
            if (owningRoot && owningRoot !== pack.rootPath) {
                const includeName = path.basename(owningRoot);
                const relativeToInclude = path.relative(owningRoot, fullPath);
                filePathDisplay = `include(${includeName})/${relativeToInclude}`;
            }
            
            pack.diagnostics.push({
                code: 'META_REF_READ_FAILED',
                message: `Meta file "${filePathDisplay}" exists but could not be parsed (empty or invalid YAML)`,
                severity: 'error',
                file: parentDoc.filePath,
                range: undefined
            });
        }
    } catch (e) {
        // Emit diagnostic for read/parse failure
        let filePathDisplay = path.relative(pack.rootPath, fullPath);
        // If file came from include path, show include-relative path for clarity
        const owningRoot = [pack.rootPath, ...pack.includePaths].find(root => isUnder(fullPath, root));
        if (owningRoot && owningRoot !== pack.rootPath) {
            const includeName = path.basename(owningRoot);
            const relativeToInclude = path.relative(owningRoot, fullPath);
            filePathDisplay = `include(${includeName})/${relativeToInclude}`;
        }
        
        pack.diagnostics.push({
            code: 'META_REF_READ_FAILED',
            message: `Failed to read or parse meta file "${filePathDisplay}": ${e instanceof Error ? e.message : String(e)}`,
            severity: 'error',
            file: parentDoc.filePath,
            range: undefined // No specific range for filesystem errors
        });
    }
    
    return { kind: "missing" };
}


