#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'fs';
import path from 'path';
import { Pack } from './core/pack.js';
import { Diagnostic } from './types/diagnostic.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const program = new Command();

program
    .name('terra-lint')
    .description('Terra config pack validator / linter')
    .version(pkg.version)
    .argument('<packRoot>', 'Path to the Terra config pack root')
    .option('--strict', 'Treat warnings as errors', false)
    .option('--json', 'Output report in JSON format', false)
    .option('--max-warnings <number>', 'Maximum number of warnings allowed', '-1')
    .option('--structure-ext <csv>', 'Comma-separated structure extensions (no dots), e.g. "nbt,tesf", "nbt"', 'nbt')
    .action(async (packRoot: string, options: any) => {
        const exts = String(options.structureExt || 'nbt')
            .split(',')
            .map((s: string) => s.trim().replace(/^\./, ''))
            .filter(Boolean);

        const pack = new Pack(packRoot, { structureExtensions: exts });
        console.log(`Linting pack at: ${pack.rootPath}`);

        await pack.load();
        await pack.validate();

        const errors = pack.diagnostics.filter(d => d.severity === 'error');
        const warnings = pack.diagnostics.filter(d => d.severity === 'warning');

        if (options.json) {
            console.log(JSON.stringify(pack.diagnostics, null, 2));
        } else {
            for (const d of pack.diagnostics) {
                const loc = d.range ? `:${d.range.start.line}:${d.range.start.col}` : '';
                console.log(`${d.file}${loc} [${d.code}] ${d.severity}: ${d.message}`);
            }

            console.log(`\nFound ${errors.length} errors and ${warnings.length} warnings.`);
        }

        if (errors.length > 0) {
            process.exit(1);
        }

        const maxWarnings = options.maxWarnings !== undefined ? parseInt(options.maxWarnings) : -1;
        if (options.strict && warnings.length > 0) {
            console.error('\nStrict mode: failing due to warnings.');
            process.exit(1);
        }
        if (maxWarnings >= 0 && warnings.length > maxWarnings) {
            console.error(`\nFailing due to exceeding max warnings (${warnings.length} > ${maxWarnings}).`);
            process.exit(1);
        }
    });

program.parse();
