// The dev support Worker's entry (support-dev.sagebrush.space, `--mode dev`): the shared entry, with CoCalc's
// URL any https URL on cocalc.ai or under it with the intake path (DEV's CoCalc), and Turnstile's test keys allowed.
import { supportWorker } from "./index.ts";

export default supportWorker({ prod: false });
