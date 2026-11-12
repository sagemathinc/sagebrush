// How many values a JSON text would make, counted on its bytes before it is parsed (the review page's admission:
// a document of millions of tiny values is refused before JSON.parse makes them).  One pass; outside strings it
// counts each container, each string, and each run of number or literal characters, and subtracts the keys (one
// colon each).  A malformed text gives some count; JSON.parse refuses it after.

export const JSON_LIMITS = Object.freeze({
  /** a submitted document's values */
  full: 400_000,
  /** each side of a notebook diff's (its canonical bytes) */
  side: 40_000,
});

const isTok = (b: number) => (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x2b || b === 0x2e || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

export function jsonValues(bytes: Uint8Array): number {
  let values = 0, colons = 0, inStr = false, esc = false, inTok = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (inStr) {
      if (esc) esc = false;
      else if (b === 0x5c) esc = true;
      else if (b === 0x22) inStr = false;
      continue;
    }
    if (b === 0x22) { inStr = true; values++; inTok = false; }
    else if (b === 0x7b || b === 0x5b) { values++; inTok = false; }
    else if (b === 0x3a) { colons++; inTok = false; }
    else if (isTok(b)) { if (!inTok) { values++; inTok = true; } }
    else inTok = false;
  }
  return values - colons;
}
