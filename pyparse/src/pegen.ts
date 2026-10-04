// The parser runtime: a port of CPython 3.14's Parser/pegen.c and
// Parser/pegen_errors.c.  The generated parser (parser.gen.ts) extends
// BaseParser.  Errors are thrown as PegenError; CPython's "first error
// wins / error_indicator" discipline maps onto exceptions directly.

import * as T from "./tokens.gen";
import { TokState, RawToken, decodeBytes, E_OK, E_DONE, E_EOF, E_TOKEN, E_DEDENT, E_TABSPACE, E_TOODEEP, E_LINECONT, E_ERROR } from "./lexer";

export class Token {
  type: number;
  str: string; // the token text (PyBytes in CPython), decoded
  level: number;
  lineno: number;
  col_offset: number;
  end_lineno: number;
  end_col_offset: number;
  metadata: string | null;
  memo: Map<number, { node: any; mark: number }> | null = null;
  /** CPython's t->bytes (the token text). */
  get bytes(): string {
    return this.str;
  }
  constructor(type: number, str: string, raw: RawToken) {
    this.type = type;
    this.str = str;
    this.level = raw.level;
    this.lineno = raw.lineno;
    this.col_offset = raw.col_offset;
    this.end_lineno = raw.end_lineno;
    this.end_col_offset = raw.end_col_offset;
    this.metadata = raw.metadata;
  }
}

export interface SyntaxErrorInfo {
  type: string;
  msg: string;
  lineno: number;
  offset: number;
  text: string | null;
  end_lineno: number;
  end_offset: number;
}

export class PegenError extends Error {
  constructor(public info: SyntaxErrorInfo) {
    super(`${info.type}: ${info.msg}`);
  }
}

export const CURRENT_POS = -5;

/** _PyPegen_byte_offset_to_character_offset: col is a 1-based byte offset into line. */
export function byteToCharOffset(line: string, col: number): number {
  const bytes = new TextEncoder().encode(line);
  if (col > bytes.length + 1) col = bytes.length + 1;
  if (col < 0) col = 0;
  // CPython decodes col bytes of the C string, so an offset one past the
  // end also counts its terminating NUL.
  const n = [...new TextDecoder().decode(bytes.subarray(0, Math.min(col, bytes.length)))].length;
  return n + (col > bytes.length ? 1 : 0);
}

export abstract class BaseParser {
  tok: TokState;
  tokens: Token[] = [];
  mark = 0;
  fill = 0;
  call_invalid_rules = false;
  flags = 0;
  feature_version = 14;
  known_err_token: Token | null = null;
  last_stmt_location = { lineno: 0, col_offset: 0, end_lineno: 0, end_col_offset: 0 };
  parsing_started = false;
  abstract keywords: Record<string, number>;
  abstract soft_keywords: string[];
  filename = "<string>";

  constructor(source: string) {
    this.tok = new TokState(source);
  }

  errorOccurred(): boolean {
    return false;
  }

  // ---- tokens

  fill_token(): void {
    const raw: RawToken = { type: 0, start: -1, end: -1, level: 0, lineno: 0, col_offset: -1, end_lineno: 0, end_col_offset: -1, metadata: null };
    const type = this.tok.get(raw);
    this.parsing_started = true;
    let t = type;
    const str = raw.start >= 0 ? decodeBytes(this.tok.buf, raw.start, raw.end) : "";
    if (t === T.NAME) {
      // Own properties only: "constructor" is an ordinary name.
      if (Object.hasOwn(this.keywords, str)) t = this.keywords[str];
    }
    this.tokens[this.fill] = new Token(t, str, raw);
    this.fill += 1;
    if (type === T.ERRORTOKEN) this.tokenizer_error();
  }

  fill_if_needed(): void {
    if (this.mark === this.fill) this.fill_token();
  }

  /** _Pypegen_tokenizer_error */
  tokenizer_error(): never {
    const tok = this.tok;
    if (tok.error) throw new PegenError({ ...tok.error });
    let msg = "unknown parsing error";
    let errtype = "SyntaxError";
    let col = -1;
    switch (tok.done) {
      case E_TOKEN:
        msg = "invalid token";
        break;
      case E_EOF:
        if (tok.level) this.raise_unclosed_parentheses_error();
        RAISE_SYNTAX_ERROR(this, "unexpected EOF while parsing");
        break;
      case E_DEDENT:
        RAISE_INDENTATION_ERROR(this, "unindent does not match any outer indentation level");
        break;
      case E_TABSPACE:
        errtype = "TabError";
        msg = "inconsistent use of tabs and spaces in indentation";
        break;
      case E_TOODEEP:
        errtype = "IndentationError";
        msg = "too many levels of indentation";
        break;
      case E_LINECONT:
        col = tok.cur - tok.bufStart - 1;
        msg = "unexpected character after line continuation character";
        break;
    }
    RAISE_ERROR_KNOWN_LOCATION(this, errtype, tok.lineno, col >= 0 ? col : 0, tok.lineno, -1, msg);
  }

