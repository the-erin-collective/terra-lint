import { Diagnostic } from '../types/diagnostic.js';
import { ParsedYaml } from '../parser/yaml.js';
import { isMap, isScalar, isSeq } from 'yaml';
import { Pack } from './pack.js';
import { getValidationKind, isMetaDerived, PValue, isPScalar, isPSeq, isPMap, toJS } from './pvalue/types.js';

export interface SchemaField {
    type: 'string' | 'number' | 'boolean' | 'list' | 'map' | 'any' | 'scalar';
    required?: boolean;
    items?: SchemaField; // For lists
    properties?: Record<string, SchemaField>; // For maps
}

export const PACK_SCHEMA: Record<string, SchemaField> = {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    version: { type: 'string', required: true },
    stages: {
        type: 'list',
        required: true,
        items: { type: 'any' }
    }
};

export const BIOME_SCHEMA: Record<string, SchemaField> = {
    id: { type: 'string', required: true },
    type: { type: 'string', required: true },
    extends: { type: 'any' },
    tags: { type: 'list' },
    color: { type: 'string' },
    palette: { type: 'list' },
    slant: { type: 'list' },
    features: { type: 'map' }
};

export const FEATURE_SCHEMA: Record<string, SchemaField> = {
    id: { type: 'string', required: true },
    type: { type: 'string', required: true },
    extends: { type: 'any' }
};

