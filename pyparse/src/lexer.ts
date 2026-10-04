// Python tokenizer: a port of CPython 3.14's Parser/lexer/lexer.c (string
// input), operating on UTF-8 bytes so that every column offset matches
// CPython's (AST col_offset values are UTF-8 byte offsets).

import * as T from "./tokens.gen";

export const EOF = -1;

// errcode.h
export const E_OK = 10, E_EOF = 11, E_TOKEN = 13, E_DONE = 16, E_ERROR = 17, E_TABSPACE = 18,
  E_TOODEEP = 20, E_DEDENT = 21, E_DECODE = 22, E_EOFS = 23, E_EOLS = 24, E_LINECONT = 25;

const MAXINDENT = 100, MAXLEVEL = 200, MAXFSTRINGLEVEL = 150, MAX_EXPR_NESTING = 3, ALTTABSIZE = 1;
const TOK_REGULAR_MODE = 0, TOK_FSTRING_MODE = 1;
const FSTRING = 0, TSTRING = 1;

const ch = (s: string) => s.charCodeAt(0);
const C = {
  nl: 10, cr: 13, sp: 32, tab: 9, ff: 12, hash: ch("#"), bslash: ch("\\"), dq: ch('"'), sq: ch("'"),
  lbrace: ch("{"), rbrace: ch("}"), colon: ch(":"), bang: ch("!"), eq: ch("="), dot: ch("."),
  lpar: ch("("), rpar: ch(")"), lsqb: ch("["), rsqb: ch("]"), us: ch("_"),
};

const isDigit = (c: number) => c >= 48 && c <= 57;
const isXDigit = (c: number) => isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
const isIdStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128;
const isIdChar = (c: number) => isIdStart(c) || isDigit(c);
const lower = (c: number) => (c >= 65 && c <= 90 ? c + 32 : c);

export interface Mode {
  kind: number;
  curly_bracket_depth: number;
  curly_bracket_expr_start_depth: number;
  quote: number;
  quote_size: number;
  raw: boolean;
  start: number;
  multi_line_start: number;
  first_line: number;
  expr_start: number; // offset just after '{' of the current expression (-1: none)
  expr_end: number;   // offset of the '}', '!' or ':' ending it (-1: not yet)
  in_debug: boolean;
  in_format_spec: boolean;
  string_kind: number;
}

function newMode(kind: number): Mode {
  return {
    kind, curly_bracket_depth: 0, curly_bracket_expr_start_depth: -1, quote: 0, quote_size: 0, raw: false,
    start: 0, multi_line_start: 0, first_line: 0, expr_start: -1, expr_end: -1, in_debug: false,
    in_format_spec: false, string_kind: FSTRING,
  };
}

export interface RawToken {
  type: number;
  start: number; // byte offsets into the buffer, -1 for none
  end: number;
  level: number;
  lineno: number;
  col_offset: number;
  end_lineno: number;
  end_col_offset: number;
  metadata: string | null;
}

export interface TokenizerError {
  type: string; // SyntaxError, IndentationError, TabError
  msg: string;
  lineno: number;
  offset: number;
  text: string;
  end_lineno: number;
  end_offset: number;
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder("utf-8", { fatal: false });

export function decodeBytes(b: Uint8Array, start: number, end: number): string {
  return utf8d.decode(b.subarray(start, end));
}

/** Python's str.isprintable() for one code point (approximation via Unicode categories). */
function isPrintable(cp: number): boolean {
  if (cp === 0x20) return true;
  return !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u.test(String.fromCodePoint(cp));
}

export class TokState {
  buf: Uint8Array;
  bufStart = 0; // tok->buf: start of the current token's first line
  cur = 0;
  inp = 0;
  end: number;
  lineStart = 0;
  start = -1;
  done = E_OK;
  tabsize = 8;
  indent = 0;
  indstack: number[] = [0];
  altindstack: number[] = [0];
  atbol = 1;
  pendin = 0;
  lineno = 0;
  first_lineno = 0;
  starting_col_offset = -1;
  col_offset = 0;
  level = 0;
  parenstack: number[] = [];
  parenlinenostack: number[] = [];
  parencolstack: number[] = [];
  cont_line = 0;
  multi_line_start = 0;
  type_comments = false;
  modes: Mode[] = [newMode(TOK_REGULAR_MODE)];
  modeIndex = 0;
  error: TokenizerError | null = null;
  source: string;

  constructor(source: string) {
    // translate_newlines: \r\n and \r -> \n, and end exec input with a newline.
    let s = source.replace(/\r\n?/g, "\n");
    if (s.length > 0 && !s.endsWith("\n")) s += "\n";
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BOM
    this.source = s;
    this.buf = utf8.encode(s);
    this.end = this.buf.length;
  }

  get mode(): Mode {
    return this.modes[this.modeIndex];
  }

  insideFString(): boolean {
    return this.modeIndex > 0;
  }

