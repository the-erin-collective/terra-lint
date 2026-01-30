#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { Pack } from './core/pack.js';
import { Diagnostic } from './types/diagnostic.js';
import { parse } from 'yaml';
import { Reporter, ReporterOptions, PackReport, SummaryStats } from './core/reporter.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const program = new Command();

program
    .name('terra-lint')
    .description('Terra config pack validator / linter')
    .version(pkg.version)
    .argument('<path>', 'Path to a Terra pack root or a workspace directory')
    .option('--strict', 'Treat warnings as errors', false)
    .option('--json', 'Output report in JSON format', false)
    .option('--color <auto|always|never>', 'Color output (auto, always, never)', 'auto')
    .option('--format <pretty|plain|json>', 'Output format (pretty, plain, json)', 'pretty')
    .option('--warnings-as-errors', 'Treat warnings as errors', false)
    .option('--max-warnings <number>', 'Maximum number of warnings allowed', '-1')
    .option('--structure-ext <csv>', 'Comma-separated structure extensions (no dots), e.g. "nbt,tesf", "nbt"', 'nbt')
    .option('--include <dir>', 'Add an external directory for meta-reference resolution (can be used multiple times)', (val, memo: string[]) => { memo.push(val); return memo; }, [])
    .option('--ignore <glob>', 'Ignore files matching the given glob patterns (can be used multiple times)', (val, memo: string[]) => { memo.push(val); return memo; }, [])
    .option('--config <path>', 'Path to a custom config file (defaults to .terra-lint.yml in pack root)')
    .option('--profile <name>', 'Use a specific profile from the config file')
    .option('--workspace', 'Enable Workspace Mode: recursively search for all pack.yml files in the given path', false)
    .action(async (targetPath: string, options: any) => {
        // Handle backward compatibility
        if (options.json) {
            options.format = 'json';
        }
        if (options.strict) {
            options.warningsAsErrors = true;
        }

        // Initialize reporter
        const reporterOptions: ReporterOptions = {
            color: options.color || 'auto',
            format: options.format || 'pretty',
            warningsAsErrors: options.warningsAsErrors || false
        };
        const reporter = new Reporter(reporterOptions);

        let packRoots: string[] = [];
        const isWorkspace = options.workspace;

        if (isWorkspace) {
            reporter.printInfo(`Scanning workspace for packs: ${targetPath}`);
            const matches = await fg('**/pack.yml', { cwd: targetPath, absolute: true, ignore: ['**/node_modules/**'] });
            packRoots = matches.map(m => path.dirname(m));
            reporter.printInfo(`Found ${packRoots.length} packs.`);
            console.log();
        } else {
            if (existsSync(path.join(targetPath, 'pack.yml'))) {
                packRoots = [targetPath];
            } else {
                reporter.printError(`No pack.yml found in ${targetPath}. Use --workspace to scan subdirectories.`);
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
                    reporter.printWarning(`Failed to parse config file at ${configPath}`);
                }
            }

            const pack = new Pack(root, packOptions);
            const packName = path.basename(root);
            
            // Print banner only once
            if (packRoots.indexOf(root) === 0) {
                reporter.printBanner(pkg.version, packRoots.length);
            }
            
            // Create pack report
            const packReport: PackReport = {
                name: packName,
                path: pack.rootPath,
                diagnostics: []
            };

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
            
            packReport.diagnostics = pack.diagnostics;
            allDiagnostics.push(...pack.diagnostics);
        }

        allDiagnostics.sort((a, b) => {
            if (a.file !== b.file) return a.file.localeCompare(b.file);
            const lineA = a.range?.start.line ?? 0;
            const lineB = b.range?.start.line ?? 0;
            if (lineA !== lineB) return lineA - lineB;
            const colA = a.range?.start.col ?? 0;
            const colB = b.range?.start.col ?? 0;
            return a.code.localeCompare(b.code);
        });

        // Print all pack reports
        for (const root of packRoots) {
            const packName = path.basename(root);
            const packDiagnostics = allDiagnostics.filter(d => 
                isWorkspace ? d.file.startsWith(`[${packName}]`) : d.file.includes(root)
            );
            
            const packReport: PackReport = {
                name: packName,
                path: root,
                diagnostics: packDiagnostics
            };
            
            reporter.printPackHeader(packReport);
            reporter.printDiagnostics(packReport);
            
            if (packRoots.indexOf(root) < packRoots.length - 1) {
                console.log();
            }
        }

        // Create summary stats (basic version for now)
        const summaryStats: SummaryStats = {
            packs: { 
                total: packRoots.length, 
                passed: packRoots.length - (totalErrors > 0 ? 1 : 0), 
                warned: 0, 
                failed: totalErrors > 0 ? 1 : 0 
            },
            files: { 
                total: allDiagnostics.length || 1, 
                passed: (allDiagnostics.length || 1) - totalErrors - totalWarnings, 
                warned: totalWarnings, 
                failed: totalErrors 
            },
            categories: {} // Will be populated in Phase 3
        };

        reporter.printSummary(summaryStats, totalErrors, totalWarnings);

        if (totalErrors === 0 && totalWarnings === 0) {
            reporter.printSuccess();
        }

        if (totalErrors > 0) process.exit(1);

        const maxWarnings = options.maxWarnings !== undefined ? parseInt(options.maxWarnings) : -1;
        if (options.warningsAsErrors && totalWarnings > 0) {
            reporter.printError('Strict mode: failing due to warnings.');
            process.exit(1);
        }
        if (maxWarnings >= 0 && totalWarnings > maxWarnings) {
            reporter.printError(`Failing due to exceeding max warnings (${totalWarnings} > ${maxWarnings}).`);
            process.exit(1);
        }
    });

program.parse();
