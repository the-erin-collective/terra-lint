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
                const typeStr = String(typeNode.value).toUpperCase();
                const idStr = String(idNode.value).toUpperCase();

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
                        obj.extends = String(extNode.value).toUpperCase();
                    } else if (isSeq(extNode)) {
                        obj.extends = (extNode as any).items.map((item: any) => isScalar(item) ? String(item.value).toUpperCase() : '').filter(Boolean);
                    }
                }

                typeMap.set(idStr, obj);
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

    getEffectiveObject(type: string, id: string, pack: Pack, seen = new Set<string>()): any {
        const typeUpper = type.toUpperCase();
        const idUpper = id.toUpperCase();
        const key = `${typeUpper}:${idUpper}`;
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
                const parentEffective = this.getEffectiveObject(type, parentId, pack, seen); // Pass same 'seen' to collect chain
                if (parentEffective) {
                    Object.assign(base, parentEffective);
                } else {
                    pack.diagnostics.push({
                        code: 'EXTENDS_TARGET_MISSING',
                        message: `Inheritance target "${parentId}" of type "${type}" not found.`,
                        severity: 'error',
                        file: obj.parsedYaml.filePath,
                        // TODO: Add range for the specific extends entry if possible
                    });
                }
            }
        }

        // Resolve the current object's values
        const currentResolved = resolveValue(obj.node, pack, obj.parsedYaml);

        return Object.assign(base, currentResolved);
    }

    getAllDocs(): ParsedYaml[] {
        return Array.from(this.allDocs.values());
    }
}
