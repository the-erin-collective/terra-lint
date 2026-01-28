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

    addParsedDoc(doc: ParsedYaml) {
        this.allDocs.set(doc.filePath, doc);

        const root = doc.doc.contents;
        if (isMap(root)) {
            const typeNode = root.get('type', true);
            const idNode = root.get('id', true);

            if (isScalar(typeNode) && isScalar(idNode)) {
                const typeStr = String(typeNode.value);
                const idStr = String(idNode.value);

                let typeMap = this.byType.get(typeStr);
                if (!typeMap) {
                    typeMap = new Map();
                    this.byType.set(typeStr, typeMap);
                }

                const obj: ConfigObject = {
                    type: typeStr,
                    id: idStr,
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

                typeMap.set(idStr, obj);
            }
        }
    }

    getObjectsByType(type: string): ConfigObject[] {
        const typeMap = this.byType.get(type);
        return typeMap ? Array.from(typeMap.values()) : [];
    }

    getObject(type: string, id: string): ConfigObject | undefined {
        return this.byType.get(type)?.get(id);
    }

    getEffectiveObject(type: string, id: string, pack: Pack, seen = new Set<string>()): any {
        const key = `${type}:${id}`;
        if (seen.has(key)) {
            throw new Error(`Circular inheritance detected: ${Array.from(seen).join(' -> ')} -> ${key}`);
        }
        seen.add(key);

        const obj = this.getObject(type, id);
        if (!obj) return undefined;

        let base: any = {};
        if (obj.extends) {
            const parentIds = Array.isArray(obj.extends) ? obj.extends : [obj.extends];
            // Terra Semantics: earlier extends have higher priority for filling blanks
            // This means we should merge them in REVERSE order so earlier ones overwrite later ones
            for (const parentId of [...parentIds].reverse()) {
                const parentEffective = this.getEffectiveObject(type, parentId, pack, new Set(seen));
                if (parentEffective) {
                    Object.assign(base, parentEffective);
                }
            }
        }

        // Resolve the current object's values
        const currentResolved = resolveValue(obj.node, obj.parsedYaml.doc as any, obj.parsedYaml);

        return Object.assign(base, currentResolved);
    }

    getAllDocs(): ParsedYaml[] {
        return Array.from(this.allDocs.values());
    }
}
