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
    .action(async (packRoot: string, options: any) => {
        const pack = new Pack(packRoot);
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
    });

program.parse();
