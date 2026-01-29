import fg from 'fast-glob';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { parseYaml, ParsedYaml } from '../parser/yaml.js';
import { Registry } from './registry.js';
import { Diagnostic } from '../types/diagnostic.js';
import { isMap, isScalar, isSeq } from 'yaml';
import { BIOME_SCHEMA, FEATURE_SCHEMA, PACK_SCHEMA, validateSchema } from './schema.js';
import { resolveValue } from './resolver.js';

export interface ValidationRules {
    expressionFields: string[];
    blockStateFields: string[];
}

export const DEFAULT_RULES: ValidationRules = {
    expressionFields: [
        '.palette', // suffix/include
        '.slant',   // include
        '.features.', // include
        'BEDROCK', 'threshold', 'multiplier', 'base_y' // exact field names
    ],
    blockStateFields: [
        '.palette', // include
        'block', 'material', 'replace', 'with' // exact field names
    ]
};

export class Pack {
    public registry = new Registry();
    public diagnostics: Diagnostic[] = [];
    public rootPath: string;
    public stageIds: Set<string> = new Set();
    public stageExtractionIncomplete: boolean = false; // Flag to track if stage parsing had issues
    public structureFiles: Set<string> = new Set();
    public structureExtensions: string[];
    public includePaths: string[];
    public ignorePatterns: string[];
    public rules: ValidationRules;

    constructor(rootPath: string, opts?: { structureExtensions?: string[], includePaths?: string[], ignore?: string[], rules?: ValidationRules }) {
        this.rootPath = path.resolve(rootPath);
        this.structureExtensions = opts?.structureExtensions?.length ? opts.structureExtensions : ['nbt'];
        this.includePaths = (opts?.includePaths || []).map(p => path.resolve(p));
        this.ignorePatterns = opts?.ignore || [];
        this.rules = opts?.rules ? { ...DEFAULT_RULES, ...opts.rules } : DEFAULT_RULES;
    }

    public isExpressionField(pathStr: string, fieldName: string): boolean {
        // Check against configured rules
        // Convention: 
        // - Starts with '.' -> Check if pathStr ends with or includes this (for backward compat with original logic)
        // - No '.' -> Check if fieldName equals this
        // Original logic:
        // pathStr.endsWith('.palette') || pathStr.includes('.slant') || pathStr.includes('.features.')
        // ['BEDROCK',...].includes(lastField)

        return this.rules.expressionFields.some(rule => {
            if (rule.startsWith('.')) {
                return pathStr.endsWith(rule) || pathStr.includes(rule);
            }
            return fieldName === rule;
        });
    }

    public isBlockField(pathStr: string, fieldName: string): boolean {
        // Original logic:
        // pathStr.includes('.palette')
        // ['block',...].includes(lastField)
        return this.rules.blockStateFields.some(rule => {
            if (rule.startsWith('.')) {
                return pathStr.includes(rule);
            }
            return fieldName.toLowerCase() === rule.toLowerCase(); // Case-insensitive match for block fields as per original
        });
    }

