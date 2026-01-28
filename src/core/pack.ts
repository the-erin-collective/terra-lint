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
                // This will trigger EXTENDS_TARGET_MISSING diagnostics if any
                this.registry.getEffectiveObject('BIOME', biome.id, this);
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
}
