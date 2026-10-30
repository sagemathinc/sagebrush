// Every render request carries the document and the source revision it was made for; a reply is patched only for
// that document, and its image names used only for that revision. A load is bound to its own token: nothing is sent
// while it is pending (the text shown is still the old one), and a later load wins (the earlier one's result, or its
// error, is ignored). Delayed callbacks re-check the token they captured.
export type Token = { doc: number; rev: number };
export class RenderGate {
  doc = 0;
  rev = 0;
  loading: Token | null = null;
  load(): Token { this.doc++; this.rev++; this.loading = this.token(); return this.loading; }
  loaded(t: Token): boolean { if (!this.current(t) || !this.loading || this.loading.doc !== t.doc) return false; this.loading = null; return true; }
  canSend(): boolean { return this.loading === null; }
  edit(): Token { this.rev++; return this.token(); }
  token(): Token { return { doc: this.doc, rev: this.rev }; }
  accept(r: { doc?: unknown; rev?: unknown } | null | undefined): { patch: boolean; current: boolean } {
    const doc = !!r && r.doc === this.doc;
    return { patch: doc, current: doc && r!.rev === this.rev };
  }
  current(t: Token | null | undefined): boolean { return !!t && t.doc === this.doc && t.rev === this.rev; }
  sameDoc(t: Token | null | undefined): boolean { return !!t && t.doc === this.doc; }
}