    async load() {
        const packYmlPath = path.join(this.rootPath, 'pack.yml');
        if (!existsSync(packYmlPath)) {
            this.diagnostics.push({
                code: 'PACK_MISSING',
                message: 'pack.yml not found at root',
                severity: 'error',
                file: 'pack.yml'
            });
            return;
        }

        const content = readFileSync(packYmlPath, 'utf8');
        const { parsed, diagnostics: yamlDiagnostics } = parseYaml(content, packYmlPath, 'root');
        this.diagnostics.push(...yamlDiagnostics);

        if (parsed && parsed.doc.contents) {
            const resolvedPack = resolveValue(parsed.doc.contents, this, parsed);
            validateSchema(resolvedPack.value, PACK_SCHEMA, this, parsed, parsed.doc.contents);

            const contents = parsed.doc.contents as any;
            const stages = contents.get ? contents.get('stages', true) : undefined;

            if (!stages) {
                this.stageExtractionIncomplete = true;
                this.diagnostics.push({
                    code: 'PACK_STAGES_MISSING',
                    message: 'pack.yml is missing required "stages" key.',
                    severity: 'error',
                    file: packYmlPath
                });
            } else if (!stages.items || !Array.isArray(stages.items)) {
                this.stageExtractionIncomplete = true;
                this.diagnostics.push({
                    code: 'PACK_STAGES_NOT_A_LIST',
                    message: '"stages" must be a YAML sequence (list).',
                    severity: 'error',
                    file: packYmlPath,
                    range: stages.range ? {
                        start: { ...parsed.lineCounter.linePos(stages.range[0]), offset: stages.range[0] },
                        end: { ...parsed.lineCounter.linePos(stages.range[1]), offset: stages.range[1] }
                    } : undefined
                });
            } else {
                for (let i = 0; i < stages.items.length; i++) {
                    const item = stages.items[i];
                    let stageId: string | undefined;
                    if (item && (typeof item.value === 'string' || typeof item.value === 'number')) {
                        stageId = String(item.value);
                    } else if (item && typeof item.get === 'function') {
                        const idNode = item.get('id', true);
                        if (idNode && (typeof idNode.value === 'string' || typeof idNode.value === 'number')) {
                            stageId = String(idNode.value);
                        }
                    }

                    if (stageId) {
                        this.stageIds.add(stageId.toUpperCase());
                    } else {
                        this.stageExtractionIncomplete = true;
                        this.diagnostics.push({
                            code: 'PACK_STAGE_UNREADABLE',
                            message: `Unable to read stage ID at index ${i}. Expected a string or an object with an "id" key.`,
                            severity: 'warning',
                            file: packYmlPath,
                            range: item?.range ? {
                                start: { ...parsed.lineCounter.linePos(item.range[0]), offset: item.range[0] },
                                end: { ...parsed.lineCounter.linePos(item.range[1]), offset: item.range[1] }
                            } : undefined
                        });
                    }
                }
            }
        }

        if (parsed) {
            this.registry.addParsedDoc(parsed, this);
        }

        // Load fragments from pack root
        const ymlFiles = await fg('**/*.yml', { cwd: this.rootPath, ignore: ['pack.yml', ...this.ignorePatterns] });
        for (const f of ymlFiles) {
            const fullPath = path.join(this.rootPath, f);
            this.loadFragment(fullPath, f, 'root');
        }

        // Load fragments from include paths
        for (const includePath of this.includePaths) {
            if (existsSync(includePath)) {
                const includeFiles = await fg('**/*.yml', { cwd: includePath, ignore: this.ignorePatterns });
                for (const f of includeFiles) {
                    const fullPath = path.join(includePath, f);
                    this.loadFragment(fullPath, f, 'include');
                }
            }
        }

        // Load structure files
        const structPath = path.join(this.rootPath, 'structures');
        if (existsSync(structPath)) {
            const extPart = this.structureExtensions.map(e => e.replace(/^\./, '')).join(',');
            const structFiles = await fg(`**/*.{${extPart}}`, { cwd: structPath });
            for (const f of structFiles) {
                this.structureFiles.add(f.toUpperCase().replace(/\\/g, '/'));
            }
        }
    }

    public expectConfigId(type: string, id: string, doc: ParsedYaml, range?: any, diagCode: string = 'CONFIG_REF_MISSING', context?: any, fieldName?: string) {
        const typeUpper = type.toUpperCase();
        if (!this.registry.getObject(typeUpper, id)) {
            this.reportDiagnostic(
                diagCode,
                `Referenced ${typeUpper} "${id}" not found.`,
                'error',
                context,
                doc,
                range,
                fieldName
            );
            return false;
        }
        return true;
    }

    public expectStageId(id: string, doc: ParsedYaml, range?: any, diagCode: string = 'STAGE_MISSING', context?: any, fieldName?: string) {
        if (!this.stageIds.has(id.toUpperCase())) {
            // Downgrade to warning if stage extraction was incomplete (avoids false positives)
            const severity = this.stageExtractionIncomplete ? 'warning' : 'error';
            const message = this.stageExtractionIncomplete
                ? `Referenced stage "${id}" not found in pack.yml (stage set may be incomplete due to parsing issues)`
                : `Referenced stage "${id}" not found in pack.yml`;
            this.reportDiagnostic(
                diagCode,
                message,
                severity,
                context,
                doc,
                range,
                fieldName
            );
            return false;
        }
        return true;
    }