  /** Read the next line into the window [cur, inp); returns false at end of input. */
  private underflow(): boolean {
    if (this.inp >= this.end) {
      this.done = E_EOF;
      return false;
    }
    let e = this.buf.indexOf(C.nl, this.inp);
    e = e < 0 ? this.end : e + 1;
    if (this.start < 0) this.bufStart = this.cur;
    this.lineStart = this.cur;
    this.lineno++;
    this.col_offset = 0;
    this.inp = e;
    return true;
  }

  nextc(): number {
    for (;;) {
      if (this.cur !== this.inp) {
        this.col_offset++;
        return this.buf[this.cur++];
      }
      if (this.done !== E_OK) return EOF;
      if (!this.underflow()) {
        this.cur = this.inp;
        return EOF;
      }
      this.lineStart = this.cur;
      for (let i = this.lineStart; i < this.inp; i++) {
        if (this.buf[i] === 0) {
          this.syntaxerror("source code cannot contain null bytes");
          this.cur = this.inp;
          return EOF;
        }
      }
    }
  }

  backup(c: number): void {
    if (c !== EOF) {
      this.cur--;
      this.col_offset--;
    }
  }

  private lineText(): string {
    let e = this.buf.indexOf(C.nl, this.lineStart);
    if (e < 0) e = this.end;
    return decodeBytes(this.buf, this.lineStart, e);
  }

  syntaxerrorRange(msg: string, col: number, endCol: number): number {
    if (this.done === E_ERROR) return T.ERRORTOKEN;
    if (col === -1) col = [...decodeBytes(this.buf, this.lineStart, this.cur)].length;
    if (endCol === -1) endCol = col;
    this.error = { type: "SyntaxError", msg, lineno: this.lineno, offset: col, text: this.lineText(), end_lineno: this.lineno, end_offset: endCol };
    this.done = E_ERROR;
    return T.ERRORTOKEN;
  }

  syntaxerror(msg: string): number {
    return this.syntaxerrorRange(msg, -1, -1);
  }

  indenterror(): number {
    this.done = E_TABSPACE;
    this.cur = this.inp;
    return T.ERRORTOKEN;
  }

  // ---- token construction (_PyLexer_token_setup)

  private make(token: RawToken, type: number, pStart: number, pEnd: number): number {
    token.level = this.level;
    const strlit = type === T.STRING || type === T.FSTRING_MIDDLE || type === T.TSTRING_MIDDLE;
    token.lineno = strlit ? this.first_lineno : this.lineno;
    token.end_lineno = this.lineno;
    token.col_offset = token.end_col_offset = -1;
    token.start = pStart;
    token.end = pEnd;
    if (pStart >= 0 && pEnd >= 0) {
      token.col_offset = this.starting_col_offset;
      token.end_col_offset = this.col_offset;
    }
    token.type = type;
    return type;
  }

  private lookaheadStr(test: string): boolean {
    let i = 0;
    let res = false;
    for (;;) {
      const c = this.nextc();
      if (i === test.length) {
        res = !isIdChar(c);
      } else if (c === test.charCodeAt(i)) {
        i++;
        continue;
      }
      this.backup(c);
      while (i > 0) {
        i--;
        this.backup(test.charCodeAt(i));
      }
      return res;
    }
  }

  private verifyEndOfNumber(c: number, kind: string): boolean {
    let r = false;
    if (c === ch("a")) r = this.lookaheadStr("nd");
    else if (c === ch("e")) r = this.lookaheadStr("lse");
    else if (c === ch("f")) r = this.lookaheadStr("or");
    else if (c === ch("i")) {
      const c2 = this.nextc();
      if (c2 === ch("f") || c2 === ch("n") || c2 === ch("s")) r = true;
      this.backup(c2);
    } else if (c === ch("o")) r = this.lookaheadStr("r");
    else if (c === ch("n")) r = this.lookaheadStr("ot");
    if (r) {
      // CPython emits a SyntaxWarning ("invalid %s literal") here.
      return true;
    }
    if (c < 128 && c !== EOF && isIdChar(c)) {
      this.backup(c);
      this.syntaxerror(`invalid ${kind} literal`);
      return false;
    }
    return true;
  }

  private verifyIdentifier(): boolean {
    const s = decodeBytes(this.buf, this.start, this.cur);
    const cps = [...s];
    for (let i = 0; i < cps.length; i++) {
      const okStart = /[\p{XID_Start}_]/u.test(cps[i]);
      const ok = i === 0 ? okStart : /\p{XID_Continue}/u.test(cps[i]);
      if (!ok) {
        const cp = cps[i].codePointAt(0)!;
        if (i + 1 < cps.length) this.cur = this.start + utf8.encode(cps.slice(0, i + 1).join("")).length;
        const hex = cp.toString(16).toUpperCase().padStart(4, "0");
        if (isPrintable(cp)) this.syntaxerror(`invalid character '${cps[i]}' (U+${hex})`);
        else this.syntaxerror(`invalid non-printable character U+${hex}`);
        return false;
      }
    }
    return true;
  }

