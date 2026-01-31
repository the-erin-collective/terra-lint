import fg from 'fast-glob';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { parseYaml, ParsedYaml, stripBom } from '../parser/yaml.js';
import { Registry } from './registry.js';
import { Diagnostic, FileCategory, PackStats, FileStats, CategoryStats } from '../types/diagnostic.js';
import { isMap, isScalar, isSeq } from 'yaml';
import { BIOME_SCHEMA, FEATURE_SCHEMA, PACK_SCHEMA, validateSchema, validatePValueSchema } from './schema.js';
import { PValue, toJS, isPScalar, isPSeq, isPMap } from './pvalue/types.js';
import { resolveValue } from './resolver.js';

export interface ValidationRules {
    expressionFields: string[];
    blockStateFields: string[];
}

export const DEFAULT_RULES: ValidationRules = {
    expressionFields: [
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
    public metaRefStack: Set<string> = new Set(); // Track meta-ref resolution to detect cycles
    public stats: PackStats = {
        files: {},
        categories: {
            [FileCategory.BIOME]: { total: 0, passed: 0, warned: 0, failed: 0 },
            [FileCategory.FEATURE]: { total: 0, passed: 0, warned: 0, failed: 0 },
            [FileCategory.PALETTE]: { total: 0, passed: 0, warned: 0, failed: 0 },
            [FileCategory.FUNCTION]: { total: 0, passed: 0, warned: 0, failed: 0 },
            [FileCategory.UNKNOWN]: { total: 0, passed: 0, warned: 0, failed: 0 }
        }
    };

    constructor(rootPath: string, opts?: { structureExtensions?: string[], includePaths?: string[], ignore?: string[], rules?: ValidationRules }) {
        this.rootPath = path.resolve(rootPath);
        this.structureExtensions = opts?.structureExtensions?.length ? opts.structureExtensions : ['nbt'];
        this.includePaths = (opts?.includePaths || []).map(p => path.resolve(p));
        this.ignorePatterns = opts?.ignore || [];
        this.rules = opts?.rules ? { ...DEFAULT_RULES, ...opts.rules } : DEFAULT_RULES;
    }

    public isExpressionField(pathStr: string, fieldName: string): boolean {
        // Exclude pack.yml metadata fields that should never be expressions
        const excludedPaths = [
            'id', 'version', 'author', 'generator', 'vanilla', 'vanilla-generation',
            'addons', 'preset-single-biome', 'preset-single-debug-biome'
        ];
        
        // If the path starts with 'addons.', it's definitely not an expression field
        if (pathStr.startsWith('addons.') || excludedPaths.includes(fieldName)) {
            return false;
        }
        
        // Check against configured rules (whitelist approach)
        // Only allow expressions in known safe contexts
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
            return fieldName && fieldName.toLowerCase() === rule.toLowerCase();
        });
    }

    public detectFileCategory(filePath: string): FileCategory {
        const relativePath = path.relative(this.rootPath, filePath);
        const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase();
        
        // Check directory structure and file patterns
        if (normalizedPath.includes('/biomes/') || normalizedPath.startsWith('biomes/')) {
            return FileCategory.BIOME;
        }
        if (normalizedPath.includes('/features/') || normalizedPath.startsWith('features/')) {
            return FileCategory.FEATURE;
        }
        if (normalizedPath.includes('/palettes/') || normalizedPath.startsWith('palettes/')) {
            return FileCategory.PALETTE;
        }
        if (normalizedPath.includes('/functions/') || normalizedPath.startsWith('functions/')) {
            return FileCategory.FUNCTION;
        }
        
        // Check file names
        const fileName = path.basename(normalizedPath);
        if (fileName.includes('biome')) {
            return FileCategory.BIOME;
        }
        if (fileName.includes('feature')) {
            return FileCategory.FEATURE;
        }
        if (fileName.includes('palette')) {
            return FileCategory.PALETTE;
        }
        if (fileName.includes('function') || fileName.endsWith('.mcfunction')) {
            return FileCategory.FUNCTION;
        }
        
        return FileCategory.UNKNOWN;
    }

    public updateFileStats(filePath: string, category: FileCategory): void {
        // Initialize file stats if not exists
        if (!this.stats.files[filePath]) {
            this.stats.files[filePath] = { total: 1, passed: 0, warned: 0, failed: 0 };
            this.stats.categories[category].total++;
        }
        
        // Get diagnostics for this file
        const fileDiagnostics = this.diagnostics.filter(d => d.file === filePath);
        const errors = fileDiagnostics.filter(d => d.severity === 'error').length;
        const warnings = fileDiagnostics.filter(d => d.severity === 'warning').length;
        
        // Update file stats
        const fileStats = this.stats.files[filePath];
        if (errors > 0) {
            fileStats.failed = 1;
            this.stats.categories[category].failed++;
        } else if (warnings > 0) {
            fileStats.warned = 1;
            this.stats.categories[category].warned++;
        } else {
            fileStats.passed = 1;
            this.stats.categories[category].passed++;
        }
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

        const content = stripBom(readFileSync(packYmlPath, 'utf8'));
        const { parsed, diagnostics: yamlDiagnostics } = parseYaml(content, packYmlPath, 'root');
        this.diagnostics.push(...yamlDiagnostics);

        if (parsed && parsed.doc.contents) {
            const resolvedPack = resolveValue(parsed.doc.contents, this, parsed);
            // Use PValue-based validation to get proper authoring kind validation
            validatePValueSchema(resolvedPack, PACK_SCHEMA, this, parsed, parsed.doc.contents);

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

        // Load all YAML files from pack root recursively
        const defaultIgnorePatterns = ['**/node_modules/**', '**/.git/**', '**/build/**', '**/dist/**'];
        const allIgnorePatterns = [...defaultIgnorePatterns, ...this.ignorePatterns];
        
        const ymlFiles = await fg('**/*.yml', { cwd: this.rootPath, ignore: allIgnorePatterns });
        const yamlFiles = await fg('**/*.yaml', { cwd: this.rootPath, ignore: allIgnorePatterns });
        const allYamlFiles = [...new Set([...ymlFiles, ...yamlFiles])].filter(f => f !== 'pack.yml');
        
        // Track all loaded files for stats
        for (const f of allYamlFiles) {
            const fullPath = path.join(this.rootPath, f);
            const category = this.detectFileCategory(f);
            this.updateFileStats(f, category);
            this.loadFragment(fullPath, f, 'root');
        }

        // Load all YAML files from include paths recursively
        for (const includePath of this.includePaths) {
            if (existsSync(includePath)) {
                const includeYmlFiles = await fg('**/*.yml', { cwd: includePath, ignore: allIgnorePatterns });
                const includeYamlFiles = await fg('**/*.yaml', { cwd: includePath, ignore: allIgnorePatterns });
                const allIncludeFiles = [...new Set([...includeYmlFiles, ...includeYamlFiles])];
                
                for (const f of allIncludeFiles) {
                    const fullPath = path.join(includePath, f);
                    const category = this.detectFileCategory(f);
                    this.updateFileStats(f, category);
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
            const content = stripBom(readFileSync(fullPath, 'utf8'));
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
                const effectiveP = this.registry.getEffectiveObject('BIOME', biome.id, this);
                if (!effectiveP) continue;
                // Use PValue-based validation to get proper authoring kind validation
                validatePValueSchema(effectiveP, BIOME_SCHEMA, this, biome.parsedYaml, biome.node);

                const palette = effectiveP.entries.get('palette');
                if (palette && isPSeq(palette)) {
                    this.validatePalettePValue(palette.items, biome.parsedYaml);
                }
                
                const slant = effectiveP.entries.get('slant');
                if (slant && isPSeq(slant)) {
                    for (const item of slant.items) {
                        if (isPMap(item)) {
                            const itemPalette = item.entries.get('palette');
                            if (itemPalette && isPSeq(itemPalette)) {
                                this.validatePalettePValue(itemPalette.items, biome.parsedYaml);
                            }
                        }
                    }
                }

                // Validate stages in features
                const features = effectiveP.entries.get('features');
                const featuresNode = biome.node.get('features', true);
                if (features && isPMap(features)) {
                    for (const [stageKey, stageFeaturesP] of features.entries) {
                        // Only validate as a stage if it's a list (Terra features are always lists in a stage)
                        if (isPSeq(stageFeaturesP)) {
                            let stageRange = undefined;
                            if (featuresNode && isMap(featuresNode)) {
                                const pair = (featuresNode.items as any[]).find(p => isScalar(p.key) && String(p.key.value) === stageKey);
                                if (pair) stageRange = pair.key.range;
                            }

                            this.expectStageId(stageKey, biome.parsedYaml, stageRange, 'STAGE_MISSING', toJS(features), stageKey);

                            // Find the node for this stage's features list to get item ranges
                            const stageNode = featuresNode && isMap(featuresNode) ? featuresNode.get(stageKey, true) as any : undefined;
                            for (let i = 0; i < stageFeaturesP.items.length; i++) {
                                const featureP = stageFeaturesP.items[i];
                                if (isPScalar(featureP) && typeof featureP.value === 'string') {
                                    const featureId = featureP.value;
                                    const itemNode = stageNode && isSeq(stageNode) ? stageNode.items[i] as any : undefined;
                                    const itemRange = itemNode?.range;
                                    this.expectFeatureId(featureId, biome.parsedYaml, itemRange);
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
                const effectiveP = this.registry.getEffectiveObject('FEATURE', feature.id, this);
                if (!effectiveP) continue;
                // Use PValue-based validation to get proper authoring kind validation
                validatePValueSchema(effectiveP, FEATURE_SCHEMA, this, feature.parsedYaml, feature.node);
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

    public expectFeatureId(id: string, doc: ParsedYaml, range?: any, context?: any, fieldName?: string) {
        return this.validateFeatureReference(id, doc, range, context, fieldName);
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

    private validatePalettePValue(palette: PValue[], biomeDoc: ParsedYaml) {
        palette.forEach((layerP, i: number) => {
            let id: string | undefined;

            if (isPScalar(layerP) && typeof layerP.value === 'string') {
                id = layerP.value;
            } else if (isPMap(layerP)) {
                const keys = Array.from(layerP.entries.keys());
                if (keys.length > 1) {
                    this.reportDiagnostic(
                        'INVALID_PALETTE_LAYER',
                        `Palette layer has multiple keys: [${keys.join(', ')}]. Each layer should be a single block/palette reference. (Likely caused by incorrect <<: merge in a list)`,
                        'error',
                        layerP,
                        biomeDoc
                    );
                } else if (keys.length === 1) {
                    id = keys[0];
                }
            }

            if (id && !id.includes(':') && !id.includes('${')) {
                this.expectConfigId('PALETTE', id, biomeDoc, layerP.origin.fullRange, 'PALETTE_MISSING', palette, String(i));
            }
        });
    }
}