    public expectFile(id: string, doc: ParsedYaml, range?: any, diagCode: string = 'STRUCTURE_REF_MISSING', context?: any, fieldName?: string) {
        const idUpper = id.toUpperCase().replace(/\\/g, '/');
        const hasFile = Array.from(this.structureFiles).some(f =>
            f === idUpper || f.endsWith('/' + idUpper) || f.replace(/\.[^/.]+$/, "") === idUpper || f.replace(/\.[^/.]+$/, "").endsWith('/' + idUpper)
        );

        if (!hasFile) {
            this.reportDiagnostic(
                diagCode,
                `Referenced structure file "${id}" not found in structures/ directory.`,
                'error',
                context,
                doc,
                range,
                fieldName
            );
            return false;
        }
        return true;
    }

    private reportDiagnostic(
        code: string,
        message: string,
        severity: 'error' | 'warning',
        context: any,
        fallbackDoc: ParsedYaml,
        fallbackRange?: any,
        fieldName?: string
    ) {
        let origin = context?.__terra_origin as ParsedYaml | undefined;
        let range = context?.__terra_range || fallbackRange;

        // Phase 2: Use ProvenanceMap for exact location
        if (context && context.__terra_provenance instanceof Map) {
            const provenance = context.__terra_provenance as Map<string, any>;
            let pointerKey = '';

            if (fieldName !== undefined) {
                pointerKey = `/${fieldName}`;
            }

            const entry = provenance.get(pointerKey);
            if (entry) {
                // If we have an exact entry for this field/item, use it.
                // But wait, the entry might contain the file path but we need the ParsedYaml object 
                // to get line/col conversions if it's not the fallbackDoc.
                // Actually ProvenanceEntry has 'file', 'range', 'sourceKind'.
                // We don't strictly need the ParsedYaml object if we have the range and file path.

                // However, diagnostics usually expect line/col which we get from 'range' (which has raw offsets).
                // Wait, ProvenanceEntry.range uses our Range type which has start/end {line, col, offset}.
                // So we can use it directly!

                this.diagnostics.push({
                    code,
                    message,
                    severity,
                    file: (entry.sourceKind === 'include' ? '[include] ' : '') + entry.file,
                    range: entry.range
                });
                return;
            }
        }

        // Fallback to old behavior if no provenance found
        const finalDoc = origin || fallbackDoc;
        const sourcePrefix = finalDoc.sourceKind === 'include' ? '[include] ' : '';

        this.diagnostics.push({
            code,
            message,
            severity,
            file: sourcePrefix + finalDoc.filePath,
            range: range ? {
                start: { ...finalDoc.lineCounter.linePos(range[0]), offset: range[0] },
                end: { ...finalDoc.lineCounter.linePos(range[1]), offset: range[1] }
            } : undefined
        });
    }

    private loadFragment(fullPath: string, relativePath: string, sourceKind: 'root' | 'include') {
        try {
            const content = readFileSync(fullPath, 'utf8');
            const { parsed, diagnostics: yamlDiagnostics } = parseYaml(content, fullPath, sourceKind);
            this.diagnostics.push(...yamlDiagnostics);

            if (parsed) {
                this.registry.addParsedDoc(parsed, this);
            }
        } catch (e: any) {
            this.diagnostics.push({
                code: 'FILE_READ_ERROR',
                message: `Failed to read file: ${e.message}`,
                severity: 'error',
                file: relativePath
            });
        }
    }

