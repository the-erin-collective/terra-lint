import { ParsedYaml } from '../parser/yaml.js';
import { isMap, isScalar, isSeq } from 'yaml';
import { resolveValue } from './resolver.js';
import { Pack } from './pack.js';

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

    getEffectiveObject(type: string, id: string, pack: Pack, seen = new Map<string, string>()): any {
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
            let base: any = {};
            // Maintain a merged provenance map
            const baseProvenance: Map<string, any> = new Map();
            Object.defineProperty(base, '__terra_provenance', { value: baseProvenance, enumerable: false });

            if (obj.extends) {
                const extNode = obj.node.get('extends', true);
                const parentIds = Array.isArray(obj.extends) ? obj.extends : [obj.extends];
                // Terra Semantics: earlier extends have higher priority for filling blanks
                // This means we should merge them in REVERSE order so earlier ones overwrite later ones
                for (let i = parentIds.length - 1; i >= 0; i--) {
                    const parentId = parentIds[i];
                    const parentEffective = this.getEffectiveObject(type, parentId, pack, seen);
                    if (parentEffective) {
                        // Merge parents: earlier (actually later in reverse loop) overwrite
                        Object.assign(base, parentEffective);

                        // Merge parent provenance
                        if (parentEffective.__terra_provenance instanceof Map) {
                            for (const [k, v] of parentEffective.__terra_provenance.entries()) {
                                baseProvenance.set(k, v);
                            }
                        }
                    } else {
                        // Attempt to find range of the specific parentId in YAML
                        let range = undefined;
                        if (extNode) {
                            if (isScalar(extNode) && String(extNode.value) === parentId) {
                                range = extNode.range;
                            } else if (isSeq(extNode)) {
                                const item = extNode.items[i];
                                if (item && isScalar(item)) range = item.range;
                            }
                        }

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

            // Resolve the current object's values
            const currentResolved = resolveValue(obj.node, pack, obj.parsedYaml);

            // Priority Shadowing: child values overwrite parents entirely (shallow merge)
            const result = Object.assign(base, currentResolved.value);

            // Merge child provenance (overwrites parent provenance for same keys)
            // currentResolved.value might not be an object if simple type, checking just in case
            if (currentResolved.value && typeof currentResolved.value === 'object') {
                // Use the provenance map returned by resolveValue if available, or the one attached to value
                const childProv = currentResolved.provenance || (currentResolved.value as any).__terra_provenance;
                if (childProv instanceof Map) {
                    for (const [k, v] of childProv.entries()) {
                        baseProvenance.set(k, v);
                    }
                }
            }

            return result;
        } finally {
            seen.delete(key);
        }
    }

    getAllDocs(): ParsedYaml[] {
        return Array.from(this.allDocs.values());
    }
}
