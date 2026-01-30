import { Diagnostic, Severity } from '../types/diagnostic.js';
import ansis from 'ansis';

export type OutputFormat = 'pretty' | 'plain' | 'json';
export type ColorMode = 'auto' | 'always' | 'never';

export interface ReporterOptions {
    color: ColorMode;
    format: OutputFormat;
    warningsAsErrors: boolean;
}

export interface PackReport {
    name: string;
    path: string;
    diagnostics: Diagnostic[];
}

export interface SummaryStats {
    packs: { total: number; passed: number; warned: number; failed: number };
    files: { total: number; passed: number; warned: number; failed: number };
    categories: Record<string, { total: number; passed: number; warned: number; failed: number }>;
}

export class Reporter {
    private options: ReporterOptions;
    private shouldColor: boolean;

    constructor(options: ReporterOptions) {
        this.options = options;
        this.shouldColor = this.shouldUseColor();
    }

    private shouldUseColor(): boolean {
        if (this.options.color === 'never') return false;
        if (this.options.color === 'always') return true;
        
        // auto mode: check environment
        const hasColorEnv = process.env.NO_COLOR !== undefined;
        const hasForceColor = process.env.FORCE_COLOR !== undefined;
        const isTTY = process.stdout.isTTY;
        
        return !hasColorEnv && (hasForceColor || isTTY);
    }

    private colorize(text: string, color: (text: string) => string): string {
        return this.shouldColor ? color(text) : text;
    }

    private getSeverityIcon(severity: Severity): string {
        return severity === 'error' ? '✖' : '⚠';
    }

    private getSeverityColor(severity: Severity): (text: string) => string {
        return severity === 'error' ? ansis.red : ansis.yellow;
    }

    private formatDiagnostic(diagnostic: Diagnostic): string {
        const { file, code, message, severity, range } = diagnostic;
        const icon = this.getSeverityIcon(severity);
        const severityText = severity.toUpperCase();
        const location = range ? `:${range.start.line}:${range.start.col}` : '';
        
        if (this.options.format === 'json') {
            return JSON.stringify(diagnostic);
        }

        const coloredIcon = this.colorize(icon, this.getSeverityColor(severity));
        const coloredSeverity = this.colorize(severityText, this.getSeverityColor(severity));
        const coloredCode = this.colorize(`[${code}]`, ansis.cyan);
        const coloredLocation = this.colorize(`${file}${location}`, ansis.bold);
        
        return `  ${coloredIcon} ${coloredSeverity}  ${coloredCode}  ${coloredLocation}  ${message}`;
    }

    private formatContext(context: string): string {
        if (this.options.format === 'json') return '';
        return this.colorize(`    ↳ ${context}`, ansis.dim);
    }

    printBanner(version: string, packCount: number): void {
        if (this.options.format === 'json') return;

        const date = new Date().toLocaleString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });

        const header = this.colorize(`┌ terra-lint ${version}  •  Linting ${packCount} pack${packCount > 1 ? 's' : ''}  •  ${date}`, ansis.bold);
        const divider = this.colorize('└────────────────────────────────────────────────────────', ansis.dim);

        console.log(header);
        console.log(divider);
        console.log();
    }

    printPackHeader(packReport: PackReport): void {
        if (this.options.format === 'json') return;

        const packIcon = this.colorize('📦', ansis.green);
        const packName = this.colorize(`Pack: ${packReport.name}`, ansis.bold);
        const packPath = this.colorize(`(${packReport.path})`, ansis.dim);

        console.log(`${packIcon} ${packName}  ${packPath}`);
    }

    printDiagnostics(packReport: PackReport): void {
        if (this.options.format === 'json') {
            packReport.diagnostics.forEach(d => console.log(this.formatDiagnostic(d)));
            return;
        }

        if (packReport.diagnostics.length === 0) {
            const successIcon = this.colorize('✓', ansis.green);
            const successMsg = this.colorize('No issues found', ansis.green);
            console.log(`  ${successIcon} ${successMsg}`);
            return;
        }

        packReport.diagnostics.forEach(diagnostic => {
            console.log(this.formatDiagnostic(diagnostic));
            
            // Add context if available (e.g., file paths for duplicate IDs)
            if (diagnostic.path && diagnostic.path.length > 0) {
                console.log(this.formatContext(diagnostic.path.join(' → ')));
            }
        });
    }

    printSummary(stats: SummaryStats, totalErrors: number, totalWarnings: number): void {
        if (this.options.format === 'json') {
            console.log(JSON.stringify({
                summary: stats,
                totals: { errors: totalErrors, warnings: totalWarnings }
            }, null, 2));
            return;
        }

        const divider = this.colorize('────────────────────────────────────────────────────────', ansis.dim);
        console.log();
        console.log(divider);
        console.log(this.colorize('Summary', ansis.bold));

        // Overall stats
        const packsLine = `Packs: ${stats.packs.total}   Files: ${stats.files.total}  Passed: ${stats.files.passed}  Warned: ${stats.files.warned}  Failed: ${stats.files.failed}`;
        console.log(this.colorize(packsLine, this.shouldColor ? ansis.white : ansis.reset));

        // Category breakdown
        Object.entries(stats.categories).forEach(([category, catStats]) => {
            if (catStats.total > 0) {
                const catLine = `${category.charAt(0).toUpperCase() + category.slice(1)}: ${catStats.total} Passed: ${catStats.passed} Warned: ${catStats.warned} Failed: ${catStats.failed}`;
                console.log(this.colorize(catLine, this.shouldColor ? ansis.white : ansis.reset));
            }
        });

        // Exit code info
        const exitCode = totalErrors > 0 ? 1 : 0;
        const exitLine = `Exit code: ${exitCode}`;
        console.log(this.colorize(exitLine, exitCode === 0 ? ansis.green : ansis.red));
    }

    printSuccess(): void {
        if (this.options.format === 'json') return;

        console.log();
        const successIcon = this.colorize('✓', ansis.green);
        const successMsg = this.colorize('All checks passed!', ansis.green.bold);
        console.log(`${successIcon} ${successMsg}`);
    }

    printError(message: string): void {
        if (this.options.format === 'json') {
            console.error(JSON.stringify({ error: message }));
            return;
        }

        console.error(this.colorize(`Error: ${message}`, ansis.red));
    }

    printWarning(message: string): void {
        if (this.options.format === 'json') {
            console.warn(JSON.stringify({ warning: message }));
            return;
        }

        console.warn(this.colorize(`Warning: ${message}`, ansis.yellow));
    }

    printInfo(message: string): void {
        if (this.options.format === 'json') return;
        
        console.log(this.colorize(message, ansis.dim));
    }
}