  private decimalTail(): number {
    let c: number;
    for (;;) {
      do c = this.nextc(); while (isDigit(c));
      if (c !== C.us) break;
      c = this.nextc();
      if (!isDigit(c)) {
        this.backup(c);
        this.syntaxerror("invalid decimal literal");
        return 0;
      }
    }
    return c;
  }

  private continuationLine(): number {
    let c = this.nextc();
    if (c === C.cr) c = this.nextc();
    if (c !== C.nl) {
      this.done = E_LINECONT;
      return -1;
    }
    c = this.nextc();
    if (c === EOF) {
      this.done = E_EOF;
      this.cur = this.inp;
      return -1;
    }
    this.backup(c);
    return c;
  }

  private stringPrefixError(b: boolean, r: boolean, u: boolean, f: boolean, t: boolean): boolean {
    const err = (a: string, b2: string) => {
      this.syntaxerrorRange(`'${a}' and '${b2}' prefixes are incompatible`, this.start + 1 - this.lineStart, this.cur - this.lineStart);
      return true;
    };
    if (u && b) return err("u", "b");
    if (u && r) return err("u", "r");
    if (u && f) return err("u", "f");
    if (u && t) return err("u", "t");
    if (b && f) return err("b", "f");
    if (b && t) return err("b", "t");
    if (f && t) return err("f", "t");
    return false;
  }

  private prefixChar(): string {
    return this.mode.string_kind === TSTRING ? "t" : "f";
  }

  /** _PyLexer_update_ftstring_expr for '{', '}', '!', ':'. */
  private updateFtstringExpr(c: number): void {
    const m = this.mode;
    if (c === C.lbrace) {
      m.expr_start = this.cur;
      m.expr_end = -1;
    } else if (c === C.rbrace || c === C.bang) {
      m.expr_end = this.start;
    } else if (c === C.colon) {
      if (m.expr_end === -1) m.expr_end = this.start;
    }
  }

  /** set_ftstring_expr: attach the expression text (for '=' debugging and t-strings). */
  private setFtstringExpr(token: RawToken, c: number): void {
    const m = this.mode;
    if (!(m.in_debug || m.string_kind === TSTRING) || token.metadata !== null) return;
    if (m.expr_start < 0) return;
    let text = decodeBytes(this.buf, m.expr_start, m.expr_end >= 0 ? m.expr_end : this.start);
    // Remove comments outside string literals.
    let inStr = false, quote = "", hash = false;
    for (let i = 0; i < text.length; i++) {
      const x = text[i];
      if (x === "\\") { i++; continue; }
      if (x === '"' || x === "'") {
        if (!inStr) { inStr = true; quote = x; } else if (x === quote) inStr = false;
        continue;
      }
      if (x === "#" && !inStr) { hash = true; break; }
    }
    if (hash) {
      let out = "";
      inStr = false; quote = "";
      for (let i = 0; i < text.length; i++) {
        const x = text[i];
        if (x === '"' || x === "'") {
          if (!inStr) { inStr = true; quote = x; } else if (x === quote) inStr = false;
          out += x;
        } else if (x === "#" && !inStr) {
          while (i < text.length && text[i] !== "\n") i++;
          if (i < text.length) out += "\n";
        } else out += x;
      }
      text = out;
    }
    token.metadata = text;
  }

  get(token: RawToken): number {
    token.metadata = null;
    const m = this.mode;
    return m.kind === TOK_REGULAR_MODE ? this.getNormal(m, token) : this.getFString(m, token);
  }

