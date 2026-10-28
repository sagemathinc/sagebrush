// The build inputs a lint override or a Rust source could hide in, shared by scripts/unsafe-inventory.mjs
// (which scans them for overrides) and scripts/ci-paths.mjs (whose census job must run when one changes),
// so the two can't drift: C-2c-ii's unsafe-code boundary (#234 r2, astra2 U3 / daybreak2).
export const BUILD_INPUT_PATHS = [
  /(^|\/)\.cargo\//, // cargo configs (rustflags, cap-lints)
  /(^|\/)Cargo\.toml$/, // every manifest, the engine's and any other workspace's
  /(^|\/)rust-toolchain(\.toml)?$/,
  /\.rs$/, // any Rust source (outside engine/ it may not name the lint at all)
  /^\.github\/workflows\//,
  /^scripts\//,
  /(^|\/)package\.json$/,
  /\.sh$/,
];
export const isBuildInput = (f) => BUILD_INPUT_PATHS.some((re) => re.test(f));