  raise_unclosed_parentheses_error(): never {
    const tok = this.tok;
    const lineno = tok.parenlinenostack[tok.level - 1];
    const col = tok.parencolstack[tok.level - 1];
    RAISE_ERROR_KNOWN_LOCATION(this, "SyntaxError", lineno, col, lineno, -1,
      `'${String.fromCharCode(tok.parenstack[tok.level - 1])}' was never closed`);
  }

  expect(type: number): Token | null {
    if (this.mark === this.fill) this.fill_token();
    const t = this.tokens[this.mark];
    if (t.type !== type) return null;
    this.mark += 1;
    return t;
  }

  expect_forced_token(type: number, expected: string): Token {
    if (this.mark === this.fill) this.fill_token();
    const t = this.tokens[this.mark];
    if (t.type !== type) RAISE_SYNTAX_ERROR_KNOWN_LOCATION(this, t, `expected '${expected}'`);
    this.mark += 1;
    return t;
  }

  expect_forced_result(result: any, expected: string): any {
    if (result === null || result === undefined) RAISE_SYNTAX_ERROR(this, `expected (${expected})`);
    return result;
  }

  expect_soft_keyword(keyword: string): any {
    if (this.mark === this.fill) this.fill_token();
    const t = this.tokens[this.mark];
    if (t.type !== T.NAME || t.str !== keyword) return null;
    return this.name_token();
  }

  lookahead(positive: boolean, fn: () => any): boolean {
    const mark = this.mark;
    const res = fn();
    this.mark = mark;
    return (res !== null && res !== undefined && res !== false) === positive;
  }

  get_last_nonnwhitespace_token(): Token {
    let token: Token | null = null;
    for (let m = this.mark - 1; m >= 0; m--) {
      token = this.tokens[m];
      if (token.type !== T.ENDMARKER && (token.type < T.NEWLINE || token.type > T.DEDENT)) break;
    }
    return token!;
  }

  new_identifier(s: string): string {
    // Non-ASCII identifiers are NFKC-normalized (PEP 3131).
    return /^[\x00-\x7f]*$/.test(s) ? s : s.normalize("NFKC");
  }

  private name_from_token(t: Token | null): any {
    if (t === null) return null;
    return { _type: "Name", id: this.new_identifier(t.str), ctx: LOAD, lineno: t.lineno, col_offset: t.col_offset, end_lineno: t.end_lineno, end_col_offset: t.end_col_offset };
  }

  name_token(): any {
    return this.name_from_token(this.expect(T.NAME));
  }

  string_token(): any {
    return this.expect(T.STRING);
  }

  soft_keyword_token(): any {
    const t = this.expect(T.NAME);
    if (t === null) return null;
    if (this.soft_keywords.includes(t.str)) return this.name_from_token(t);
    return null;
  }

  number_token(): any {
    const t = this.expect(T.NUMBER);
    if (t === null) return null;
    return { _type: "Constant", value: parseNumber(t.str), kind: null, lineno: t.lineno, col_offset: t.col_offset, end_lineno: t.end_lineno, end_col_offset: t.end_col_offset };
  }

  // ---- memoization

  memoized(type: number): any {
    if (this.mark === this.fill) this.fill_token();
    const m = this.tokens[this.mark].memo?.get(type);
    if (m === undefined) return undefined;
    this.mark = m.mark;
    return m.node;
  }

  insert_memo(mark: number, type: number, node: any): void {
    const t = this.tokens[mark];
    if (!t.memo) t.memo = new Map();
    t.memo.set(type, { node, mark: this.mark });
  }

  update_memo(mark: number, type: number, node: any): void {
    this.insert_memo(mark, type, node);
  }

  // ---- running

  abstract file_rule(): any;
  abstract eval_rule(): any;
  abstract interactive_rule(): any;

  /** The grammar's start rule for a compile() mode. */
  private start(mode: string): any {
    if (mode === "eval") return this.eval_rule();
    if (mode === "single") return this.interactive_rule();
    return this.file_rule();
  }