  private getNormal(cur_tok: Mode, token: RawToken): number {
    let c: number;
    let blankline = false;
    let pStart = -1, pEnd = -1;
    const MAKE = (type: number) => this.make(token, type, pStart, pEnd);

    nextline: for (;;) {
      this.start = -1;
      this.starting_col_offset = -1;
      blankline = false;

      if (this.atbol) {
        let col = 0, altcol = 0, contLineCol = 0;
        this.atbol = 0;
        for (;;) {
          c = this.nextc();
          if (c === C.sp) { col++; altcol++; }
          else if (c === C.tab) {
            col = (Math.floor(col / this.tabsize) + 1) * this.tabsize;
            altcol = (Math.floor(altcol / ALTTABSIZE) + 1) * ALTTABSIZE;
          } else if (c === C.ff) { col = altcol = 0; }
          else if (c === C.bslash) {
            contLineCol = contLineCol ? contLineCol : col;
            if ((c = this.continuationLine()) === -1) return MAKE(T.ERRORTOKEN);
          } else if (c === EOF && this.error) {
            return MAKE(T.ERRORTOKEN);
          } else break;
        }
        this.backup(c);
        if (c === C.hash || c === C.nl || c === C.cr) blankline = true;
        if (!blankline && this.level === 0) {
          col = contLineCol ? contLineCol : col;
          altcol = contLineCol ? contLineCol : altcol;
          if (col === this.indstack[this.indent]) {
            if (altcol !== this.altindstack[this.indent]) return MAKE(this.indenterror());
          } else if (col > this.indstack[this.indent]) {
            if (this.indent + 1 >= MAXINDENT) {
              this.done = E_TOODEEP;
              this.cur = this.inp;
              return MAKE(T.ERRORTOKEN);
            }
            if (altcol <= this.altindstack[this.indent]) return MAKE(this.indenterror());
            this.pendin++;
            this.indstack[++this.indent] = col;
            this.altindstack[this.indent] = altcol;
          } else {
            while (this.indent > 0 && col < this.indstack[this.indent]) {
              this.pendin--;
              this.indent--;
            }
            if (col !== this.indstack[this.indent]) {
              this.done = E_DEDENT;
              this.cur = this.inp;
              return MAKE(T.ERRORTOKEN);
            }
            if (altcol !== this.altindstack[this.indent]) return MAKE(this.indenterror());
          }
        }
      }

      this.start = this.cur;
      this.starting_col_offset = this.col_offset;

      if (this.pendin !== 0) {
        if (this.pendin < 0) {
          this.pendin++;
          return MAKE(T.DEDENT);
        }
        this.pendin--;
        return MAKE(T.INDENT);
      }

      c = this.nextc();
      this.backup(c);

      again: for (;;) {
        this.start = -1;
        do c = this.nextc(); while (c === C.sp || c === C.tab || c === C.ff);
        this.start = this.cur - 1;
        this.starting_col_offset = this.col_offset - 1;

        if (c === C.hash) {
          while (c !== EOF && c !== C.nl && c !== C.cr) c = this.nextc();
          // Type comments are not supported (PyCF_TYPE_COMMENTS); comments are skipped.
        }

        if (c === EOF) {
          if (this.level) return MAKE(T.ERRORTOKEN);
          return MAKE(this.done === E_EOF ? T.ENDMARKER : T.ERRORTOKEN);
        }

        let nonascii = false;
        let gotoFString = false, gotoLetterQuote = false;
        if (isIdStart(c)) {
          let saw_b = false, saw_r = false, saw_u = false, saw_f = false, saw_t = false;
          for (;;) {
            if (!saw_b && (c === ch("b") || c === ch("B"))) saw_b = true;
            else if (!saw_u && (c === ch("u") || c === ch("U"))) saw_u = true;
            else if (!saw_r && (c === ch("r") || c === ch("R"))) saw_r = true;
            else if (!saw_f && (c === ch("f") || c === ch("F"))) saw_f = true;
            else if (!saw_t && (c === ch("t") || c === ch("T"))) saw_t = true;
            else break;
            c = this.nextc();
            if (c === C.dq || c === C.sq) {
              if (this.stringPrefixError(saw_b, saw_r, saw_u, saw_f, saw_t)) return MAKE(T.ERRORTOKEN);
              if (saw_f || saw_t) gotoFString = true;
              else gotoLetterQuote = true;
              break;
            }
          }
          if (!gotoFString && !gotoLetterQuote) {
            while (isIdChar(c)) {
              if (c >= 128) nonascii = true;
              c = this.nextc();
            }
            this.backup(c);
            if (nonascii && !this.verifyIdentifier()) return MAKE(T.ERRORTOKEN);
            pStart = this.start;
            pEnd = this.cur;
            return MAKE(T.NAME);
          }
        }

        if (!gotoFString && !gotoLetterQuote) {
          if (c === C.cr) c = this.nextc();

          if (c === C.nl) {
            this.atbol = 1;
            if (blankline || this.level > 0) continue nextline;
            pStart = this.start;
            pEnd = this.cur - 1;
            this.cont_line = 0;
            return MAKE(T.NEWLINE);
          }

          let fraction = false;
          if (c === C.dot) {
            c = this.nextc();
            if (isDigit(c)) {
              fraction = true;
            } else if (c === C.dot) {
              c = this.nextc();
              if (c === C.dot) {
                pStart = this.start;
                pEnd = this.cur;
                return MAKE(T.ELLIPSIS);
              }
              this.backup(c);
              this.backup(C.dot);
            } else {
              this.backup(c);
            }
            if (!fraction) {
              pStart = this.start;
              pEnd = this.cur;
              return MAKE(T.DOT);
            }
          }

          if (fraction || isDigit(c)) {
            const r = this.number(c, fraction);
            if (r === T.NUMBER) {
              pStart = this.start;
              pEnd = this.cur;
            }
            return MAKE(r);
          }
        }

        // f_string_quote:
        if (gotoFString || (!gotoLetterQuote && false)) {
          const first = lower(this.buf[this.start]);
          if ((first === ch("f") || first === ch("r") || first === ch("t")) && (c === C.sq || c === C.dq)) {
            const quote = c;
            let quote_size = 1;
            this.first_lineno = this.lineno;
            this.multi_line_start = this.lineStart;
            const after = this.nextc();
            if (after === quote) {
              const after2 = this.nextc();
              if (after2 === quote) quote_size = 3;
              else {
                this.backup(after2);
                this.backup(after);
              }
            }
            if (after !== quote) this.backup(after);
            pStart = this.start;
            pEnd = this.cur;
            if (this.modeIndex + 1 >= MAXFSTRINGLEVEL) return MAKE(this.syntaxerror("too many nested f-strings or t-strings"));
            const nm = newMode(TOK_FSTRING_MODE);
            nm.quote = quote;
            nm.quote_size = quote_size;
            nm.start = this.start;
            nm.multi_line_start = this.lineStart;
            nm.first_line = this.lineno;
            let kind = FSTRING;
            const s0 = this.buf[this.start];
            if (s0 === ch("T") || s0 === ch("t")) {
              nm.raw = lower(this.buf[this.start + 1]) === ch("r");
              kind = TSTRING;
            } else if (s0 === ch("F") || s0 === ch("f")) {
              nm.raw = lower(this.buf[this.start + 1]) === ch("r");
            } else {
              nm.raw = true;
              if (lower(this.buf[this.start + 1]) === ch("t")) kind = TSTRING;
            }
            nm.string_kind = kind;
            this.modes[++this.modeIndex] = nm;
            this.modes.length = this.modeIndex + 1;
            return MAKE(kind === TSTRING ? T.TSTRING_START : T.FSTRING_START);
          }
        }

        // letter_quote:
        if (c === C.sq || c === C.dq) {
          const quote = c;
          let quote_size = 1, end_quote_size = 0, has_escaped_quote = false;
          this.first_lineno = this.lineno;
          this.multi_line_start = this.lineStart;
          c = this.nextc();
          if (c === quote) {
            c = this.nextc();
            if (c === quote) quote_size = 3;
            else end_quote_size = 1;
          }
          if (c !== quote) this.backup(c);
          while (end_quote_size !== quote_size) {
            c = this.nextc();
            if (this.done === E_ERROR) return MAKE(T.ERRORTOKEN);
            if (c === EOF || (quote_size === 1 && c === C.nl)) {
              this.cur = this.start + 1;
              this.lineStart = this.multi_line_start;
              const startLine = this.lineno;
              this.lineno = this.first_lineno;
              if (this.insideFString()) {
                const tm = this.mode;
                if (tm.quote === quote && tm.quote_size === quote_size) {
                  return MAKE(this.syntaxerror(`${this.prefixChar()}-string: expecting '}'`));
                }
              }
              if (quote_size === 3) {
                this.syntaxerror(`unterminated triple-quoted string literal (detected at line ${startLine})`);
                if (c !== C.nl) this.done = E_EOFS;
                return MAKE(T.ERRORTOKEN);
              }
              this.syntaxerror(has_escaped_quote
                ? `unterminated string literal (detected at line ${startLine}); perhaps you escaped the end quote?`
                : `unterminated string literal (detected at line ${startLine})`);
              if (c !== C.nl) this.done = E_EOLS;
              return MAKE(T.ERRORTOKEN);
            }
            if (c === quote) end_quote_size += 1;
            else {
              end_quote_size = 0;
              if (c === C.bslash) {
                c = this.nextc();
                if (c === quote) has_escaped_quote = true;
                if (c === C.cr) c = this.nextc();
              }
            }
          }
          pStart = this.start;
          pEnd = this.cur;
          return MAKE(T.STRING);
        }

        if (c === C.bslash) {
          if ((c = this.continuationLine()) === -1) return MAKE(T.ERRORTOKEN);
          this.cont_line = 1;
          continue again;
        }

        const isPunct = c === C.colon || c === C.rbrace || c === C.bang || c === C.lbrace;
        if (isPunct && this.insideFString() && cur_tok.curly_bracket_expr_start_depth >= 0) {
          const cursor = cur_tok.curly_bracket_depth - (c !== C.lbrace ? 1 : 0);
          const cursorInFormatWithDebug = cursor === 1 && (cur_tok.in_debug || cur_tok.in_format_spec);
          const cursorValid = cursor === 0 || cursorInFormatWithDebug;
          if (cursorValid) this.updateFtstringExpr(c);
          if (cursorValid && c !== C.lbrace) this.setFtstringExpr(token, c);
          if (c === C.colon && cursor === cur_tok.curly_bracket_expr_start_depth) {
            cur_tok.kind = TOK_FSTRING_MODE;
            cur_tok.in_format_spec = true;
            pStart = this.start;
            pEnd = this.cur;
            return MAKE(oneChar(c));
          }
        }

        {
          const c2 = this.nextc();
          let t2 = twoChars(c, c2);
          if (t2 !== T.OP) {
            const c3 = this.nextc();
            const t3 = threeChars(c, c2, c3);
            if (t3 !== T.OP) t2 = t3;
            else this.backup(c3);
            pStart = this.start;
            pEnd = this.cur;
            return MAKE(t2);
          }
          this.backup(c2);
        }

        if (c === C.lpar || c === C.lsqb || c === C.lbrace) {
          if (this.level >= MAXLEVEL) return MAKE(this.syntaxerror("too many nested parentheses"));
          this.parenstack[this.level] = c;
          this.parenlinenostack[this.level] = this.lineno;
          this.parencolstack[this.level] = this.start - this.lineStart;
          this.level++;
          if (this.insideFString()) cur_tok.curly_bracket_depth++;
        } else if (c === C.rpar || c === C.rsqb || c === C.rbrace) {
          if (this.insideFString() && !cur_tok.curly_bracket_depth && c === C.rbrace) {
            return MAKE(this.syntaxerror(`${this.prefixChar()}-string: single '}' is not allowed`));
          }
          if (!this.level) return MAKE(this.syntaxerror(`unmatched '${String.fromCharCode(c)}'`));
          this.level--;
          const opening = this.parenstack[this.level];
          if (!((opening === C.lpar && c === C.rpar) || (opening === C.lsqb && c === C.rsqb) || (opening === C.lbrace && c === C.rbrace))) {
            if (this.insideFString() && opening === C.lbrace) {
              const previous = cur_tok.curly_bracket_depth - 1;
              if (previous === cur_tok.curly_bracket_expr_start_depth) {
                return MAKE(this.syntaxerror(`${this.prefixChar()}-string: unmatched '${String.fromCharCode(c)}'`));
              }
            }
            if (this.parenlinenostack[this.level] !== this.lineno) {
              return MAKE(this.syntaxerror(`closing parenthesis '${String.fromCharCode(c)}' does not match opening parenthesis '${String.fromCharCode(opening)}' on line ${this.parenlinenostack[this.level]}`));
            }
            return MAKE(this.syntaxerror(`closing parenthesis '${String.fromCharCode(c)}' does not match opening parenthesis '${String.fromCharCode(opening)}'`));
          }
          if (this.insideFString()) {
            cur_tok.curly_bracket_depth--;
            if (cur_tok.curly_bracket_depth < 0) {
              return MAKE(this.syntaxerror(`${this.prefixChar()}-string: unmatched '${String.fromCharCode(c)}'`));
            }
            if (c === C.rbrace && cur_tok.curly_bracket_depth === cur_tok.curly_bracket_expr_start_depth) {
              cur_tok.curly_bracket_expr_start_depth--;
              cur_tok.kind = TOK_FSTRING_MODE;
              cur_tok.in_format_spec = false;
              cur_tok.in_debug = false;
            }
          }
        }

        if (!isPrintable(c)) {
          return MAKE(this.syntaxerror(`invalid non-printable character U+${c.toString(16).toUpperCase().padStart(4, "0")}`));
        }
        if (c === C.eq && cur_tok.curly_bracket_depth - cur_tok.curly_bracket_expr_start_depth === 1) {
          cur_tok.in_debug = true;
        }
        pStart = this.start;
        pEnd = this.cur;
        return MAKE(oneChar(c));
      }
    }
  }

