// ci: web-sync.4 order=35 runner=bun
// Documents open in View mode (web/doc-mode.ts; William, Nov 4): what each document was last left in, kept in this
// browser, and the one shortcut, with stand-ins for localStorage and the DOM.
//   bun web/test-doc-mode.mjs
let checks = 0;
const fails = [];
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails.push(what); };

// (a localStorage: a map, which can be made to throw; the DOM's elements, as typingIn asks them)
const store = new Map();
let throwing = false;
globalThis.localStorage = {
  getItem: (k) => { if (throwing) throw new Error("denied"); return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { if (throwing) throw new Error("denied"); store.set(k, String(v)); },
};
class HTMLElement {
  constructor(sel, editable = false) { this.sel = sel; this.isContentEditable = editable; }
  matches(s) { return s.split(",").map((x) => x.trim()).includes(this.sel); }
}
globalThis.HTMLElement = HTMLElement;
globalThis.document = { activeElement: null };
const { modeOf, modeKey, rememberMode, shortcutMode, typingIn, EDIT_TITLE, EDITING_TITLE } = await import("./doc-mode.ts");

const K = modeKey("board", "abc123abc123");
ok(K === "board:abc123abc123", `a document's key is its kind and id (${K})`);
ok(modeOf(K) === "view", "a document opens in View");
rememberMode(K, "edit");
ok(modeOf(K) === "edit", "…in Edit once the person made it here or left it in Edit");
ok(modeOf(modeKey("notebook", "abc123abc123")) === "view", "…by kind and id: another kind's same id is apart");
rememberMode(K, "view");
ok(modeOf(K) === "view", "left in View: View again");
ok(!JSON.parse(store.get("sagebrush-doc-modes")).hasOwnProperty(K), "…and nothing is kept for it (View is the default)");

// (at most 1000 documents: the oldest go)
store.clear();
const realNow = Date.now;
let t = 1_000_000;
Date.now = () => ++t;
for (let i = 0; i < 1005; i++) rememberMode(modeKey("board", "b" + i), "edit");
Date.now = realNow;
const keptKeys = Object.keys(JSON.parse(store.get("sagebrush-doc-modes")));
ok(keptKeys.length === 1000, `at most 1000 documents are kept (${keptKeys.length})`);
ok(modeOf(modeKey("board", "b0")) === "view" && modeOf(modeKey("board", "b4")) === "view" && modeOf(modeKey("board", "b5")) === "edit" && modeOf(modeKey("board", "b1004")) === "edit", "…the oldest going first");

// (unreadable or refused storage: View, and nothing throws)
store.set("sagebrush-doc-modes", "{not json");
ok(modeOf(K) === "view", "storage that can't be read: View");
store.set("sagebrush-doc-modes", JSON.stringify([1, 2]));
ok(modeOf(K) === "view", "…nor storage of another shape");
let threwArr = null;
try { rememberMode(modeKey("board", "arr1"), "edit"); } catch (e) { threwArr = e; }
ok(threwArr === null && modeOf(modeKey("board", "arr1")) === "edit" && !Array.isArray(JSON.parse(store.get("sagebrush-doc-modes"))), `…an Array store: keeping over it doesn't throw, and writes a record (grader's V7) (${threwArr})`);
store.set("sagebrush-doc-modes", JSON.stringify({ [K]: "yes" }));
ok(modeOf(K) === "view", "…nor a value that isn't a time");
// (a time past what a number holds, as raw JSON text: 1e999 parses to Infinity, which is no time: grader's V2b)
store.set("sagebrush-doc-modes", '{"board:inf":1e999,"board:ninf":-1e999}');
ok(modeOf("board:inf") === "view" && modeOf("board:ninf") === "view", "…nor a time past any number's (1e999 in the stored text: Infinity): View");
// (astra's MODE658-SHAPE-1: more than 1000 entries that aren't times, objects among them, in a store written by
// another page: View, nothing thrown, and they go as the store is written)
const bad = {};
for (let i = 0; i < 1001; i++) bad["board:x" + i] = i % 3 === 0 ? { valueOf: null, toString: null, extra: "payload" } : i % 3 === 1 ? "12" : null;
bad["board:inf"] = 1e999; // (JSON: null)
// (and a "__proto__" key in the text itself, as JSON.parse makes it an own key)
store.set("sagebrush-doc-modes", JSON.stringify(bad).replace(/^\{/, '{"__proto__":5,'));
ok(modeOf("board:x0") === "view" && modeOf("board:x1") === "view", "a store of entries that aren't times: View");
let threw2 = null;
try { rememberMode(modeKey("board", "new1"), "edit"); } catch (e) { threw2 = e; }
ok(threw2 === null && modeOf(modeKey("board", "new1")) === "edit", `…over 1000 of them: keeping a new one doesn't throw, and keeps it (${threw2})`);
const after = JSON.parse(store.get("sagebrush-doc-modes"));
ok(JSON.stringify(Object.keys(after)) === JSON.stringify(["__proto__", "board:new1"]) && Object.values(after).every((t) => typeof t === "number"), `…and only times are written back: what wasn't one goes (${JSON.stringify(Object.keys(after)).slice(0, 80)})`);
try { rememberMode(modeKey("board", "new1"), "view"); } catch (e) { threw2 = e; }
ok(threw2 === null && !JSON.stringify(JSON.parse(store.get("sagebrush-doc-modes"))).includes("payload"), "…a View written back carries none of the payload either");
store.set("sagebrush-doc-modes", JSON.stringify({ toString: 7, hasOwnProperty: 9, valueOf: 3 }));
ok(modeOf("toString") === "edit" && modeOf("constructor") === "view" && modeOf("hasOwnProperty") === "edit", "keys named like Object's own are plain keys (a record of its own: no prototype)");
throwing = true;
let threw = false;
try { rememberMode(K, "edit"); ok(modeOf(K) === "view", "storage refused: View, and nothing thrown"); } catch { threw = true; }
ok(!threw, "…(rememberMode and modeOf don't throw)");
throwing = false;

// (the shortcut: E for Edit, Esc for View; not while typing, nor with a modifier, nor a held key's repeats)
const key = (k, o = {}) => ({ key: k, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, repeat: false, target: null, ...o });
ok(shortcutMode(key("e")) === "edit" && shortcutMode(key("E")) === "edit", "E (either case) asks for Edit");
ok(shortcutMode(key("Escape")) === "view", "Esc asks for View");
ok(shortcutMode(key("x")) === null && shortcutMode(key("Enter")) === null, "other keys ask for nothing");
for (const m of ["metaKey", "ctrlKey", "altKey"]) ok(shortcutMode(key("e", { [m]: true })) === null, `not with ${m.replace("Key", "")}`);
ok(shortcutMode(key("e", { repeat: true })) === null, "not a held key's repeat");
ok(shortcutMode(key("e", { defaultPrevented: true })) === null, "not a key something else took");
for (const sel of ["input", "textarea", "select", "[role=textbox]"]) ok(shortcutMode(key("e", { target: new HTMLElement(sel) })) === null && shortcutMode(key("Escape", { target: new HTMLElement(sel) })) === null, `not while typing in ${sel} (E types, Esc keeps its meaning)`);
ok(shortcutMode(key("e", { target: new HTMLElement("div", true) })) === null, "…nor in an editable element (contenteditable)");
globalThis.document.activeElement = new HTMLElement("textarea");
ok(shortcutMode(key("e", { target: new HTMLElement("div") })) === null, "…nor while focus is in a field, whatever the event's target");
globalThis.document.activeElement = null;
ok(typingIn(new HTMLElement("div")) === false && typingIn(null) === false, "a plain element, or none, isn't typing");
ok(/\(E\)/.test(EDIT_TITLE) && /Esc/.test(EDITING_TITLE), `the control's title says the shortcut ("${EDIT_TITLE}", "${EDITING_TITLE}")`);

console.log(fails.length ? `${fails.length} of ${checks} failed` : `all passed (${checks})`);
process.exit(fails.length ? 1 : 0);