  /** _PyPegen_run_parser; mode is "exec" (file input), "eval" or "single". */
  run(mode = "exec"): any {
    let res: any = null;
    let err: PegenError | null = null;
    try {
      res = this.start(mode);
    } catch (e) {
      if (!(e instanceof PegenError)) throw e;
      err = e;
    }
    if (res !== null && res !== undefined && err === null) return res;
    if (err === null) {
      // Second pass with the invalid_* rules, for a better message.
      const last_token = this.tokens[this.fill - 1];
      this.last_stmt_location = { lineno: 0, col_offset: 0, end_lineno: 0, end_col_offset: 0 };
      for (let i = 0; i < this.fill; i++) this.tokens[i].memo = null;
      this.mark = 0;
      this.call_invalid_rules = true;
      try {
        this.start(mode);
      } catch (e) {
        if (!(e instanceof PegenError)) throw e;
        err = e;
      }
      if (err === null) err = this.generic_syntax_error(last_token);
    }
    // _Pypegen_set_syntax_error: tokenizer errors later in the source can
    // take priority over errors raised by the parser.
    const tokOk = this.tok.done === E_DONE || this.tok.done === E_OK;
    if (tokOk) err = this.tokenize_full_source_to_check_for_errors(err);
    throw err;
  }

  private generic_syntax_error(last_token: Token): PegenError {
    try {
      if (this.fill === 0) RAISE_SYNTAX_ERROR(this, "error at start before reading any input");
      if (last_token.type === T.ERRORTOKEN && this.tok.done === E_EOF) {
        if (this.tok.level) this.raise_unclosed_parentheses_error();
        RAISE_SYNTAX_ERROR(this, "unexpected EOF while parsing");
      }
      if (last_token.type === T.INDENT || last_token.type === T.DEDENT) {
        RAISE_INDENTATION_ERROR(this, last_token.type === T.INDENT ? "unexpected indent" : "unexpected unindent");
      }
      RAISE_SYNTAX_ERROR_KNOWN_LOCATION(this, last_token, "invalid syntax");
    } catch (e) {
      if (e instanceof PegenError) return e;
      throw e;
    }
    throw new Error("unreachable");
  }

  private tokenize_full_source_to_check_for_errors(err: PegenError): PegenError {
    const current = this.known_err_token ?? this.tokens[this.fill - 1];
    const current_err_line = current.lineno;
    for (;;) {
      const raw: RawToken = { type: 0, start: -1, end: -1, level: 0, lineno: 0, col_offset: -1, end_lineno: 0, end_col_offset: -1, metadata: null };
      const type = this.tok.get(raw);
      if (type === T.ERRORTOKEN) {
        let newErr: PegenError | null = null;
        if (this.tok.error) {
          newErr = new PegenError({ ...this.tok.error });
        } else if (this.tok.level !== 0) {
          const error_lineno = this.tok.parenlinenostack[this.tok.level - 1];
          if (current_err_line > error_lineno) {
            try {
              this.raise_unclosed_parentheses_error();
            } catch (e) {
              if (e instanceof PegenError) newErr = e;
              else throw e;
            }
          }
        }
        if (newErr && this.tok.modeIndex <= 0) return newErr;
        return err;
      }
      if (type === T.ENDMARKER) return err;
    }
  }

  /** The text of line `lineno` (1-based) of the source, with its newline. */
  sourceLine(lineno: number): string {
    const lines = this.tok.source.split("\n");
    const l = lines[lineno - 1];
    return l === undefined ? "" : l + (lineno < lines.length ? "\n" : "");
  }
}

const LOAD = Object.freeze({ _type: "Load" });

// ---- numbers (parsenumber)

export class PyComplex {
  constructor(public imag: number) {}
}

export function parseNumber(s: string): any {
  s = s.replace(/_/g, "");
  const last = s[s.length - 1];
  if (last === "j" || last === "J") return new PyComplex(parseFloat(s.slice(0, -1)));
  if (/^0[xX]/.test(s)) return BigInt(s);
  if (/^0[oO]/.test(s)) return BigInt("0o" + s.slice(2));
  if (/^0[bB]/.test(s)) return BigInt("0b" + s.slice(2));
  if (/^[0-9]+$/.test(s)) return BigInt(s);
  return parseFloat(s);
}

// ---- error raising (pegen.h macros and pegen_errors.c)

