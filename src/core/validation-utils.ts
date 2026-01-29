import { parseExpression } from './expr/parser.js';
import { ExprError } from './expr/ast.js';

export interface ValidationResult {
    isValid: boolean;
    errors?: ExprError[];
    message?: string; // Kept for backward compat if needed, or derived
}

/**
 * Parses and validates a Terra expression using the Paralithic grammar.
 */
export function validateExpression(expr: string): ValidationResult {
    const result = parseExpression(expr);
    if (result.ok) {
        return { isValid: true };
    }
    return {
        isValid: false,
        errors: result.errors,
        message: result.errors.map(e => e.message).join('; ')
    };
}

/**
 * Validates Minecraft block state syntax: namespace:id[key=value,...]
 */
export function validateBlockState(state: string): ValidationResult {
    const firstBracket = state.indexOf('[');
    if (firstBracket === -1) return { isValid: true }; // Scalar ID is valid

    const lastBracket = state.lastIndexOf(']');
    if (lastBracket === -1 || lastBracket < firstBracket) {
        return { isValid: false, message: 'Missing closing bracket "]" for block state' };
    }

    const statePart = state.substring(firstBracket + 1, lastBracket);
    if (statePart.trim()) {
        const pairs = statePart.split(',');
        for (const pair of pairs) {
            const eqIndex = pair.indexOf('=');
            if (eqIndex === -1 || eqIndex === 0 || eqIndex === pair.length - 1) {
                return { isValid: false, message: `Malformed state pair: "${pair}". Expected "key=value"` };
            }
        }
    }

    // Check if there's anything after the closing bracket
    if (state.substring(lastBracket + 1).trim() !== '') {
        return { isValid: false, message: 'Trailing characters after closing bracket' };
    }

    return { isValid: true };
}

/**
 * Checks if a string contains Terra interpolation ${...}
 */
export function hasInterpolation(val: string): boolean {
    return val.includes('${');
}
