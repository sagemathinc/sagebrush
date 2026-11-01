// G-10's tampered zone index (plan r2.3 R-2), one fixture for both the unit G11u (web/notebook/test-runner-fetch.mjs)
// and the browser's G11 (web/test-runner-broker.mjs): the index's own bytes with ONE byte changed, the first hex digit
// of ANOTHER zone's value, so it stays valid JSON and passes the grammar, and still lists the zone the cases ask
// for (Europe/London) with its real SHA-256, while its own hash differs from the build's. So it is the index's hash
// check alone that refuses it (C-G11 removes that check: the index then parses and London is admitted).
export const ASKED = "Europe/London";

export function tamperedIndex(bytes, asked = ASKED) {
  const text = new TextDecoder().decode(bytes);
  const zones = JSON.parse(text).zones;
  const askedSha = zones[asked];
  // (another zone whose value isn't London's and occurs exactly once in the file, so the changed byte is its own)
  const count = (v) => text.split(`"${v}"`).length - 1;
  const other = Object.keys(zones).find((k) => k !== asked && zones[k] !== askedSha && count(zones[k]) === 1);
  if (!other) throw new Error("the tz fixture: no zone with a value of its own");
  const at = text.indexOf(`"${zones[other]}"`) + 1;
  const out = Uint8Array.from(bytes);
  out[at] = out[at] === 0x30 ? 0x31 : 0x30; // ('0' <-> '1': still lowercase hex)
  return { bytes: out, asked, askedSha, other, at };
}
