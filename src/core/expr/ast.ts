
import { Range } from './tokenizer.js';

export type Expr =
    | { kind: 'Number'; value: string; range: Range }
    | { kind: 'Ident'; name: string; range: Range }
    | { kind: 'Unary'; op: '+' | '-'; expr: Expr; range: Range }
    | { kind: 'Binary'; op: string; left: Expr; right: Expr; range: Range }
    | { kind: 'Call'; callee: string; args: Expr[]; range: Range }
    | { kind: 'Abs'; expr: Expr; range: Range };

export interface ExprError {
    message: string;
    range: Range;
}

export interface ExprResult {
    ok: boolean;
    errors: ExprError[];
    ast?: Expr;
}
