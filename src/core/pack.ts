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

        const files = await fg('**/*.yml', { cwd: this.rootPath, absolute: true });

        for (const file of files) {
            const content = readFileSync(file, 'utf8');
            const relativePath = path.relative(this.rootPath, file);
            const { parsed, diagnostics } = parseYaml(content, relativePath);

            this.diagnostics.push(...diagnostics);

            if (parsed) {
                this.registry.addParsedDoc(parsed);
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
                    // If it's not a prefixed block ID (minecraft:...), check if it's a registered palette
                    if (!id.includes(':')) {
                        if (!this.registry.getObject('PALETTE', id)) {
                            this.diagnostics.push({
                                code: 'PALETTE_MISSING',
                                message: `Referenced palette "${id}" not found. If this is a block ID, use "minecraft:${id}" or "BLOCK:minecraft:${id}".`,
                                severity: 'warning', // Warning because it might be a block ID without prefix that Terra supports
                                file: filePath
                            });
                        }
                    }
                }
            }
        }
    }
}
