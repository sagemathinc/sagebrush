// Remote approval in the page: what
// joins the reactive scheduler (src/notebook-reactive.ts), the approvals
// (src/remote-approval.ts) and a RemoteKernel (remote-kernel.js).
//
//   - The adapter: each cell's run spec as one frozen object, kept while
//     its key is the same four objects (the scheduler's run output for the
//     cell, the page's settings object, the kernel's record, the prepared
//     seed entry), and its parents as one frozen array, derived again only
//     when the graph's version changes and kept if equal.  Nothing in it is
//     compared by value: a stale spec is caught by sameRun before the send.
//   - The gated host: the scheduler's host, with a person's consent checked
//     in stages (before and after registration, after the seeds are
//     prepared, then approved all or nothing), the action planned (the
//     precount) before anything is hashed or sent, each run frozen when it
//     is handed to the kernel, checked when it is dispatched and admitted
//     right before the fetch that sends it (remote-kernel.js), and its
//     terminal applied to exactly that attempt.
//   - Forgetting names: their cells' records and pending attempts are fenced
//     right before the request that deletes them is sent.
//   - The kernel's lifecycle: a new binding or epoch resets approvals and
//     records; a new generation or incarnation, a move or a close clears the
//     records.
//
//   const gate = new RemoteGate({ kernel, hash, page });
//   const host = gate.host(baseHost);          // the scheduler's host
//   const consent = gate.capture(ids);         // in a Run gesture's handler, synchronously
//   reactive.run(ids, { consent });

import { Approvals, makeSpec, CAPS, TooLarge, TOO_LARGE } from "../../src/remote-approval.ts";
import { NOTES } from "./remote-kernel.js";

const CHANGED = "\nNot run: it changed since you ran it.\n";
const mangleOf = (id) => String(id).replace(/[^A-Za-z0-9]/g, "");
const NO_PARENTS = Object.freeze([]);

// Test-only fault: a cell's parents array kept when the graph's version
// changes.  Never set outside tests (a census test checks that).
let testHooks = null;
/** Tests only: set (or clear, with null) the fault above ({parentsSkip: true}). */
export function setTestHooks(h) {
  testHooks = h;
}

// A job's own run, as remote-approval.ts sameRun compares it: what execCell asked the kernel for.
function jobRun(code, o) {
  return {
    code,
    mode: o.mode ?? "python",
    cell: String(o.cell ?? ""),
    seed: o.seed ? o.seed : null,
    mangle: o.mangle && o.cell ? mangleOf(o.cell) : null,
    forget: o.forget?.length ? o.forget : null,
    scoped: o.scoped && Object.keys(o.scoped).length ? o.scoped : null,
  };
}

export class RemoteGate {
  /**
   * @param {object} o
   * @param {import("./remote-kernel.js").RemoteKernel} o.kernel
   * @param {(text: string) => Promise<string>} o.hash SHA-256, hex
   * @param {object} o.page the page:
   *   reactive() (its Reactive);
   *   displayed(id) (a cell's text in its editor now), version(id) (its text version: a frozen {text},
   *   replaced whenever the text is), repair(id, text) (a new version of that text, made the cell's);
   *   config() (the settings object: a frozen {mode, seedNamespace, reactive}, replaced whenever one changes);
   *   mode(), seedNamespace(), reactiveFlag() (the settings' values, from the page's own state);
   *   seed(namespace, id) (the cell's seed from that namespace: Promise<string>)
   * @param {() => string} [o.newDoc] a document identity (tests)
   */
  constructor({ kernel, hash, page, newDoc }) {
    this.kernel = kernel;
    this.page = page;
    this.seeds = new Map(); // `${namespace}\0${id}` -> {seed} (frozen: its identity keys the spec)
    this.specs = new Map(); // id -> {out, cfg, lc, entry, spec, action}
    this.parentsMemo = new Map(); // id -> {version, parents, action}
    // (the action now: an entry used by it is never dropped to make room; see keep())
    this.action = 0;
    this.approvals = new Approvals(hash, { spec: (id) => this.spec(id), parents: (id) => this.parents(id) }, () => this.context(), newDoc);
    this.off = kernel.on("lifecycle", (old, lc) => this.lifecycle(old, lc));
  }

  context() {
    const lc = this.kernel.lc;
    return { binding: lc.binding, epoch: lc.epoch, generation: lc.generation, incarnation: lc.incarnation, ready: lc.phase === "ready" };
  }

