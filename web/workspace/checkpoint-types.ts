// Type-level pins of web/workspace/checkpoint.ts (tsconfig.web.json checks this file; nothing imports it): an accepted
// batch is made only by acceptedBatch, so a local or unsent row, or a plain object shaped like a batch, can't be passed
// where the exact cut, an install or the coverage rule want accepted history (BH-0b-2 map r2, the grader's pin).
import type { Patch } from "patchflow";
import { acceptedBatch, exactCut, checkCheckpoint, type AcceptedBatch, type Descriptor } from "./checkpoint.ts";
import type { DocCodec } from "patchflow";

declare const codec: DocCodec;
declare const local: Patch;
declare const d: Descriptor;
const ok: AcceptedBatch = acceptedBatch(1, [local], 0);
exactCut(codec, [ok], 1, local.time);
// @ts-expect-error a local row is not an accepted batch
exactCut(codec, [local], 1, local.time);
// @ts-expect-error nor is an object shaped like one: only acceptedBatch makes one
exactCut(codec, [{ seq: 1, patches: [local], charge: 0 }], 1, local.time);
// @ts-expect-error an install's tail is accepted batches too
void checkCheckpoint(codec, d, new Uint8Array(), [{ seq: 2, patches: [local], charge: 0 }]);