  /** Numbers; returns NUMBER or ERRORTOKEN.  c is the first character (or the
   *  first digit after '.' when fraction is set). */
  private number(c: number, fraction: boolean): number {
    const fail = () => T.ERRORTOKEN;
    let exponentChar = 0;
    let state: "start" | "fraction" | "exponent" | "imaginary" | "end" = fraction ? "fraction" : "start";
    if (state === "start") {
      if (c === ch("0")) {
        c = this.nextc();
        if (c === ch("x") || c === ch("X")) {
          c = this.nextc();
          do {
            if (c === C.us) c = this.nextc();
            if (!isXDigit(c)) {
              this.backup(c);
              return this.syntaxerror("invalid hexadecimal literal");
            }
            do c = this.nextc(); while (isXDigit(c));
          } while (c === C.us);
          if (!this.verifyEndOfNumber(c, "hexadecimal")) return fail();
          state = "end";
        } else if (c === ch("o") || c === ch("O")) {
          c = this.nextc();
          do {
            if (c === C.us) c = this.nextc();
            if (c < 48 || c >= 56) {
              if (isDigit(c)) return this.syntaxerror(`invalid digit '${String.fromCharCode(c)}' in octal literal`);
              this.backup(c);
              return this.syntaxerror("invalid octal literal");
            }
            do c = this.nextc(); while (c >= 48 && c < 56);
          } while (c === C.us);
          if (isDigit(c)) return this.syntaxerror(`invalid digit '${String.fromCharCode(c)}' in octal literal`);
          if (!this.verifyEndOfNumber(c, "octal")) return fail();
          state = "end";
        } else if (c === ch("b") || c === ch("B")) {
          c = this.nextc();
          do {
            if (c === C.us) c = this.nextc();
            if (c !== 48 && c !== 49) {
              if (isDigit(c)) return this.syntaxerror(`invalid digit '${String.fromCharCode(c)}' in binary literal`);
              this.backup(c);
              return this.syntaxerror("invalid binary literal");
            }
            do c = this.nextc(); while (c === 48 || c === 49);
          } while (c === C.us);
          if (isDigit(c)) return this.syntaxerror(`invalid digit '${String.fromCharCode(c)}' in binary literal`);
          if (!this.verifyEndOfNumber(c, "binary")) return fail();
          state = "end";
        } else {
          let nonzero = false;
          for (;;) {
            if (c === C.us) {
              c = this.nextc();
              if (!isDigit(c)) {
                this.backup(c);
                return this.syntaxerror("invalid decimal literal");
              }
            }
            if (c !== ch("0")) break;
            c = this.nextc();
          }
          const zerosEnd = this.cur;
          if (isDigit(c)) {
            nonzero = true;
            c = this.decimalTail();
            if (c === 0) return fail();
          }
          if (c === C.dot) {
            c = this.nextc();
            state = "fraction";
          } else if (c === ch("e") || c === ch("E")) {
            state = "exponent";
          } else if (c === ch("j") || c === ch("J")) {
            state = "imaginary";
          } else if (nonzero) {
            this.backup(c);
            return this.syntaxerrorRange("leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers",
              this.start + 1 - this.lineStart, zerosEnd - this.lineStart);
          } else {
            if (!this.verifyEndOfNumber(c, "decimal")) return fail();
            state = "end";
          }
        }
      } else {
        c = this.decimalTail();
        if (c === 0) return fail();
        if (c === C.dot) {
          c = this.nextc();
          state = "fraction";
        } else state = "afterfraction" as any;
      }
    }
    if (state === "fraction") {
      if (isDigit(c)) {
        c = this.decimalTail();
        if (c === 0) return fail();
      }
      state = "afterfraction" as any;
    }
    if ((state as string) === "afterfraction") {
      if (c === ch("e") || c === ch("E")) state = "exponent";
      else if (c === ch("j") || c === ch("J")) state = "imaginary";
      else {
        if (!this.verifyEndOfNumber(c, "decimal")) return fail();
        state = "end";
      }
    }
    if (state === "exponent") {
      exponentChar = c;
      c = this.nextc();
      if (c === ch("+") || c === ch("-")) {
        c = this.nextc();
        if (!isDigit(c)) {
          this.backup(c);
          return this.syntaxerror("invalid decimal literal");
        }
      } else if (!isDigit(c)) {
        this.backup(c);
        if (!this.verifyEndOfNumber(exponentChar, "decimal")) return fail();
        this.backup(exponentChar);
        return T.NUMBER;
      }
      c = this.decimalTail();
      if (c === 0) return fail();
      if (c === ch("j") || c === ch("J")) state = "imaginary";
      else {
        if (!this.verifyEndOfNumber(c, "decimal")) return fail();
        state = "end";
      }
    }
    if (state === "imaginary") {
      c = this.nextc();
      if (!this.verifyEndOfNumber(c, "imaginary")) return fail();
    }
    this.backup(c);
    return T.NUMBER;
  }

