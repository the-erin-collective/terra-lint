import fg from 'fast-glob';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { parseYaml } from '../parser/yaml.js';
import { Registry } from './registry.js';
import { Diagnostic } from '../types/diagnostic.js';

export class Pack {
    public registry = new Registry();
    public diagnostics: Diagnostic[] = [];
    public rootPath: string;
    public stageIds: Set<string> = new Set();
    public structureFiles: Set<string> = new Set();

    constructor(rootPath: string) {
        this.rootPath = path.resolve(rootPath);
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
        const { parsed, diagnostics } = parseYaml(content, 'pack.yml');
        this.diagnostics.push(...diagnostics);
        if (parsed && parsed.doc.contents) {
            const contents = parsed.doc.contents as any;
            if (contents.get && contents.get('stages')) {
                const stages = contents.get('stages', true);
                if (Array.isArray(stages.items)) {
                    for (const item of stages.items) {
                        if (item) {
                            if (typeof item.value === 'string' || typeof item.value === 'number') {
                                this.stageIds.add(String(item.value).toUpperCase());
                            } else if (typeof item.get === 'function') {
                                const idNode = item.get('id', true);
                                if (idNode && (typeof idNode.value === 'string' || typeof idNode.value === 'number')) {
                                    this.stageIds.add(String(idNode.value).toUpperCase());
                                }
                            }
                        }
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
            const structFiles = await fg('**/*.{nbt,terra,tesf}', { cwd: structPath });
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
                if (effective.features && typeof effective.features === 'object') {
                    for (const [stageKey, stageFeatures] of Object.entries(effective.features)) {
                        if (!this.stageIds.has(stageKey.toUpperCase())) {
                            this.diagnostics.push({
                                code: 'STAGE_MISSING',
                                message: `Referenced stage "${stageKey}" not found in pack.yml`,
                                severity: 'error',
                                file: biome.parsedYaml.filePath
                            });
                        }
                        if (Array.isArray(stageFeatures)) {
                            for (const featureId of stageFeatures) {
                                if (typeof featureId === 'string') {
                                    this.validateStructureReference(featureId, biome.parsedYaml.filePath);
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

    private validateStructureReference(id: string, filePath: string) {
        // Dual Lookup: Registry or Filesystem
        const inRegistry = this.registry.getObject('STRUCTURE', id);
        if (inRegistry) return;

        // Filesystem check: path/to/name.nbt or just name.nbt
        const idUpper = id.toUpperCase().replace(/\\/g, '/');
        const hasMatch = Array.from(this.structureFiles).some(f =>
            f === idUpper || f.endsWith('/' + idUpper) || f.replace(/\.[^/.]+$/, "") === idUpper || f.replace(/\.[^/.]+$/, "").endsWith('/' + idUpper)
        );

        if (!hasMatch) {
            // It could also be a FEATURE reference, not just structure
            if (!this.registry.getObject('FEATURE', id)) {
                this.diagnostics.push({
                    code: 'FEATURE_MISSING',
                    message: `Referenced feature/structure "${id}" not found in registry or structures/ directory.`,
                    severity: 'error',
                    file: filePath
                });
            }
        }
    }
}
