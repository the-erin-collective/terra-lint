import fg from 'fast-glob';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { parseYaml, ParsedYaml } from '../parser/yaml.js';
import { Registry } from './registry.js';
import { Diagnostic } from '../types/diagnostic.js';
import { isMap, isScalar, isSeq } from 'yaml';

export class Pack {
    public registry = new Registry();
    public diagnostics: Diagnostic[] = [];
    public rootPath: string;
    public stageIds: Set<string> = new Set();
    public structureFiles: Set<string> = new Set();
    public structureExtensions: string[];
    public includePaths: string[];

    constructor(rootPath: string, opts?: { structureExtensions?: string[], includePaths?: string[] }) {
        this.rootPath = path.resolve(rootPath);
        this.structureExtensions = opts?.structureExtensions?.length ? opts.structureExtensions : ['nbt'];
        this.includePaths = (opts?.includePaths || []).map(p => path.resolve(p));
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
        const { parsed, diagnostics: yamlDiagnostics } = parseYaml(content, packYmlPath);
        this.diagnostics.push(...yamlDiagnostics);

        if (parsed && parsed.doc.contents) {
            const contents = parsed.doc.contents as any;
            const stages = contents.get ? contents.get('stages', true) : undefined;

            if (!stages) {
                this.diagnostics.push({
                    code: 'PACK_STAGES_MISSING',
                    message: 'pack.yml has no "stages" key. Stage validation may be incomplete.',
                    severity: 'warning',
                    file: 'pack.yml'
                });
            } else if (!Array.isArray(stages.items)) {
                this.diagnostics.push({
                    code: 'PACK_STAGES_NOT_A_LIST',
                    message: '"stages" in pack.yml is not a YAML sequence/list.',
                    severity: 'warning',
                    file: 'pack.yml',
                    range: stages.range ? {
                        start: { ...parsed.lineCounter.linePos(stages.range[0]), offset: stages.range[0] },
                        end: { ...parsed.lineCounter.linePos(stages.range[1]), offset: stages.range[1] }
                    } : undefined
                });
            } else {
                for (const item of stages.items) {
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
                    } else if (item) {
                        this.diagnostics.push({
                            code: 'PACK_STAGE_UNREADABLE',
                            message: 'A stage entry in pack.yml could not be interpreted as a stage id (expected scalar or map with "id").',
                            severity: 'warning',
                            file: 'pack.yml',
                            range: item.range ? {
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
        const ymlFiles = await fg('**/*.yml', { cwd: this.rootPath, ignore: ['pack.yml'] });
        for (const f of ymlFiles) {
            const fullPath = path.join(this.rootPath, f);
            this.loadFragment(fullPath, f);
        }

        // Load fragments from include paths
        for (const includePath of this.includePaths) {
            if (existsSync(includePath)) {
                const includeFiles = await fg('**/*.yml', { cwd: includePath });
                for (const f of includeFiles) {
                    const fullPath = path.join(includePath, f);
                    this.loadFragment(fullPath, f);
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

        if (fieldName && context?.__terra_metadata instanceof Map) {
            const meta = context.__terra_metadata.get(fieldName);
            if (meta) {
                origin = meta.origin;
                range = meta.range;
            }
        }

        const finalDoc = origin || fallbackDoc;

        this.diagnostics.push({
            code,
            message,
            severity,
            file: finalDoc.filePath,
            range: range ? {
                start: { ...finalDoc.lineCounter.linePos(range[0]), offset: range[0] },
                end: { ...finalDoc.lineCounter.linePos(range[1]), offset: range[1] }
            } : undefined
        });
    }

    private loadFragment(fullPath: string, relativePath: string) {
        try {
            const content = readFileSync(fullPath, 'utf8');
            const { parsed, diagnostics: yamlDiagnostics } = parseYaml(content, fullPath);
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

                            if (!this.stageIds.has(stageKey.toUpperCase())) {
                                this.diagnostics.push({
                                    code: 'STAGE_MISSING',
                                    message: `Referenced stage "${stageKey}" not found in pack.yml`,
                                    severity: 'error',
                                    file: biome.parsedYaml.filePath,
                                    range: stageRange ? {
                                        start: { ...biome.parsedYaml.lineCounter.linePos(stageRange[0]), offset: stageRange[0] },
                                        end: { ...biome.parsedYaml.lineCounter.linePos(stageRange[1]), offset: stageRange[1] }
                                    } : undefined
                                });
                            }

                            // Find the node for this stage's features list to get item ranges
                            const stageNode = featuresNode && isMap(featuresNode) ? featuresNode.get(stageKey, true) as any : undefined;

                            for (let i = 0; i < stageFeatures.length; i++) {
                                const featureId = stageFeatures[i];
                                if (typeof featureId === 'string') {
                                    let itemRange = undefined;
                                    if (stageNode && isSeq(stageNode)) {
                                        const item = (stageNode as any).items[i];
                                        if (item && isScalar(item)) itemRange = item.range;
                                    }
                                    this.validateStructureReference(featureId, biome.parsedYaml, itemRange);
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

        for (const layer of palette) {
            let id: string | undefined;
            let context: any = layer;

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

            if (id && !id.includes(':')) {
                if (!this.registry.getObject('PALETTE', id)) {
                    this.reportDiagnostic(
                        'PALETTE_MISSING',
                        `Referenced palette "${id}" not found. If this is a block ID, use "minecraft:${id}" or "BLOCK:minecraft:${id}".`,
                        'warning',
                        context,
                        biomeDoc,
                        undefined,
                        id === context ? undefined : id
                    );
                }
            }
        }
    }

    private validateStructureReference(id: string, doc: ParsedYaml, range?: any) {
        // Dual Lookup: Registry or Filesystem
        const inRegistry = this.registry.getObject('STRUCTURE', id);
        if (inRegistry) return;

        // Filesystem check
        const idUpper = id.toUpperCase().replace(/\\/g, '/');
        const hasFile = Array.from(this.structureFiles).some(f =>
            f === idUpper || f.endsWith('/' + idUpper) || f.replace(/\.[^/.]+$/, "") === idUpper || f.replace(/\.[^/.]+$/, "").endsWith('/' + idUpper)
        );

        if (!hasFile) {
            if (!this.registry.getObject('FEATURE', id)) {
                // If it looks like a file path (has extension or /), call it a structure missing
                const isLikelyFile = id.includes('.') || id.includes('/') || id.includes('\\');
                this.reportDiagnostic(
                    isLikelyFile ? 'STRUCTURE_REF_MISSING' : 'FEATURE_REF_MISSING',
                    `Referenced ${isLikelyFile ? 'structure' : 'feature/structure'} "${id}" not found in registry or structures/ directory.`,
                    'error',
                    undefined, // Scalars have no metadata here
                    doc,
                    range
                );
            }
        }
    }
}
