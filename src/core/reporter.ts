import { Diagnostic, Severity, FileCategory, PackStats, FileStats, CategoryStats } from '../types/diagnostic.js';
import ansis from 'ansis';

export type OutputFormat = 'pretty' | 'plain' | 'json' | 'compact';
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
    categories: Record<FileCategory, CategoryStats>;
}

export class Reporter {
    private options: ReporterOptions;
    private shouldColor: boolean;
    private startTime: number;

    constructor(options: ReporterOptions) {
        this.options = options;
        this.shouldColor = this.shouldUseColor();
        this.startTime = Date.now();
    }

    private shouldUseColor(): boolean {
        if (this.options.color === 'never') return false;
        if (this.options.color === 'always') return true;
        if (this.options.format === 'plain') return false; // Plain format never uses color
        
        // auto mode: check environment
        const hasColorEnv = process.env.NO_COLOR !== undefined;
        const hasForceColor = process.env.FORCE_COLOR !== undefined;
        const isTTY = process.stdout.isTTY;
        
        return !hasColorEnv && (hasForceColor || isTTY);
    }

    private getElapsedTime(): string {
        const elapsed = Date.now() - this.startTime;
        const seconds = (elapsed / 1000).toFixed(2);
        return seconds;
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
        if (this.options.format === 'json' || this.options.format === 'compact') {
            return;
        }

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
        if (this.options.format === 'json' || this.options.format === 'compact') {
            return;
        }

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

        if (this.options.format === 'compact') {
            packReport.diagnostics.forEach(d => console.log(this.formatCompactDiagnostic(d)));
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

    private formatCompactDiagnostic(diagnostic: Diagnostic): string {
        const { file, code, message, severity, range } = diagnostic;
        const location = range ? `:${range.start.line}:${range.start.col}` : '';
        const severityChar = severity === 'error' ? 'E' : 'W';
        
        return `${file}${location} [${code}] ${severityChar}: ${message}`;
    }

    printSummary(stats: SummaryStats, totalErrors: number, totalWarnings: number): void {
        if (this.options.format === 'json') {
            console.log(JSON.stringify({
                summary: stats,
                totals: { errors: totalErrors, warnings: totalWarnings },
                timing: { elapsedSeconds: this.getElapsedTime() }
            }, null, 2));
            return;
        }

        if (this.options.format === 'compact') {
            // Compact format: just show totals
            console.log(`Summary: ${totalErrors} errors, ${totalWarnings} warnings (${this.getElapsedTime()}s)`);
            return;
        }

        const divider = this.colorize('────────────────────────────────────────────────────────', ansis.dim);
        console.log();
        console.log(divider);
        console.log(this.colorize('Summary', ansis.bold));
        console.log();

        // Overall stats with better spacing
        console.log(this.colorize('Pack files:', ansis.cyan) + ` ${stats.packs.total}`);
        this.printStatusLine(stats.packs.passed, stats.packs.warned, stats.packs.failed);
        console.log();

        console.log(this.colorize('Files:', ansis.cyan) + ` ${stats.files.total}`);
        this.printStatusLine(stats.files.passed, stats.files.warned, stats.files.failed);
        console.log();

        // Category breakdown with better spacing
        Object.entries(stats.categories).forEach(([category, catStats]) => {
            if (catStats.total > 0) {
                const categoryName = category.charAt(0).toUpperCase() + category.slice(1);
                console.log(this.colorize(`${categoryName}:`, ansis.cyan) + ` ${catStats.total}`);
                this.printStatusLine(catStats.passed, catStats.warned, catStats.failed);
                console.log();
            }
        });

        // Timing info
        const timingLine = `Linted ${stats.files.total} files in ${this.getElapsedTime()}s`;
        console.log(this.colorize(timingLine, ansis.dim));

        // Exit code info
        const exitCode = totalErrors > 0 ? 1 : 0;
        const exitLine = `Exit code: ${exitCode}`;
        console.log(this.colorize(exitLine, exitCode === 0 ? ansis.green : ansis.red));
    }

    private printStatusLine(passed: number, warned: number, failed: number): void {
        const passedStr = this.colorize(`Passed: ${passed}`, ansis.green);
        const warnedStr = this.colorize(`Warned: ${warned}`, warned > 0 ? ansis.yellow : ansis.dim);
        const failedStr = this.colorize(`Failed: ${failed}`, failed > 0 ? ansis.red : ansis.dim);
        
        console.log(`  ${passedStr}  ${warnedStr}  ${failedStr}`);
    }

    printSuccess(): void {
        if (this.options.format === 'json' || this.options.format === 'compact') {
            return;
        }

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
