import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// np.hypot of float64 is glibc's hypot, as NumPy calls it on x86-64 Linux (glibc 2.43, the 2021 rewrite, built
// without FMA): not correctly rounded, so the correctly rounded hypot gave np.hypot(3.1622776601683795, 2.0) =
// 0x1.deeea11683f49p+1 where NumPy gives 0x1.deeea11683f4ap+1. Each line is NumPy 2.5.5's, printed by
// test/numpy_hypot_cases.py there (observed 2026-11-28).
const WANT = `0x1.deeea11683f4ap+1
0x1.94c583ada5b53p+1
0x0.0p+0
0x0.0p+0
0x1.4000000000000p+2
0x1.6a09e667f3bcdp+0
inf
inf
nan
0x0.0000000000001p-1022
0x1.0000a96eeeaa3p-1022
inf
0x1.000001fffffe0p+511
0x1.0000000000120p+512
0x1.6a09e667f3bcdp-459
0x1.000047fff5e00p-460
0x1.0000000000000p+0
0x1.0000000000000p+0
0x1.0e4d50f99b211p+997
0x1.0f1297202ba7fp-995
0x1.2fe57cfca1cb4p+3
0x1.ff09e79c2ed65p+2
0x1.31ed1cab5d2f5p+2
0x1.df5a8a6ac2b55p+2
0x1.ce0df70215066p+2
0x1.550bae9f24393p+3
0x1.2a52b94cb093dp+3
0x1.16b6edfa68253p+3
0x1.1d945895a5cf6p+3
0x1.43a28d088afffp+1
0x1.f694088dd6f28p+1
0x1.28ea3f940604fp+3
0x1.2009f86166869p+2
0x1.39cb5eb7ba58cp+2
0x1.b48e3cfb11505p+2
0x1.2b77c78d90eaep+2
0x1.4e4283f273972p+3
0x1.157bf168feb63p+2
0x1.73bed384a6048p+2
0x1.6bf638195bcbep+2
0x1.a954315f78917p+2
0x1.2cb6a34be7df9p+3
0x1.f46b19ec32d37p+0
0x1.706f9f868adb9p+3
0x1.58e84e98134bbp+3
0x1.2ea365beabc99p+3
0x1.41e69784e5ccep+3
0x1.37c049a50f3b9p+3
0x1.a5c13a690a0a9p+3
0x1.8aa1320f8cbd2p+3
0x1.0f4bfa0415dc1p+3
0x1.4b7e3c273d7e9p+3
0x1.2383f2d02a7f9p+3
0x1.5395f065dfe46p+3
0x1.60d4e7f7aceecp+3
0x1.f4f2440923c1fp+2
0x1.31e930f7733a3p+3
0x1.3f19bcc6f179dp+2
0x1.70b651869a999p+3
0x1.aa58b89c10638p+2
0x1.43c09f1b64aa7p+1
0x1.5a12c46aa84e6p+2
0x1.fcdeba62d5b50p+2
0x1.4ebb8fd5612d5p+3
0x1.137075f5651f4p+2
0x1.796e4430cef53p+3
0x1.b2d4d3b1e8785p+2
0x1.fb4f6d14f4dc2p+2
0x1.77757ea92a908p+1
0x1.cbcb11702b889p+2
0x1.6e2a2ea990af6p+3
0x1.38de849e88f54p+3
0x1.5ae9395077d8bp+0
0x1.0a6f9bdebdecap+3
0x1.deddc2c386050p+2
0x1.147de5fadbcc2p+3
0x1.92aede5a13c22p+3
0x1.77c08e167dea4p+2
0x1.09a6f845a698ep+2
0x1.36fe719365855p+3
0x1.7f125341b808cp+3
0x1.fa321db8e5982p+2
0x1.57d8945595fffp+2
0x1.a850e57180b15p+0
0x1.10de7e30e514bp+2
0x1.58b9bb9113747p+3
0x1.1f1100632ea28p+1
0x1.d546bc2edff36p+1
0x1.ea01b183aabbfp+2
0x1.687cb135acef1p+1
0x1.62d91492f1ccbp+3
0x1.8ccd7db05cd61p+0
0x1.29942ac0b0354p+3
0x1.07b9b365889cep+3
0x1.184799a93dba7p+3
0x1.5343da810e6e0p+2
0x1.e4499b857e8b6p+2
0x1.73b1809014ff9p+2
0x1.686d4c8a62761p+2
0x1.086c7a3c2ab17p+3
0x1.deeea11683f4ap+1 0x1.94c583ada5b53p+1 0x0.0p+0 0x0.0p+0 0x1.4000000000000p+2 0x1.6a09e667f3bcdp+0
`;

test("np.hypot gives NumPy's (glibc's) bits", () => {
  const name = __dirname + "/../../test/numpy_hypot_cases.py";
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", name], { encoding: "utf8" }).split("\n");
  const want = WANT.split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `line ${i + 1}`);
});
