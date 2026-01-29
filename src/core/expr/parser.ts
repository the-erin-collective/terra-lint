
import { Token, TokenType, tokenize, Range } from './tokenizer.js';
import { Expr, ExprResult, ExprError } from './ast.js';

type PrefixParseFn = () => Expr;
type InfixParseFn = (left: Expr) => Expr;

// Precedence levels
const PRECEDENCE: Record<string, number> = {
    '||': 1,
    '&&': 2,
    '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
    '+': 4, '-': 4,
    '*': 5, '/': 5, '%': 5,
    '^': 6,
    // Unary operators will handle their own precedence binding
};

export class Parser {
    private tokens: Token[];
    private current: number = 0;
    private errors: ExprError[] = [];

    constructor(input: string) {
        try {
            this.tokens = tokenize(input);
        } catch (e: any) {
            // Tokenizer error is fatal for now, wrap as generic error
            this.tokens = [{ kind: 'EOF', value: '', range: { start: 0, end: 0 } }];
            this.errors.push({ message: e.message, range: e.range || { start: 0, end: 0 } });
        }
    }

    public parse(): ExprResult {
        if (this.errors.length > 0) {
            return { ok: false, errors: this.errors };
        }

        try {
            const expr = this.parseExpr(0);

            if (!this.isAtEnd()) {
                this.errors.push({
                    message: 'Unexpected tokens after expression',
                    range: this.peek().range
                });
            }

            return {
                ok: this.errors.length === 0,
                errors: this.errors,
                ast: this.errors.length === 0 ? expr : undefined
            };
        } catch (e: any) {
            // Recoverable error mechanism could be better, but for now catch thrown panics
            if (!this.errors.length) {
                this.errors.push({ message: e.message || 'Parse error', range: { start: 0, end: 0 } });
            }
            return { ok: false, errors: this.errors };
        }
    }

    private parseExpr(minPrecedence: number): Expr {
        let left = this.parsePrefix();

        while (this.getPrecedence() >= minPrecedence && !this.isAtEnd()) {
            const opToken = this.peek();

            // Handle Call Expression (Identifier followed by LParen is NOT handled here in basic infix loop unless we treat '(' as operator, 
            // BUT strict grammar: Ident is prefix. If we want function calls, they effectively bind tighter than ops.
            // Actually, Call is usually parsed in parsePrefix if it's prefix-position `func(...)`.
            // If we supported `expr.func()`, it would be infix.
            // Given spec `name(expr)`, it's a prefix production. "Ident" -> check for paren.

            // Handle Infix Operators
            if (opToken.kind === 'Op') {
                const op = this.advance().value;
                const precedence = PRECEDENCE[op];
                const isRightAssociative = op === '^';

                const nextPrecedence = isRightAssociative ? precedence : precedence + 1;
                const right = this.parseExpr(nextPrecedence);

                left = {
                    kind: 'Binary',
                    op,
                    left,
                    right,
                    range: { start: left.range.start, end: right.range.end }
                };
            } else {
                break;
            }
        }

        return left;
    }

    private parsePrefix(): Expr {
        if (this.isAtEnd()) {
            throw this.error(this.peek(), 'Unexpected end of expression');
        }

        const token = this.advance();

        // Number
        if (token.kind === 'Number') {
            return { kind: 'Number', value: token.value, range: token.range };
        }

        // Ident or Call
        if (token.kind === 'Ident') {
            // Check for Function Call: Ident ( ... )
            if (this.match('LParen')) {
                const args: Expr[] = [];
                if (!this.check('RParen')) {
                    do {
                        args.push(this.parseExpr(0));
                    } while (this.match('Comma'));
                }
                const rparen = this.consume('RParen', 'Expected closing ")" after function arguments');
                return {
                    kind: 'Call',
                    callee: token.value,
                    args,
                    range: { start: token.range.start, end: rparen.range.end }
                };
            }
            return { kind: 'Ident', name: token.value, range: token.range };
        }

        // Parentheses (Grouping)
        if (token.kind === 'LParen') {
            const expr = this.parseExpr(0);
            this.consume('RParen', 'Expected closing ")"');
            // Grouping doesn't add an AST node, just passes range if needed, or we can wrap?
            // Usually we return the inner expr. Range adjustment might be nice but AST structure is key.
            return expr;
        }

        // Absolute Value |expr|
        if (token.kind === 'Pipe') {
            const expr = this.parseExpr(0);
            const closing = this.consume('Pipe', 'Expected closing "|" for absolute value');
            return {
                kind: 'Abs',
                expr,
                range: { start: token.range.start, end: closing.range.end }
            };
        }

        // Unary Operators
        if (token.kind === 'Op' && (token.value === '-' || token.value === '+')) {
            // Unary precedence is high (3 in our 0-indexed chart? Protocol says 3, below power (4 in mine)).
            // Wait, spec says: 2. Abs, 3. Unary, 4. Power.
            // My PRECEDENCE consts need alignment.
            // Power ^ is 6.
            // Unary should be higher than * (5) and ^ (6) or lower?
            // Spec: 
            // 1. call
            // 2. abs
            // 3. unary + -
            // 4. power ^
            // 5. * / %

            // So Unary binds TIGHTER than power? Standard math: -2^2 = -4 (power binds tighter).
            // Spec says: Unary (3) > Power (4). Wait, "1. (highest)" in spec means 1 is strongest?
            // Spec: "1. function call ... 3. unary ... 4. power ... 5. mult"
            // If 1 is highest, then Unary is strong. -2^2 parsed as (-2)^2 ?
            // Usually -2^2 is -(2^2). 
            // Let's stick to the spec literal text if possible, or standard math conventions if ambiguous.
            // "Precedence table (highest to lowest): 3. unary, 4. power".
            // This implies unary binds TIGHTER. (-x)^y.
            // I will implement Unary with high binding power.

            // Let's pick a numeric value. 
            // || = 1
            // && = 2
            // comp = 3
            // + - = 4
            // * / = 5
            // ^ = 6
            // Unary = 7

            const right = this.parseExpr(7);
            return {
                kind: 'Unary',
                op: token.value as '+' | '-',
                expr: right,
                range: { start: token.range.start, end: right.range.end }
            };
        }

        throw this.error(token, `Unexpected token: ${token.kind} "${token.value}"`);
    }

    private getPrecedence(): number {
        if (this.isAtEnd()) return 0;
        const token = this.peek();
        if (token.kind !== 'Op') return 0;
        return PRECEDENCE[token.value] || 0;
    }

    // Helpers
    private isAtEnd(): boolean {
        return this.peek().kind === 'EOF';
    }

    private peek(): Token {
        return this.tokens[this.current];
    }

    private advance(): Token {
        if (!this.isAtEnd()) this.current++;
        return this.tokens[this.current - 1];
    }

    private check(kind: TokenType): boolean {
        if (this.isAtEnd()) return false;
        return this.peek().kind === kind;
    }

    private match(kind: TokenType): boolean {
        if (this.check(kind)) {
            this.advance();
            return true;
        }
        return false;
    }

    private consume(kind: TokenType, message: string): Token {
        if (this.check(kind)) return this.advance();
        throw this.error(this.peek(), message);
    }

    private error(token: Token, message: string): Error {
        const err = { message, range: token.range };
        this.errors.push(err);
        return new Error(message); // Throw to unwind
    }
}

export function parseExpression(input: string): ExprResult {
    return new Parser(input).parse();
}
