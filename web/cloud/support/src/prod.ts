// The production support Worker's entry (support.sagebrush.space): the shared entry with production's checks on:
// CoCalc is exactly https://cocalc.ai/api/v2/support/sagebrush-intake, and Turnstile's test keys are refused
// (test-support.mjs: production's test-key rows).
import { supportWorker } from "./index.ts";

export default supportWorker({ prod: true });
