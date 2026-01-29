export interface ValidationResult {
    isValid: boolean;
    message?: string;
}

/**
 * Sanity-checks a Terra expression for common syntax errors.
 * This is NOT a full parser. It checks:
 * - Balanced parentheses
 * - Balanced absolute value pipes (|...|)
 * 
 * It does NOT validate operator usage, function calls, or the full Paralithic grammar.
 */
export function validateExpression(expr: string): ValidationResult {
    // Check balanced parentheses
    let parenDepth = 0;
    for (const char of expr) {
        if (char === '(') parenDepth++;
        if (char === ')') parenDepth--;
        if (parenDepth < 0) return { isValid: false, message: 'Unbalanced parentheses: too many closed parentheses' };
    }
    if (parenDepth !== 0) return { isValid: false, message: 'Unbalanced parentheses: missing closed parentheses' };

    // Check balanced absolute value pipes (|...|)
    // Count pipes and ensure they are paired. This is a heuristic, as `||` is also valid (logical OR).
    const pipeCount = (expr.match(/\|/g) || []).length;
    if (pipeCount % 2 !== 0) return { isValid: false, message: 'Unbalanced absolute value pipes' };

    return { isValid: true };
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
