#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { Pack } from './core/pack.js';
import { Diagnostic } from './types/diagnostic.js';

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
    .option('--workspace', 'Enable Workspace Mode: recursively search for all pack.yml files in the given path', false)
    .action(async (targetPath: string, options: any) => {
        const exts = String(options.structureExt || 'nbt')
            .split(',')
            .map((s: string) => s.trim().replace(/^\./, ''))
            .filter(Boolean);

        const includePaths = options.include || [];
        const isWorkspace = options.workspace;

        let packRoots: string[] = [];

        if (isWorkspace) {
            console.log(`Scanning workspace for packs: ${targetPath}`);
            const matches = await fg('**/pack.yml', { cwd: targetPath, absolute: true });
            packRoots = matches.map(m => path.dirname(m));
            console.log(`Found ${packRoots.length} packs.\n`);
        } else {
            // Check if current path is a pack
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

        for (const root of packRoots) {
            const pack = new Pack(root, { structureExtensions: exts, includePaths });
            const packName = path.basename(root);
            console.log(`Linting pack [${packName}] at: ${pack.rootPath}`);

            await pack.load();
            await pack.validate();

            const errors = pack.diagnostics.filter(d => d.severity === 'error');
            const warnings = pack.diagnostics.filter(d => d.severity === 'warning');

            totalErrors += errors.length;
            totalWarnings += warnings.length;

            // Prefix diagnostics with pack name if in workspace mode
            if (isWorkspace) {
                for (const d of pack.diagnostics) {
                    d.file = `[${packName}] ${d.file}`;
                }
            }

            allDiagnostics.push(...pack.diagnostics);

            if (!options.json) {
                for (const d of pack.diagnostics) {
                    const loc = d.range ? `:${d.range.start.line}:${d.range.start.col}` : '';
                    console.log(`${d.file}${loc} [${d.code}] ${d.severity}: ${d.message}`);
                }
                console.log(`Found ${errors.length} errors and ${warnings.length} warnings in [${packName}].\n`);
            }
        }

        if (options.json) {
            console.log(JSON.stringify(allDiagnostics, null, 2));
        }

        if (isWorkspace && !options.json) {
            console.log(`Final Workspace Report: Found ${totalErrors} errors and ${totalWarnings} warnings across ${packRoots.length} packs.`);
        }

        if (totalErrors > 0) {
            process.exit(1);
        }

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
