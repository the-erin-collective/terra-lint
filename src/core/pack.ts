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

    constructor(rootPath: string, opts?: { structureExtensions?: string[] }) {
        this.rootPath = path.resolve(rootPath);
        this.structureExtensions = opts?.structureExtensions?.length ? opts.structureExtensions : ['nbt'];
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
        const { parsed, diagnostics: yamlDiagnostics } = parseYaml(content, 'pack.yml');
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

        // Load all .yml files
        const files = await fg('**/*.yml', { cwd: this.rootPath, absolute: true });

        for (const file of files) {
            const relativePath = path.relative(this.rootPath, file);
            if (relativePath === 'pack.yml') continue;

            const content = readFileSync(file, 'utf8');
            const { parsed, diagnostics } = parseYaml(content, relativePath);

            this.diagnostics.push(...diagnostics);

            if (parsed) {
                this.registry.addParsedDoc(parsed, this);
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

    async validate() {
        const biomes = this.registry.getObjectsByType('BIOME');
        for (const biome of biomes) {
            try {
                const effective = this.registry.getEffectiveObject('BIOME', biome.id, this);

                if (effective.palette) {
                    this.validatePalette(effective.palette, biome.parsedYaml.filePath);
                }
                if (effective.slant) {
                    for (const item of effective.slant) {
                        if (item.palette) {
                            this.validatePalette(item.palette, biome.parsedYaml.filePath);
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

    private validatePalette(palette: any, filePath: string) {
        // We need the parsed doc to get ranges
        const doc = this.registry.getAllDocs().find(d => d.filePath === filePath);

        if (!Array.isArray(palette)) {
            this.diagnostics.push({
                code: 'INVALID_PALETTE_STRUCTURE',
                message: 'Palette must be a sequence of layers.',
                severity: 'error',
                file: filePath
            });
            return;
        }

        for (const layer of palette) {
            if (typeof layer === 'object' && layer !== null && !Array.isArray(layer)) {
                const keys = Object.keys(layer);
                if (keys.length > 1) {
                    this.diagnostics.push({
                        code: 'INVALID_PALETTE_LAYER',
                        message: `Palette layer has multiple keys: [${keys.join(', ')}]. Each layer should be a single block/palette reference. (Likely caused by incorrect <<: merge in a list)`,
                        severity: 'error',
                        file: filePath
                    });
                } else if (keys.length === 1) {
                    const id = keys[0];
                    if (!id.includes(':')) {
                        if (!this.registry.getObject('PALETTE', id)) {
                            this.diagnostics.push({
                                code: 'PALETTE_MISSING',
                                message: `Referenced palette "${id}" not found. If this is a block ID, use "minecraft:${id}" or "BLOCK:minecraft:${id}".`,
                                severity: 'warning',
                                file: filePath
                            });
                        }
                    }
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
                this.diagnostics.push({
                    code: isLikelyFile ? 'STRUCTURE_REF_MISSING' : 'FEATURE_REF_MISSING',
                    message: `Referenced ${isLikelyFile ? 'structure' : 'feature/structure'} "${id}" not found in registry or structures/ directory.`,
                    severity: 'error',
                    file: doc.filePath,
                    range: range ? {
                        start: { ...doc.lineCounter.linePos(range[0]), offset: range[0] },
                        end: { ...doc.lineCounter.linePos(range[1]), offset: range[1] }
                    } : undefined
                });
            }
        }
    }
}
