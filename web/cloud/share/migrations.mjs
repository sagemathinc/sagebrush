// The share database's migrations, in the order they are applied.  Core's web/share/migrations (MIT) and this
// directory's migrations (MS-RSL) share one numbering, so the two are merged by file name.  A file without a
// four-digit number, a number used twice, or a number missing from the sequence (0001 up) is an error: none is
// skipped or reordered.  The tests and the dev server read the list here; the deploy applies the same order.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATION_DIRS = [join(here, "../../share/migrations"), join(here, "migrations")];

/** The .sql files of `dirs`, each { name, path }, merged in name order; throws on a bad, repeated or missing number. */
export function migrations(dirs = MIGRATION_DIRS) {
  const all = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".sql")).map((name) => ({ name, path: join(d, name) })));
  all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  all.forEach((m, i) => {
    const n = /^(\d{4})_[^/]+\.sql$/.exec(m.name)?.[1];
    if (!n) throw new Error(`a migration without a four-digit number: ${m.path}`);
    if (i > 0 && all[i - 1].name.slice(0, 4) === n) throw new Error(`two migrations numbered ${n}: ${all[i - 1].path} and ${m.path}`);
    if (Number(n) !== i + 1) throw new Error(`migration ${String(i + 1).padStart(4, "0")} is missing (next: ${m.path})`);
  });
  return all;
}
