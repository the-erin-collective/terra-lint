import { ParsedYaml } from '../parser/yaml.js';
import { isMap, isScalar, isSeq } from 'yaml';
import { resolveValue } from './resolver.js';
import { PValue, PMap, createPMap } from './pvalue/types.js';
import type { Pack } from './pack.js';

export interface ConfigObject {
    type: string;
    id: string;
    extends?: string | string[];
    parsedYaml: ParsedYaml;
    node: any; // The YAML map node
}

export class Registry {
    // Map<Type, Map<ID, ConfigObject>>
    private byType = new Map<string, Map<string, ConfigObject>>();
    private allDocs = new Map<string, ParsedYaml>();

    addParsedDoc(doc: ParsedYaml, pack: Pack) {
        this.allDocs.set(doc.filePath, doc);

        const root = doc.doc.contents;
        if (isMap(root)) {
            const typeNode = root.get('type', true);
            const idNode = root.get('id', true);

            if (isScalar(typeNode) && isScalar(idNode)) {
                const typeStr = String(typeNode.value).toUpperCase();
                const idStr = String(idNode.value);
                const idKey = idStr.toUpperCase();

                let typeMap = this.byType.get(typeStr);
                if (!typeMap) {
                    typeMap = new Map();
                    this.byType.set(typeStr, typeMap);
                }

                if (typeMap.has(idKey)) {
                    const existing = typeMap.get(idKey)!;
                    pack.diagnostics.push({
                        code: 'DUPLICATE_ID',
                        message: `Duplicate ID "${idStr}" for type "${typeStr}". Already defined in ${existing.parsedYaml.filePath}`,
                        severity: 'error',
                        file: doc.filePath,
                        range: idNode.range ? {
                            start: { ...doc.lineCounter.linePos(idNode.range[0]), offset: idNode.range[0] },
                            end: { ...doc.lineCounter.linePos(idNode.range[1]), offset: idNode.range[1] }
                        } : undefined
                    });
                }

                const obj: ConfigObject = {
                    type: typeStr,
                    id: idStr, // Original casing
                    parsedYaml: doc,
                    node: root
                };

                const extNode = root.get('extends', true);
                if (extNode) {
                    if (isScalar(extNode)) {
                        obj.extends = String(extNode.value);
                    } else if (isSeq(extNode)) {
                        obj.extends = (extNode as any).items.map((item: any) => isScalar(item) ? String(item.value) : '').filter(Boolean);
                    }
                }

                typeMap.set(idKey, obj);
            }
        }
    }

    getObjectsByType(type: string): ConfigObject[] {
        const typeMap = this.byType.get(type.toUpperCase());
        return typeMap ? Array.from(typeMap.values()) : [];
    }

    getObject(type: string, id: string): ConfigObject | undefined {
        return this.byType.get(type.toUpperCase())?.get(id.toUpperCase());
    }

    getEffectiveObject(type: string, id: string, pack: Pack, seen = new Map<string, string>()): PMap | undefined {
        const typeUpper = type.toUpperCase();
        const idUpper = id.toUpperCase();
        const key = `${typeUpper}:${idUpper}`;
        const obj = this.getObject(type, id);

        if (!obj) return undefined;

        if (seen.has(key)) {
            const chain = Array.from(seen.values()).concat(obj.id).join(' -> ');
            throw new Error(`Circular inheritance detected: ${chain}`);
        }
        seen.set(key, obj.id);

        try {
            const combinedItems = new Map<string, PValue>();

            if (obj.extends) {
                const extNode = obj.node.get('extends', true);
                const parentIds = Array.isArray(obj.extends) ? obj.extends : [obj.extends];

                // Terra Semantics: earlier extends have higher priority
                // We merge in reverse order so earlier ones overwrite later ones
                for (let i = parentIds.length - 1; i >= 0; i--) {
                    const parentId = parentIds[i];
                    const parentEffective = this.getEffectiveObject(type, parentId, pack, seen);

                    if (parentEffective && parentEffective.kind === 'map') {
                        for (const [k, v] of parentEffective.entries) {
                            combinedItems.set(k, v);
                        }
                    } else {
                        // Attempt to find range of the specific parentId in YAML in case of missing target
                        let range = undefined;
                        if (extNode) {
                            if (isScalar(extNode) && String(extNode.value) === parentId) {
                                range = extNode.range;
                            } else if (isSeq(extNode)) {
                                const item = (extNode as any).items[i];
                                if (item && isScalar(item)) range = item.range;
                            }
                        }

                        // Only report if we absolutely can't find it (and it wasn't just not a map)
                        if (!parentEffective) {
                            pack.diagnostics.push({
                                code: 'EXTENDS_TARGET_MISSING',
                                message: `Inheritance target "${parentId}" of type "${typeUpper}" not found.`,
                                severity: 'error',
                                file: obj.parsedYaml.filePath,
                                range: range ? {
                                    start: { ...obj.parsedYaml.lineCounter.linePos(range[0]), offset: range[0] },
                                    end: { ...obj.parsedYaml.lineCounter.linePos(range[1]), offset: range[1] }
                                } : undefined
                            });
                        }
                    }
                }
            }

            // Resolve the current object's values
            const currentResolved = resolveValue(obj.node, pack, obj.parsedYaml);

            // Priority Shadowing: child values overwrite parents entirely (shallow merge)
            if (currentResolved.kind === 'map') {
                // Only filter out 'extends' from meta keys - keep 'id' and 'type' for schema validation
                const META_KEYS = new Set(['extends']);
                for (const [k, v] of currentResolved.entries) {
                    if (!META_KEYS.has(k)) {
                        combinedItems.set(k, v);
                    }
                }
            }

            // Return new PMap with provenance pointing to the definition of this object
            // The items inside retain their own origins
            return createPMap(combinedItems, {
                file: obj.parsedYaml.filePath,
                range: obj.node.range ? { start: obj.node.range[0], end: obj.node.range[1] } : undefined,
                fullRange: obj.node.range ? {
                    start: { ...obj.parsedYaml.lineCounter.linePos(obj.node.range[0]), offset: obj.node.range[0] },
                    end: { ...obj.parsedYaml.lineCounter.linePos(obj.node.range[1]), offset: obj.node.range[1] }
                } : undefined
            });

        } finally {
            seen.delete(key);
        }
    }

    getAllDocs(): ParsedYaml[] {
        return Array.from(this.allDocs.values());
    }
}
