// CPython's site gives every interactive session exit() and quit(): their repr says how to leave, a call raises
// SystemExit with its code.  A prompt (the page's Console) has them, as builtins, unless already there.
export const QUITTERS = `import builtins as _b
class Quitter:
    def __init__(self, name, eof):
        self.name = name
        self.eof = eof
    def __repr__(self):
        return 'Use %s() or %s to exit' % (self.name, self.eof)
    def __call__(self, code=None):
        raise SystemExit(code)
for _n in ('exit', 'quit'):
    if not hasattr(_b, _n):
        setattr(_b, _n, Quitter(_n, 'Ctrl-D (i.e. EOF)'))
del _n
`;

/** MATLAB's exit and quit typed at a prompt (a status and a comment may follow): the status, else null. */
export function matlabQuit(src: string): number | null {
  const q = /^\s*(?:exit|quit)\s*(?:\(\s*(\d*)\s*\))?\s*;?\s*(?:%.*)?$/.exec(src);
  return q ? Number(q[1] || 0) : null;
}
