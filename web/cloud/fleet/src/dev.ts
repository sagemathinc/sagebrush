// The DEV fleet Worker's entry (`--mode dev`).  The fleet service's state doesn't exist yet, so it runs with
// NO_FACTS: every open is refused (not_granted) while the feed and the control plane's authentication work in full.
import { NO_FACTS } from "../fleet.ts";
import { fleetWorker } from "./index.ts";

export default fleetWorker({ facts: NO_FACTS });
