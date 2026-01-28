import { isMap, isScalar, isSeq, Node, YAMLMap, Scalar } from 'yaml';
import { Pack } from '../core/pack.js';
import { ParsedYaml } from '../parser/yaml.js';

export function resolveValue(node: Node | null | undefined, pack: Pack, parentDoc: ParsedYaml): any {
    if (!node) return undefined;

    if (isScalar(node)) {
        const val = String(node.value);
        if (val.startsWith('$')) {
            // Handle $file.yml:path.to.thing
            return resolveMetaRef(val, pack);
        }
        if (val.startsWith('<<')) {
            const ref = val.substring(2).trim();
            return resolveMetaRef('$' + ref, pack);
        }
        return node.value;
    }

    if (isMap(node)) {
        const result: any = {};
        for (const pair of node.items) {
            const { key, value } = pair as any;
            if (isScalar(key)) {
                const keyStr = String(key.value);
                if (keyStr === '<<') {
                    // Handle meta merge
                    const merged = resolveMetaMerge(value as Node, pack, parentDoc);
                    Object.assign(result, merged);
                } else {
                    result[keyStr] = resolveValue(value as Node, pack, parentDoc);
                }
            }
        }
        return result;
    }

    if (isSeq(node)) {
        const result: any[] = [];
        for (const item of node.items) {
            const resolved = resolveValue(item as Node, pack, parentDoc);
            if (Array.isArray(resolved)) {
                result.push(...resolved);
            } else {
                result.push(resolved);
            }
        }
        return result;
    }

    return undefined;
}

function resolveMetaRef(ref: string, pack: Pack): any {
    // Handle $file.yml:path.to.thing or $file.yml:top-level-key
    let pathStr = ref.substring(1);
    if (pathStr.startsWith('{') && pathStr.endsWith('}')) {
        pathStr = pathStr.substring(1, pathStr.length - 1);
    }

    const parts = pathStr.split(':');
    if (parts.length < 2) return ref;

    const filePath = parts[0];
    // Path can be separated by : or . in some Terra versions, or just one segment
    const pathInFile = parts.slice(1).join(':').split('.');

    if (!pack || !pack.registry) {
        // console.warn('Pack or Registry undefined during resolution');
        return ref;
    }

    const allDocs = pack.registry.getAllDocs();
    const doc = allDocs.find(d => d.filePath === filePath || d.filePath.endsWith(filePath) || d.filePath.endsWith('/' + filePath) || d.filePath.endsWith('\\' + filePath));

    if (!doc) {
        return ref;
    }

    let current: Node | null | undefined = doc.doc.contents as any;
    for (const part of pathInFile) {
        if (isMap(current)) {
            current = current.get(part, true) as any;
        } else {
            // console.warn(`Meta ref path not found: ${part} in ${ref}`);
            return ref;
        }
    }

    // console.log(`Resolved ${ref} to node type: ${current?.constructor.name}`);
    return resolveValue(current, pack, doc);
}

function resolveMetaMerge(node: Node, pack: Pack, parentDoc: ParsedYaml): any {
    if (isScalar(node)) {
        const val = resolveValue(node, pack, parentDoc);
        return typeof val === 'object' ? val : {};
    }
    if (isSeq(node)) {
        let result = {};
        for (const item of node.items) {
            Object.assign(result, resolveMetaMerge(item as Node, pack, parentDoc));
        }
        return result;
    }
    return resolveValue(node, pack, parentDoc);
}