  // ------------------------------------------------------------- the adapter

  // A cell's run spec: the same frozen object while its run output, the page's settings object, the
  // kernel's record and its prepared seed entry are the same objects (=== on each, nothing else);
  // undefined if it isn't registered, nothing is bound, or its seed isn't prepared.
  spec(id) {
    const r = this.page.reactive();
    const lc = this.kernel.lc;
    if (!r || lc.binding == null) return undefined;
    const out = r.runOutput(id);
    if (!out) return undefined;
    const cfg = this.page.config();
    const entry = this.seeds.get(`${cfg.seedNamespace}\0${id}`);
    if (!entry) return undefined;
    const prev = this.specs.get(id);
    if (prev && prev.out === out && prev.cfg === cfg && prev.lc === lc && prev.entry === entry) {
      prev.action = this.action;
      return prev.spec;
    }
    const spec = makeSpec(id, out.code, cfg.mode, { seed: entry.seed, forget: out.forget, mangle: cfg.reactive ? mangleOf(id) : null, scoped: out.scoped }, lc.binding);
    this.keep(this.specs, id, { out, cfg, lc, entry, spec });
    return spec;
  }

  // A cell's parents, sorted, as one frozen array: derived again only when the graph's version changed,
  // compared with the array before by value (cell ids, counted as visits), and that array kept if equal.
  parents(id) {
    const r = this.page.reactive();
    if (!r) return NO_PARENTS;
    const version = r.graph.version;
    const prev = this.parentsMemo.get(id);
    if (prev && (prev.version === version || testHooks?.parentsSkip)) {
      prev.action = this.action;
      return prev.parents;
    }
    const now = [...r.graph.parents(id)].sort();
    let same = false;
    if (prev && prev.parents.length === now.length) {
      this.approvals.budget.charge("visits", now.length);
      same = prev.parents.every((p, i) => p === now[i]);
    }
    const parents = same ? prev.parents : Object.freeze(now);
    this.keep(this.parentsMemo, id, { version, parents });
    return parents;
  }

  // Keep an adapter entry, within CAPS.maps: when full, what is gone from the notebook goes, then what
  // the action in progress doesn't use; if that is not enough, it isn't kept (its object is then made
  // anew on the next lookup, so a check against it skips: fail-closed).
  keep(map, id, entry) {
    entry.action = this.action;
    if (!map.has(id) && map.size >= CAPS.maps) {
      this.prune();
      if (map.size >= CAPS.maps) for (const [k, e] of map) if (e.action !== this.action) map.delete(k);
      if (map.size >= CAPS.maps) return;
    }
    map.set(id, entry);
  }

  // What is kept for cells no longer in the notebook goes.
  prune() {
    const r = this.page.reactive();
    const present = (id) => !!r?.registration(id);
    this.approvals.prune(present);
    for (const m of [this.specs, this.parentsMemo]) for (const id of [...m.keys()]) if (!present(id)) m.delete(id);
    for (const k of [...this.seeds.keys()]) if (!present(k.slice(k.indexOf("\0") + 1))) this.seeds.delete(k);
  }

  // A cell's seed from a namespace, prepared (computed from that namespace, never the page's current one).
  async prepareSeed(namespace, id) {
    const key = `${namespace}\0${id}`;
    if (this.seeds.has(key)) return;
    const seed = await this.page.seed(namespace, id);
    if (!this.seeds.has(key) && this.seeds.size < 2 * CAPS.maps) this.seeds.set(key, Object.freeze({ seed }));
  }

  // The page as it is now, for checking a consent.
  env() {
    const pg = this.page;
    return {
      settings: () => pg.config(),
      version: (id) => pg.version(id),
      registered: (id) => pg.reactive()?.registration(id)?.version,
      displayed: (id) => pg.displayed(id),
      mode: () => pg.mode(),
      seedNamespace: () => pg.seedNamespace(),
      reactive: () => pg.reactiveFlag(),
      seedReady: (namespace, id) => this.seeds.has(`${namespace}\0${id}`),
    };
  }

  // ------------------------------------------------------------- consent