    async validate() {
        const biomes = this.registry.getObjectsByType('BIOME');
        for (const biome of biomes) {
            try {
                const effective = this.registry.getEffectiveObject('BIOME', biome.id, this);
                validateSchema(effective, BIOME_SCHEMA, this, biome.parsedYaml, biome.node);

                if (effective.palette) {
                    this.validatePalette(effective.palette, biome.parsedYaml);
                }
                if (effective.slant) {
                    for (const item of effective.slant) {
                        if (item.palette) {
                            this.validatePalette(item.palette, biome.parsedYaml);
                        }
                    }
                }

                // Validate stages in features
                const featuresNode = biome.node.get('features', true);
                if (effective.features && typeof effective.features === 'object') {
                    for (const [stageKey, stageFeatures] of Object.entries(effective.features)) {
                        // Only validate as a stage if it's a list (Terra features are always lists in a stage)
                        if (Array.isArray(stageFeatures)) {
                            let stageRange = undefined;
                            if (featuresNode && isMap(featuresNode)) {
                                const pair = (featuresNode.items as any[]).find(p => isScalar(p.key) && String(p.key.value) === stageKey);
                                if (pair) stageRange = pair.key.range;
                            }

                            this.expectStageId(stageKey, biome.parsedYaml, stageRange, 'STAGE_MISSING', effective.features, stageKey);

                            // Find the node for this stage's features list to get item ranges
                            const stageNode = featuresNode && isMap(featuresNode) ? featuresNode.get(stageKey, true) as any : undefined;

                            for (let i = 0; i < stageFeatures.length; i++) {
                                const featureId = stageFeatures[i];
                                if (typeof featureId === 'string' && !featureId.includes('${')) {
                                    let itemRange = undefined;
                                    if (stageNode && isSeq(stageNode)) {
                                        const item = (stageNode as any).items[i];
                                        if (item && isScalar(item)) itemRange = item.range;
                                    }
                                    this.validateFeatureReference(featureId, biome.parsedYaml, itemRange, stageFeatures, String(i));
                                }
                            }
                        }
                    }
                }

            } catch (e: any) {
                this.diagnostics.push({
                    code: 'EXTENDS_CYCLE',
                    message: e.message,
                    severity: 'error',
                    file: biome.parsedYaml.filePath
                });
            }
        }

        const features = this.registry.getObjectsByType('FEATURE');
        for (const feature of features) {
            try {
                const effective = this.registry.getEffectiveObject('FEATURE', feature.id, this);
                validateSchema(effective, FEATURE_SCHEMA, this, feature.parsedYaml, feature.node);
            } catch (e: any) {
                this.diagnostics.push({
                    code: 'EXTENDS_CYCLE',
                    message: e.message,
                    severity: 'error',
                    file: feature.parsedYaml.filePath
                });
            }
        }
    }

    private validateFeatureReference(id: string, doc: ParsedYaml, range?: any, context?: any, fieldName?: string) {
        // Dual Lookup: Registry or Filesystem
        if (this.registry.getObject('STRUCTURE', id)) return;
        if (this.registry.getObject('FEATURE', id)) return;

        // Filesystem check
        const idUpper = id.toUpperCase().replace(/\\/g, '/');
        const hasFile = Array.from(this.structureFiles).some(f =>
            f === idUpper || f.endsWith('/' + idUpper) || f.replace(/\.[^/.]+$/, "") === idUpper || f.replace(/\.[^/.]+$/, "").endsWith('/' + idUpper)
        );

        if (!hasFile) {
            const isLikelyFile = id.includes('.') || id.includes('/') || id.includes('\\');
            this.reportDiagnostic(
                isLikelyFile ? 'STRUCTURE_REF_MISSING' : 'FEATURE_REF_MISSING',
                `Referenced ${isLikelyFile ? 'structure' : 'feature/structure'} "${id}" not found in registry or structures/ directory.`,
                'error',
                context,
                doc,
                range,
                fieldName
            );
        }
    }

    private validatePalette(palette: any, biomeDoc: ParsedYaml) {
        if (!Array.isArray(palette)) {
            this.reportDiagnostic(
                'INVALID_PALETTE_STRUCTURE',
                'Palette must be a sequence of layers.',
                'error',
                palette,
                biomeDoc
            );
            return;
        }

        palette.forEach((layer: any, i: number) => {
            let id: string | undefined;

            if (typeof layer === 'string') {
                id = layer;
            } else if (typeof layer === 'object' && layer !== null && !Array.isArray(layer)) {
                const keys = Object.keys(layer);
                if (keys.length > 1) {
                    this.reportDiagnostic(
                        'INVALID_PALETTE_LAYER',
                        `Palette layer has multiple keys: [${keys.join(', ')}]. Each layer should be a single block/palette reference. (Likely caused by incorrect <<: merge in a list)`,
                        'error',
                        layer,
                        biomeDoc
                    );
                } else if (keys.length === 1) {
                    id = keys[0];
                }
            }

            if (id && !id.includes(':') && !id.includes('${')) {
                this.expectConfigId('PALETTE', id, biomeDoc, undefined, 'PALETTE_MISSING', palette, String(i));
            }
        });
    }
}
