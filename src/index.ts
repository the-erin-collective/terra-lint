#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { Pack } from './core/pack.js';
import { Diagnostic } from './types/diagnostic.js';
import { parse } from 'yaml';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const program = new Command();

program
    .name('terra-lint')
    .description('Terra config pack validator / linter')
    .version(pkg.version)
    .argument('<path>', 'Path to a Terra pack root or a workspace directory')
    .option('--strict', 'Treat warnings as errors', false)
    .option('--json', 'Output report in JSON format', false)
    .option('--max-warnings <number>', 'Maximum number of warnings allowed', '-1')
    .option('--structure-ext <csv>', 'Comma-separated structure extensions (no dots), e.g. "nbt,tesf", "nbt"', 'nbt')
    .option('--include <dir>', 'Add an external directory for meta-reference resolution (can be used multiple times)', (val, memo: string[]) => { memo.push(val); return memo; }, [])
    .option('--ignore <glob>', 'Ignore files matching the given glob patterns (can be used multiple times)', (val, memo: string[]) => { memo.push(val); return memo; }, [])
    .option('--config <path>', 'Path to a custom config file (defaults to .terra-lint.yml in pack root)')
    .option('--profile <name>', 'Use a specific profile from the config file')
    .option('--workspace', 'Enable Workspace Mode: recursively search for all pack.yml files in the given path', false)
    .action(async (targetPath: string, options: any) => {
        let packRoots: string[] = [];
        const isWorkspace = options.workspace;

        if (isWorkspace) {
            console.log(`Scanning workspace for packs: ${targetPath}`);
            const matches = await fg('**/pack.yml', { cwd: targetPath, absolute: true, ignore: ['**/node_modules/**'] });
            packRoots = matches.map(m => path.dirname(m));
            console.log(`Found ${packRoots.length} packs.\n`);
        } else {
            if (existsSync(path.join(targetPath, 'pack.yml'))) {
                packRoots = [targetPath];
            } else {
                console.error(`Error: No pack.yml found in ${targetPath}. Use --workspace to scan subdirectories.`);
                process.exit(1);
            }
        }

        let allDiagnostics: Diagnostic[] = [];
        let totalErrors = 0;
        let totalWarnings = 0;

        function applyConfig(source: any, target: any) {
            if (!source) return;
            if (source.include) target.includePaths.push(...(Array.isArray(source.include) ? source.include : [source.include]));
            if (source.structureExt) target.structureExtensions.push(...(Array.isArray(source.structureExt) ? source.structureExt : [source.structureExt]));
            if (source.ignore) target.ignore.push(...(Array.isArray(source.ignore) ? source.ignore : [source.ignore]));
            if (source.rules) {
                target.rules = { ...target.rules, ...source.rules };
            }
        }

        for (const root of packRoots) {
            const configPath = options.config || path.join(root, '.terra-lint.yml');
            let packOptions: any = {
                structureExtensions: options.structureExt?.split(',').map((s: string) => s.trim().replace(/^\./, '')).filter(Boolean) || ['nbt'],
                includePaths: [...(options.include || [])],
                ignore: [...(options.ignore || [])]
            };

            if (existsSync(configPath)) {
                try {
                    const config = parse(readFileSync(configPath, 'utf8'));
                    if (config) {
                        applyConfig(config, packOptions);
                        if (options.profile && config.profiles && config.profiles[options.profile]) {
                            applyConfig(config.profiles[options.profile], packOptions);
                        }
                    }
                } catch (e) {
                    console.warn(`Warning: Failed to parse config file at ${configPath}`);
                }
            }

            const pack = new Pack(root, packOptions);
            const packName = path.basename(root);
            console.log(`Linting pack [${packName}] at: ${pack.rootPath}`);

            await pack.load();
            await pack.validate();

            const errors = pack.diagnostics.filter(d => d.severity === 'error');
            const warnings = pack.diagnostics.filter(d => d.severity === 'warning');

            totalErrors += errors.length;
            totalWarnings += warnings.length;

            if (isWorkspace) {
                for (const d of pack.diagnostics) {
                    d.file = `[${packName}] ${d.file}`;
                }
            }
            allDiagnostics.push(...pack.diagnostics);
        }

        allDiagnostics.sort((a, b) => {
            if (a.file !== b.file) return a.file.localeCompare(b.file);
            const lineA = a.range?.start.line ?? 0;
            const lineB = b.range?.start.line ?? 0;
            if (lineA !== lineB) return lineA - lineB;
            const colA = a.range?.start.col ?? 0;
            const colB = b.range?.start.col ?? 0;
            if (colA !== colB) return colA - colB;
            return a.code.localeCompare(b.code);
        });

        if (options.json) {
            console.log(JSON.stringify(allDiagnostics, null, 2));
        } else {
            allDiagnostics.forEach(d => {
                const loc = d.range ? `:${d.range.start.line}:${d.range.start.col}` : '';
                console.log(`${d.file}${loc} [${d.code}] ${d.severity}: ${d.message}`);
            });

            if (isWorkspace) {
                console.log(`\nFinal Workspace Report: Found ${totalErrors} errors and ${totalWarnings} warnings across ${packRoots.length} packs.`);
            } else {
                console.log(`\nFound ${totalErrors} errors and ${totalWarnings} warnings.`);
            }
        }

        if (totalErrors > 0) process.exit(1);

        const maxWarnings = options.maxWarnings !== undefined ? parseInt(options.maxWarnings) : -1;
        if (options.strict && totalWarnings > 0) {
            console.error('\nStrict mode: failing due to warnings.');
            process.exit(1);
        }
        if (maxWarnings >= 0 && totalWarnings > maxWarnings) {
            console.error(`\nFailing due to exceeding max warnings (${totalWarnings} > ${maxWarnings}).`);
            process.exit(1);
        }
    });

program.parse();
