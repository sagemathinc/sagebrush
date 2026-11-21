// The examples gallery in the app (app/build-frontend.mjs runs this with Bun): its pages and catalog, as the site has
// them (web/build-examples.ts), built into app/dist/examples/, so File > Examples… opens the gallery's panel in the app
// as on the site (the gallery is the only list of examples).
//   bun app/build-examples.ts DIR
import { buildExamplesInto } from "../web/build-examples";

const out = process.argv[2];
if (!out) throw new Error("usage: bun app/build-examples.ts DIR");
const urls = await buildExamplesInto(out);
if (!urls.length) throw new Error("app examples: the corpus gave no examples");
console.log(`app examples: ${urls.length} pages`);
