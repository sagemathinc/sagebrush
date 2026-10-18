// Names a board gives that every object already has as a member
// ("constructor", "toString", "__proto__"): a sticker's icon and a tool's
// icon are looked up as their own entries, never the object's members
// (astra's note on board-proto-ids: iconEmoji("constructor") returned the
// inherited function, written out as a sticker's text).
//   bun web/board/test-own-names.mjs
import { iconEmoji } from "./stickers.ts";
import { icon } from "./icons.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
  check(iconEmoji(name) === "", `iconEmoji(${JSON.stringify(name)}): no emoji: ${String(iconEmoji(name)).slice(0, 60)}`);
  check(icon(name) === null, `icon(${JSON.stringify(name)}): no icon`);
}
check(iconEmoji("star") === "⭐", "iconEmoji(\"star\"): still its emoji");

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