/** _PyPegen_raise_error_known_location; col offsets are 1-based byte offsets. */
export function raise_error_known_location(p: BaseParser, errtype: string, lineno: number, col_offset: number,
  end_lineno: number, end_col_offset: number, msg: string): never {
  const tok = p.tok;
  if (end_lineno === CURRENT_POS) end_lineno = tok.lineno;
  if (end_col_offset === CURRENT_POS) end_col_offset = tok.cur - tok.lineStart;
  let error_line: string;
  if (tok.lineno <= lineno && tok.inp > tok.bufStart) {
    error_line = decodeBytes(tok.buf, tok.lineStart, tok.inp);
  } else {
    error_line = p.sourceLine(lineno);
  }
  const col_number = byteToCharOffset(error_line, col_offset);
  let end_col_number = end_col_offset;
  if (end_col_offset > 0) end_col_number = byteToCharOffset(error_line, end_col_offset);
  throw new PegenError({ type: errtype, msg, lineno, offset: col_number, text: error_line, end_lineno, end_offset: end_col_number });
}

/** PyUnicode_FromFormat subset: %s %U %c %d %i %R %% and %.Ns. */
export function fmt(msg: string, args: any[]): string {
  let i = 0;
  return msg.replace(/%(\.\d+)?([sUcdiR%])/g, (_m, prec, k) => {
    if (k === "%") return "%";
    const a = args[i++];
    switch (k) {
      case "c": return typeof a === "number" ? String.fromCodePoint(a) : String(a)[0];
      case "d": case "i": return String(a);
      case "R": return pyStrRepr(String(a));
      default: {
        const s = String(a);
        return prec ? s.slice(0, Number(prec.slice(1))) : s;
      }
    }
  });
}

/** repr() of a str, as CPython writes it. */
export function pyStrRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    if (c === q || c === "\\") out += "\\" + c;
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else out += c;
  }
  return out + q;
}

export function RAISE_ERROR_KNOWN_LOCATION(p: BaseParser, errtype: string, lineno: number, col_offset: number,
  end_lineno: number, end_col_offset: number, msg: string, ...args: any[]): never {
  const c = col_offset === CURRENT_POS ? CURRENT_POS : col_offset + 1;
  const e = end_col_offset === CURRENT_POS ? CURRENT_POS : end_col_offset + 1;
  raise_error_known_location(p, errtype, lineno, c, end_lineno, e, fmt(msg, args));
}

/** _PyPegen_raise_error */
export function raise_error(p: BaseParser, errtype: string, use_mark: boolean, msg: string): never {
  if (p.fill === 0) raise_error_known_location(p, errtype, 0, 0, 0, -1, msg);
  if (use_mark && p.mark === p.fill) p.fill_token();
  const t = p.known_err_token ?? p.tokens[use_mark ? p.mark : p.fill - 1];
  let col: number;
  if (t.col_offset === -1) {
    col = p.tok.cur === p.tok.bufStart ? 0 : p.tok.cur - p.tok.lineStart;
  } else {
    col = t.col_offset + 1;
  }
  const end = t.end_col_offset !== -1 ? t.end_col_offset + 1 : -1;
  raise_error_known_location(p, errtype, t.lineno, col, t.end_lineno, end, msg);
}

export function RAISE_SYNTAX_ERROR(p: BaseParser, msg: string, ...args: any[]): never {
  raise_error(p, "SyntaxError", false, fmt(msg, args));
}
export function RAISE_INDENTATION_ERROR(p: BaseParser, msg: string, ...args: any[]): never {
  raise_error(p, "IndentationError", false, fmt(msg, args));
}
export function RAISE_SYNTAX_ERROR_ON_NEXT_TOKEN(p: BaseParser, msg: string, ...args: any[]): never {
  raise_error(p, "SyntaxError", true, fmt(msg, args));
}
export function RAISE_SYNTAX_ERROR_KNOWN_RANGE(p: BaseParser, a: any, b: any, msg: string, ...args: any[]): never {
  RAISE_ERROR_KNOWN_LOCATION(p, "SyntaxError", a.lineno, a.col_offset, b.end_lineno, b.end_col_offset, msg, ...args);
}
export function RAISE_SYNTAX_ERROR_KNOWN_LOCATION(p: BaseParser, a: any, msg: string, ...args: any[]): never {
  RAISE_ERROR_KNOWN_LOCATION(p, "SyntaxError", a.lineno, a.col_offset, a.end_lineno, a.end_col_offset, msg, ...args);
}
export function RAISE_SYNTAX_ERROR_STARTING_FROM(p: BaseParser, a: any, msg: string, ...args: any[]): never {
  RAISE_ERROR_KNOWN_LOCATION(p, "SyntaxError", a.lineno, a.col_offset, CURRENT_POS, CURRENT_POS, msg, ...args);
}