export function validateSchema(obj: any, schema: Record<string, SchemaField>, pack: Pack, doc: ParsedYaml, node: any, prefix: string = '') {
    if (!obj || typeof obj !== 'object') return;

    // Check for unknown keys if we want to be strict (maybe later)

    for (const [key, field] of Object.entries(schema)) {
        const val = obj[key];
        const fieldPath = prefix ? `${prefix}.${key}` : key;

        if (val === undefined || val === null) {
            if (field.required) {
                pack.diagnostics.push({
                    code: 'SCHEMA_MISSING_FIELD',
                    message: `Required field "${fieldPath}" is missing.`,
                    severity: 'error',
                    file: doc.filePath,
                    range: node && node.range ? {
                        start: { ...doc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                        end: { ...doc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
                    } : undefined
                });
            }
            continue;
        }

        // Validate type
        const actualType = Array.isArray(val) ? 'list' : (typeof val === 'object' && val !== null ? 'map' : typeof val);
        let typeMatch = false;
        if (field.type === 'any') typeMatch = true;
        else if (field.type === 'scalar') typeMatch = (actualType === 'string' || actualType === 'number' || actualType === 'boolean');
        else typeMatch = (actualType === field.type);

        if (!typeMatch) {
            let range = undefined;
            if (node && isMap(node)) {
                const pair = (node.items as any[]).find((p: any) => isScalar(p.key) && String(p.key.value) === key);
                if (pair) range = pair.value?.range || pair.key.range;
            }

            pack.diagnostics.push({
                code: 'SCHEMA_TYPE_MISMATCH',
                message: `Field "${fieldPath}" should be a ${field.type}, but got ${actualType}.`,
                severity: 'error',
                file: doc.filePath,
                range: range ? {
                    start: { ...doc.lineCounter.linePos(range[0]), offset: range[0] },
                    end: { ...doc.lineCounter.linePos(range[1]), offset: range[1] }
                } : undefined
            });
        }

        // Recursive validation for maps
        if (field.type === 'map' && field.properties && actualType === 'map') {
            const nextNode = node && isMap(node) ? node.get(key, true) : undefined;
            validateSchema(val, field.properties, pack, doc, nextNode, fieldPath);
        }
        // Recursive validation for lists
        if (field.type === 'list' && field.items && actualType === 'list') {
            const listNode = node && isMap(node) ? node.get(key, true) : undefined;
            (val as any[]).forEach((item: any, i: number) => {
                const itemNode = (listNode && isSeq(listNode)) ? (listNode as any).items[i] : undefined;
                validateValueSchema(item, field.items!, pack, doc, itemNode, `${fieldPath}[${i}]`);
            });
        }
    }
}

// New PValue-based validation function
export function validatePValueSchema(pvalue: PValue, schema: Record<string, SchemaField>, pack: Pack, doc: ParsedYaml, node: any, prefix: string = '') {
    if (!isPMap(pvalue)) return;

    for (const [key, field] of Object.entries(schema)) {
        const val = pvalue.entries.get(key);
        const fieldPath = prefix ? `${prefix}.${key}` : key;

        if (!val) {
            if (field.required) {
                pack.diagnostics.push({
                    code: 'SCHEMA_MISSING_FIELD',
                    message: `Required field "${fieldPath}" is missing.`,
                    severity: 'error',
                    file: doc.filePath,
                    range: node && node.range ? {
                        start: { ...doc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                        end: { ...doc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
                    } : undefined
                });
            }
            continue;
        }

        // Validate type using authoring kind for meta-derived values
        const validationKind = getValidationKind(val);
        const isMeta = isMetaDerived(val);
        
        let typeMatch = false;
        if (field.type === 'any') typeMatch = true;
        else if (field.type === 'scalar') {
            // For scalar fields, accept any scalar kind
            typeMatch = validationKind === 'scalar';
        } else {
            // For specific container types, match the kind
            const expectedKind = field.type === 'map' ? 'map' : field.type === 'list' ? 'seq' : field.type;
            typeMatch = validationKind === expectedKind;
        }

        if (!typeMatch) {
            let range = undefined;
            if (node && isMap(node)) {
                const pair = (node.items as any[]).find((p: any) => isScalar(p.key) && String(p.key.value) === key);
                if (pair) range = pair.value?.range || pair.key.range;
            }

            // For meta-derived values, prefer the referenced file location but mention meta site
            const errorFile = val.origin.file;
            const errorRange = val.origin.fullRange;
            
            let message = `Field "${fieldPath}" should be a ${field.type}, but got ${validationKind}.`;
            if (isMeta && val.origin.metaSite) {
                message += ` (referenced from ${val.origin.metaSite.file}:${val.origin.metaSite.range?.start || '?'})`;
            }

            pack.diagnostics.push({
                code: 'SCHEMA_TYPE_MISMATCH',
                message,
                severity: 'error',
                file: errorFile,
                range: errorRange
            });
        }

        // Recursive validation for maps
        if (field.type === 'map' && field.properties && validationKind === 'map') {
            const nextNode = node && isMap(node) ? node.get(key, true) : undefined;
            validatePValueSchema(val, field.properties, pack, doc, nextNode, fieldPath);
        }
        // Recursive validation for lists
        if (field.type === 'list' && field.items && validationKind === 'seq') {
            const listNode = node && isMap(node) ? node.get(key, true) : undefined;
            if (isPSeq(val)) {
                val.items.forEach((item: PValue, i: number) => {
                    const itemNode = (listNode && isSeq(listNode)) ? (listNode as any).items[i] : undefined;
                    validatePValueSchemaField(item, field.items!, pack, doc, itemNode, `${fieldPath}[${i}]`);
                });
            }
        }
    }
}

function validatePValueSchemaField(pvalue: PValue, field: SchemaField, pack: Pack, doc: ParsedYaml, node: any, path: string) {
    const validationKind = getValidationKind(pvalue);
    const isMeta = isMetaDerived(pvalue);
    
    let typeMatch = false;
    if (field.type === 'any') typeMatch = true;
    else if (field.type === 'scalar') {
        // For scalar fields, accept any scalar kind
        typeMatch = validationKind === 'scalar';
    } else {
        // For specific container types, match the kind
        const expectedKind = field.type === 'map' ? 'map' : field.type === 'list' ? 'seq' : field.type;
        typeMatch = validationKind === expectedKind;
    }

    if (!typeMatch) {
        // For meta-derived values, prefer the referenced file location but mention meta site
        const errorFile = pvalue.origin.file;
        const errorRange = pvalue.origin.fullRange;
        
        let message = `Entry "${path}" should be a ${field.type}, but got ${validationKind}.`;
        if (isMeta && pvalue.origin.metaSite) {
            message += ` (referenced from ${pvalue.origin.metaSite.file}:${pvalue.origin.metaSite.range?.start || '?'})`;
        }

        pack.diagnostics.push({
            code: 'SCHEMA_TYPE_MISMATCH',
            message,
            severity: 'error',
            file: errorFile,
            range: errorRange
        });
    }

    if (field.type === 'map' && field.properties && validationKind === 'map') {
        validatePValueSchema(pvalue, field.properties, pack, doc, node, path);
    }
}

function validateValueSchema(val: any, field: SchemaField, pack: Pack, doc: ParsedYaml, node: any, path: string) {
    const actualType = Array.isArray(val) ? 'list' : (typeof val === 'object' && val !== null ? 'map' : typeof val);
    let typeMatch = false;
    if (field.type === 'any') typeMatch = true;
    else if (field.type === 'scalar') typeMatch = (actualType === 'string' || actualType === 'number' || actualType === 'boolean');
    else typeMatch = (actualType === field.type);

    if (!typeMatch) {
        pack.diagnostics.push({
            code: 'SCHEMA_TYPE_MISMATCH',
            message: `Entry "${path}" should be a ${field.type}, but got ${actualType}.`,
            severity: 'error',
            file: doc.filePath,
            range: node && node.range ? {
                start: { ...doc.lineCounter.linePos(node.range[0]), offset: node.range[0] },
                end: { ...doc.lineCounter.linePos(node.range[1]), offset: node.range[1] }
            } : undefined
        });
    }

    if (field.type === 'map' && field.properties && actualType === 'map') {
        validateSchema(val, field.properties, pack, doc, node, path);
    }
}
