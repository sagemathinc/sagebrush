// web/latex/boot.ts in a build without the LaTeX editor (web/build.ts): nothing; its one caller is a branch the build
// removes (__SB_LATEX__ false).
export const latexBoot = null as unknown as (ws: unknown) => Promise<boolean>;
