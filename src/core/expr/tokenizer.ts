
export type Range = { start: number; end: number };

export type TokenType =
    | 'Number'
    | 'Ident'
    | 'Op'
    | 'LParen'
    | 'RParen'
    | 'Comma'
    | 'Pipe'
    | 'EOF';

export interface Token {
    kind: TokenType;
    value: string;
    range: Range;
}

export class TokenizerError extends Error {
    constructor(message: string, public range: Range) {
        super(message);
        this.name = 'TokenizerError';
    }
}

const OPS = ['<=', '>=', '==', '!=', '&&', '||', '^', '*', '/', '%', '+', '-', '<', '>'];

export function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let current = 0;

    while (current < input.length) {
        const char = input[current];

        // Skip whitespace
        if (/\s/.test(char)) {
            current++;
            continue;
        }

        // Number (integer or float)
        // Matches digits, optionally followed by .digits
        if (/[0-9]/.test(char)) {
            let start = current;
            let value = char;
            current++;

            while (current < input.length && /[0-9]/.test(input[current])) {
                value += input[current];
                current++;
            }

            if (current < input.length && input[current] === '.') {
                value += '.';
                current++;
                while (current < input.length && /[0-9]/.test(input[current])) {
                    value += input[current];
                    current++;
                }
            }

            tokens.push({
                kind: 'Number',
                value,
                range: { start, end: current }
            });
            continue;
        }

        // Identifier
        if (/[A-Za-z_]/.test(char)) {
            let start = current;
            let value = char;
            current++;

            while (current < input.length && /[A-Za-z0-9_]/.test(input[current])) {
                value += input[current];
                current++;
            }

            tokens.push({
                kind: 'Ident',
                value,
                range: { start, end: current }
            });
            continue;
        }

        // Operators
        // Check multi-char ops first
        let matchedOp = false;
        for (const op of OPS) {
            if (input.startsWith(op, current)) {
                tokens.push({
                    kind: 'Op',
                    value: op,
                    range: { start: current, end: current + op.length }
                });
                current += op.length;
                matchedOp = true;
                break;
            }
        }
        if (matchedOp) continue;

        // Punctuation & Single chars that weren't ops
        if (char === '(') {
            tokens.push({ kind: 'LParen', value: '(', range: { start: current, end: current + 1 } });
            current++;
            continue;
        }
        if (char === ')') {
            tokens.push({ kind: 'RParen', value: ')', range: { start: current, end: current + 1 } });
            current++;
            continue;
        }
        if (char === ',') {
            tokens.push({ kind: 'Comma', value: ',', range: { start: current, end: current + 1 } });
            current++;
            continue;
        }
        if (char === '|') {
            tokens.push({ kind: 'Pipe', value: '|', range: { start: current, end: current + 1 } });
            current++;
            continue;
        }

        throw new TokenizerError(`Unexpected character: '${char}'`, { start: current, end: current + 1 });
    }

    tokens.push({ kind: 'EOF', value: '', range: { start: current, end: current } });
    return tokens;
}
