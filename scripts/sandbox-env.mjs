// The sandbox's environment (scripts/build-cli.mjs --sandbox; plan deno-sandbox-env r2, CLEAR 512b426f).
//
// The sandbox is a Deno executable compiled with --no-prompt and only the grants in PYJS_SANDBOX_ALLOW.  Without an
// env grant every read of process.env throws NotCapable, and the compiler and runtime read it as they load
// (SAGEBRUSH_HARDENED, SAGEBRUSH_PRECOMPILE_OUT, ...), so the sandbox died before running anything.  Its entry now
// starts by replacing process.env with an adapter over the real one: a key Deno refuses reads as unset; everything
// else, and every other error, is Deno's own.
//
// Deno 2.9, measured (the plan's §0): with no grant, get, has, enumeration and set all throw NotCapable; with a
// scoped grant (--allow-env=A,B) only those keys read, and enumeration still throws; with --allow-env (and any
// --deny-env=K) enumeration works and leaves the denied keys out.  So when enumeration is refused the adapter lists
// the granted names, taken from the same flags deno compile gets (parseAllow, the one parser of them).

/** process.env as the sandbox sees it: each operation is the real one; only a refusal (`e instanceof Denial`, Deno's
 * NotCapable) is absorbed, as an unset key.  Writes are not caught.  (Stringified into the entry: no outer names.) */
export function makeEnvAdapter(env, Denial, granted) {
  const read = (k) => {
    try {
      return env[k];
    } catch (e) {
      if (!(e instanceof Denial)) throw e;
      return undefined;
    }
  };
  const keys = () => {
    try {
      return Object.keys(env);
    } catch (e) {
      if (!(e instanceof Denial)) throw e;
      return granted.filter((k) => read(k) !== undefined);
    }
  };
  return new Proxy({}, {
    get: (_, k) => (typeof k === "string" ? read(k) : undefined),
    has: (_, k) => {
      if (typeof k !== "string") return false;
      try {
        return k in env;
      } catch (e) {
        if (!(e instanceof Denial)) throw e;
        return false;
      }
    },
    ownKeys: () => keys(),
    getOwnPropertyDescriptor: (_, k) => {
      if (typeof k !== "string") return undefined;
      const v = read(k);
      return v === undefined ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    },
    set: (_, k, v) => {
      env[k] = v;
      return true;
    },
    deleteProperty: (_, k) => {
      delete env[k];
      return true;
    },
  });
}

/** PYJS_SANDBOX_ALLOW's tokens: the flags for deno compile, and the env names a scoped grant names (each once).
 * An env grant spelled any other way than these is refused here, so the flags and the names can't disagree:
 * --allow-env and -A / --allow-all (everything: Deno lists the environment), --allow-env=A,B (those names), and
 * --deny-env[=...] (Deno leaves the denied keys out of its list).  (-E and any clustered short flag holding E, such
 * as -RE=NAME, are refused: their names would reach Deno and not the list.) */
export function parseAllow(text) {
  const flags = String(text ?? "").split(/\s+/).filter(Boolean);
  const granted = [];
  for (const f of flags) {
    if (f === "--allow-env" || f === "-A" || f === "--allow-all" || /^--deny-env(=|$)/.test(f)) continue;
    const m = /^--allow-env=(.*)$/.exec(f);
    if (m) {
      const names = m[1].split(",");
      if (names.some((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) throw new Error(`PYJS_SANDBOX_ALLOW: ${f}: not a list of variable names`);
      for (const k of names) if (!granted.includes(k)) granted.push(k);
      continue;
    }
    // (Deno's other spellings of an env grant: -E, -E=..., a clustered short flag holding E (-RE, -RE=A), --allow-env A)
    if ((/^-[^-]/.test(f) && f.split("=")[0].includes("E")) || /^--allow-env/.test(f)) throw new Error(`PYJS_SANDBOX_ALLOW: ${f}: write an env grant as --allow-env or --allow-env=NAME,...`);
  }
  return { flags, granted };
}

/** The sandbox's entry and its deno compile flags (before -o and the entry): the bundle with the env adapter
 * installed first, after its #! line, outside any try (a failure to install stops the sandbox), and exactly
 * --no-prompt plus the user's grants. */
export function sandboxEntry({ bundleText, allow, target }) {
  const { flags, granted } = parseAllow(allow);
  const prologue =
    `;(() => { const makeEnvAdapter = ${makeEnvAdapter.toString()}; ` +
    `Object.defineProperty(process, "env", { value: makeEnvAdapter(process.env, Deno.errors.NotCapable, ${JSON.stringify(granted)}), writable: true, enumerable: true, configurable: true }); })();\n`;
  const nl = bundleText.startsWith("#!") ? bundleText.indexOf("\n") + 1 : 0;
  return {
    entryText: bundleText.slice(0, nl) + prologue + bundleText.slice(nl),
    prologue,
    granted,
    flags: ["--no-prompt", ...flags, ...(target ? [target] : [])],
  };
}
