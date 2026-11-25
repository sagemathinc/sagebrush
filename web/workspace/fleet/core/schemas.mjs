// The fleet schema set (schema/fleet/fleet.schema.json, reasons.json), given once by whoever loads the core, and a
// validator per body type. The core reads no files: lib/fleet/schemas.mjs loads them from disk in Node, and a page
// passes the copies it bundles. Either way both must be the frozen revision's (FREEZE), or they are refused.

import { compile } from "./schema.mjs";

/** The design these schemas, this code and the fixtures implement. */
export const FREEZE = Object.freeze({ revision: "r2.3", sha256: "db905c9d72ba5d4e18620d3267ea9214992d3a82c735289dda4088970dddc7e3" });

let given = null, fleet = null, reasons = null;
const cache = new Map();

/**
 * Install the schemas: `load(name)` returns the parsed JSON of "fleet.schema.json" or "reasons.json". Called once, at
 * install; installing the same loader again is a no-op, and any other is refused.
 */
export function useSchemas(load) {
  if (given !== null) {
    if (load === given) return;
    throw new Error("the fleet schemas are already installed");
  }
  // (a snapshot, deep-frozen: neither the caller's objects nor what fleetSchema() hands out can change a validator)
  const f = deepFreeze(JSON.parse(JSON.stringify(load("fleet.schema.json")))), r = deepFreeze(JSON.parse(JSON.stringify(load("reasons.json"))));
  if (typeof f?.$comment !== "string" || !f.$comment.includes(FREEZE.sha256) || !f.$defs || typeof f.$defs !== "object") throw new Error("fleet.schema.json isn't the frozen revision's");
  if (r?.freeze !== FREEZE.sha256 || !Array.isArray(r.reasons)) throw new Error("reasons.json isn't the frozen revision's");
  fleet = f;
  reasons = Object.freeze(r.reasons.map((x) => x.name));
  given = load;
}

function deepFreeze(v) {
  if (v && typeof v === "object") { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); }
  return v;
}

const need = () => { if (given === null) throw new Error("no fleet schemas: install them with useSchemas()"); };

/** The schema document. */
export function fleetSchema() { need(); return fleet; }
/** Every registered reason code's name. */
export function reasonNames() { need(); return reasons; }

/** The validator for one $defs entry (a body type such as "host-grant"). */
export function bodyValidator(name) {
  need();
  if (!Object.hasOwn(fleet.$defs, name)) throw new Error(`no fleet schema ${name}`);
  if (!cache.has(name)) cache.set(name, compile({ $defs: fleet.$defs, $ref: `#/$defs/${name}` }));
  return cache.get(name);
}
