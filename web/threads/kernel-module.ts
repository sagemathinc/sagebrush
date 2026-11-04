// Which engine/nd WebAssembly module this browser runs (numerics-core P2a, r4.2 §12: one selection at load,
// recorded with every result). Two are built (scripts/build-nd.mjs):
// - sagebrush-nd-fma.wasm: the relaxed-SIMD kernel (f64x2.relaxed_madd), for engines that validate relaxed SIMD;
// - sagebrush-nd.wasm: the SIMD128 kernel (mul then add), everywhere else.
// The probe is the smallest module using f64x2.relaxed_madd: a function returning relaxed_madd of three
// v128 constants. An engine without relaxed SIMD rejects it, so validate() decides without fetching either one.

export const RELAXED_PROBE: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version 1
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, // type section: one function type, () -> v128
  0x03, 0x02, 0x01, 0x00, // function section: one function of type 0
  0x0a, 0x3d, 0x01, 0x3b, 0x00, // code section: one body of 59 bytes, no locals
  0xfd, 0x0c, ...new Array(16).fill(0), // v128.const 0
  0xfd, 0x0c, ...new Array(16).fill(0), // v128.const 0
  0xfd, 0x0c, ...new Array(16).fill(0), // v128.const 0
  0xfd, 0x87, 0x02, // f64x2.relaxed_madd (0xfd 0x107)
  0x0b, // end
]);

export type ModuleChoice = { file: string; reason: string };

/** The module to load: `force` ("fma" or "simd128", a page override for comparisons) if given and usable, else
 * the relaxed-SIMD one where `validate` accepts the probe, else the SIMD128 one. */
export function chooseModule(validate: (b: Uint8Array<ArrayBuffer>) => boolean, force?: string | null): ModuleChoice {
  const relaxed = validate(RELAXED_PROBE);
  if (force === "simd128") return { file: "sagebrush-nd.wasm", reason: "forced (?module=simd128)" };
  if (force === "fma" && relaxed) return { file: "sagebrush-nd-fma.wasm", reason: "forced (?module=fma)" };
  if (relaxed) return { file: "sagebrush-nd-fma.wasm", reason: "relaxed SIMD available" };
  return { file: "sagebrush-nd.wasm", reason: force === "fma" ? "relaxed SIMD unavailable (?module=fma ignored)" : "relaxed SIMD unavailable" };
}