  /**
   * A person's consent to run these cells as they are on screen: call it
   * synchronously in the gesture's handler (each cell's displayed text is
   * compared once with its text version, and a stale version replaced).
   */
  capture(ids) {
    const pg = this.page;
    const cfg = pg.config();
    const cells = new Map();
    for (const id of ids) {
      const displayed = pg.displayed(id), version = pg.version(id);
      if (displayed !== undefined && version) cells.set(id, { displayed, version });
    }
    return this.approvals.captureConsent(ids, {
      cells, repair: (id, text) => pg.repair(id, text), settings: cfg, mode: cfg.mode, seedNamespace: cfg.seedNamespace, reactive: cfg.reactive,
    });
  }

  /** The notebook was loaded or replaced, or its language changed: approvals and records start over. */
  documentReplaced() {
    this.approvals.reset({ newDocument: true });
    this.approvals.clearRecords();
  }

  // ------------------------------------------------------------- the kernel

  lifecycle(old, lc) {
    const a = this.approvals;
    if (lc.binding !== old.binding || lc.epoch !== old.epoch) {
      a.reset();
      a.clearRecords();
    } else if (lc.generation !== old.generation || lc.incarnation !== old.incarnation) a.clearRecords();
    if (lc.phase !== old.phase && lc.phase !== "ready") a.clearRecords();
  }

  /**
   * The scheduler's host, gated: `base` is the page's host (its execute
   * takes a fifth argument, the kernel options to add, and resolves to the
   * scheduler's result).
   */
  host(base) {
    const gate = this;
    const a = this.approvals;
    return {
      ...base,
      beginAction: () => {
        gate.action++;
        a.beginAction();
      },
      endAction: () => a.endAction(),
      rekey: (units) => a.rekey(units),
      consent(stage, cap) {
        try {
          a.consentStage(cap, stage, gate.env());
        } catch (e) {
          if (!(e instanceof TooLarge)) throw e;
        }
      },
      async prepare({ order, consent }) {
        gate.prune();
        const env = gate.env();
        const skip = new Map();
        const listed = consent ? consent.ids : [];
        try {
          // every seed in one await: the listed cells' from the captured namespace, the others' from the
          // current one (they run only by an approval they already have); then the "seeded" stage, once
          const ns = gate.page.config().seedNamespace;
          const want = new Map();
          for (const id of listed) want.set(`${consent.seedNamespace}\0${id}`, [consent.seedNamespace, id]);
          for (const id of order) want.set(`${ns}\0${id}`, [ns, id]);
          await Promise.all([...want.values()].map(([space, id]) => gate.prepareSeed(space, id)));
          if (consent) a.consentStage(consent, "seeded", env);
          const pc = a.precount(order, consent && a.consentStateOf(consent) === "issued" ? listed : []);
          if (!pc.ok) {
            if (consent) a.voidConsent(consent);
            return { refuse: `\nNot run: ${pc.reason}.\n` };
          }
          if (consent) {
            const ok = a.consentStateOf(consent) === "issued" && (await a.approveCells(listed, { expected: consent, env }));
            if (!ok) for (const id of listed) skip.set(id, CHANGED);
          }
        } catch (e) {
          if (e instanceof TooLarge) {
            if (consent) a.voidConsent(consent);
            return { refuse: `\nNot run: ${TOO_LARGE}.\n` };
          }
          throw e;
        }
        return { skip };
      },
      async execute(id, code, forget, scoped) {
        if (!gate.kernel.ready) return { ok: false, ms: 0, notRun: "skip", note: NOTES.notReady };
        let frozen;
        try {
          frozen = await a.freeze([id]);
        } catch (e) {
          if (e instanceof TooLarge) return { ok: false, ms: 0, notRun: "skip", note: `\nNot run: ${TOO_LARGE}.\n` };
          throw e;
        }
        let planned = null;
        const g = {
          check: (request) => a.check(frozen, request),
          sameRun: (c, o, spec) => a.sameRun(jobRun(c, o), spec),
          admit: (v) => a.admit(v),
          stillAdmitted: (v) => a.stillAdmitted(v),
          admitted: (p) => { planned = p; },
        };
        const r = await base.execute(id, code, forget, scoped, { gate: g });
        // the terminal, to exactly the attempt admitted (nothing, if none was): only a user-phase ok succeeds
        if (planned) {
          if (r.ok && !r.stopped && !r.notRun) a.succeeded(planned);
          else a.failed(planned);
        }
        return r;
      },
      forget(names, cells = []) {
        // (fenced now, and again right before the request is sent)
        a.forgotten(cells);
        return base.forget(names, cells, { forgetGuard: () => a.forgotten(cells) });
      },
    };
  }
}