  private getFString(cur_tok: Mode, token: RawToken): number {
    let pStart = -1, pEnd = -1;
    const MAKE = (type: number) => this.make(token, type, pStart, pEnd);
    const MIDDLE = cur_tok.string_kind === TSTRING ? T.TSTRING_MIDDLE : T.FSTRING_MIDDLE;
    const END = cur_tok.string_kind === TSTRING ? T.TSTRING_END : T.FSTRING_END;
    let end_quote_size = 0;
    let unicode_escape = false;

    this.start = this.cur;
    this.first_lineno = this.lineno;
    this.starting_col_offset = this.col_offset;

    const start_char = this.nextc();
    if (start_char === C.lbrace) {
      const peek1 = this.nextc();
      this.backup(peek1);
      this.backup(start_char);
      if (peek1 !== C.lbrace) {
        cur_tok.curly_bracket_expr_start_depth++;
        if (cur_tok.curly_bracket_expr_start_depth >= MAX_EXPR_NESTING) {
          return MAKE(this.syntaxerror(`${this.prefixChar()}-string: expressions nested too deeply`));
        }
        this.mode.kind = TOK_REGULAR_MODE;
        return this.getNormal(cur_tok, token);
      }
    } else {
      this.backup(start_char);
    }

    let atEnd = true;
    for (let i = 0; i < cur_tok.quote_size; i++) {
      const q = this.nextc();
      if (q !== cur_tok.quote) {
        this.backup(q);
        atEnd = false;
        break;
      }
    }
    if (atEnd) {
      cur_tok.expr_start = -1;
      cur_tok.expr_end = -1;
      pStart = this.start;
      pEnd = this.cur;
      this.modeIndex--;
      return MAKE(END);
    }
    // f_string_middle:
    this.multi_line_start = this.lineStart;
    while (end_quote_size !== cur_tok.quote_size) {
      const c = this.nextc();
      if (this.done === E_ERROR || this.done === E_DECODE) return MAKE(T.ERRORTOKEN);
      const in_format_spec = cur_tok.in_format_spec && cur_tok.curly_bracket_expr_start_depth >= 0;
      if (c === EOF || (cur_tok.quote_size === 1 && c === C.nl)) {
        if (in_format_spec && c === C.nl) {
          if (cur_tok.quote_size === 1) {
            const pc = this.prefixChar();
            return MAKE(this.syntaxerror(`${pc}-string: newlines are not allowed in format specifiers for single quoted ${pc}-strings`));
          }
          this.backup(c);
          this.mode.kind = TOK_REGULAR_MODE;
          cur_tok.in_format_spec = false;
          pStart = this.start;
          pEnd = this.cur;
          return MAKE(MIDDLE);
        }
        this.cur = cur_tok.start + 1;
        this.lineStart = cur_tok.multi_line_start;
        const startLine = this.lineno;
        this.lineno = this.mode.first_line;
        if (cur_tok.quote_size === 3) {
          this.syntaxerror(`unterminated triple-quoted ${this.prefixChar()}-string literal (detected at line ${startLine})`);
          if (c !== C.nl) this.done = E_EOFS;
          return MAKE(T.ERRORTOKEN);
        }
        return MAKE(this.syntaxerror(`unterminated ${this.prefixChar()}-string literal (detected at line ${startLine})`));
      }
      if (c === cur_tok.quote) {
        end_quote_size += 1;
        continue;
      }
      end_quote_size = 0;
      if (c === C.lbrace) {
        this.updateFtstringExpr(c);
        const peek = this.nextc();
        if (peek !== C.lbrace || in_format_spec) {
          this.backup(peek);
          this.backup(c);
          cur_tok.curly_bracket_expr_start_depth++;
          if (cur_tok.curly_bracket_expr_start_depth >= MAX_EXPR_NESTING) {
            return MAKE(this.syntaxerror(`${this.prefixChar()}-string: expressions nested too deeply`));
          }
          this.mode.kind = TOK_REGULAR_MODE;
          cur_tok.in_format_spec = false;
          pStart = this.start;
          pEnd = this.cur;
        } else {
          pStart = this.start;
          pEnd = this.cur - 1;
        }
        return MAKE(MIDDLE);
      } else if (c === C.rbrace) {
        if (unicode_escape) {
          pStart = this.start;
          pEnd = this.cur;
          return MAKE(MIDDLE);
        }
        const peek = this.nextc();
        const cursor = cur_tok.curly_bracket_depth;
        if (peek === C.rbrace && !in_format_spec && cursor === 0) {
          pStart = this.start;
          pEnd = this.cur - 1;
        } else {
          this.backup(peek);
          this.backup(c);
          this.mode.kind = TOK_REGULAR_MODE;
          cur_tok.in_format_spec = false;
          pStart = this.start;
          pEnd = this.cur;
        }
        return MAKE(MIDDLE);
      } else if (c === C.bslash) {
        let peek = this.nextc();
        if (peek === C.cr) peek = this.nextc();
        if (peek === C.lbrace || peek === C.rbrace) {
          this.backup(peek);
          continue;
        }
        if (!cur_tok.raw && peek === ch("N")) {
          peek = this.nextc();
          if (peek === C.lbrace) unicode_escape = true;
          else this.backup(peek);
        }
      }
    }
    for (let i = 0; i < cur_tok.quote_size; i++) this.backup(cur_tok.quote);
    pStart = this.start;
    pEnd = this.cur;
    return MAKE(MIDDLE);
  }
}

// ---- operator tables (_PyToken_OneChar / TwoChars / ThreeChars)

const ONE = new Map<number, number>(), TWO = new Map<number, number>(), THREE = new Map<number, number>();
for (const [s, t] of Object.entries(T.EXACT_TOKENS)) {
  if (s.length === 1) ONE.set(s.charCodeAt(0), t);
  else if (s.length === 2) TWO.set(s.charCodeAt(0) * 256 + s.charCodeAt(1), t);
  else if (s.length === 3) THREE.set((s.charCodeAt(0) * 256 + s.charCodeAt(1)) * 256 + s.charCodeAt(2), t);
}
// '<>' is NOTEQUAL too (PEP 401); CPython's tables include it.
TWO.set(ch("<") * 256 + ch(">"), T.NOTEQUAL);

export function oneChar(c: number): number {
  return ONE.get(c) ?? T.OP;
}
function twoChars(c1: number, c2: number): number {
  if (c2 < 0) return T.OP;
  return TWO.get(c1 * 256 + c2) ?? T.OP;
}
function threeChars(c1: number, c2: number, c3: number): number {
  if (c3 < 0) return T.OP;
  return THREE.get((c1 * 256 + c2) * 256 + c3) ?? T.OP;
}
