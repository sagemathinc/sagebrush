// The LaTeX editor's examples ("From an example"; William, Oct 29: "10 examples (similar to what we have for notebooks).
// ... templates, but also good tests to illustrate the breadth of editor support"). Each is a folder of files: the main
// .tex first, then its assets (an image as base64). A note at the top of each says, in the document itself, what this
// preview can't do yet and what a full LaTeX run does instead. test-latex-units.mjs renders all of them.
// Their files are the corpus's, examples/latex/<id>/ (the gallery's: plan-examples-gallery), inlined while bundling
// (web/examples/legacy.ts).
import { latexExamples } from "../examples/legacy.ts" with { type: "macro" };

export type Example = { id: string; title: string; about: string; files: [name: string, text: string, base64?: true][] };

export const EXAMPLES: Example[] = latexExamples();
