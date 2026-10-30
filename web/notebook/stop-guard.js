// A cell's ▶ is its Stop (■) while the cell is queued or running.  On a
// remote kernel the cell shows that it is queued a round trip or more after
// the Run, so a second click meant as Run (a double click, an impatient one)
// could land on Stop.  A bounded UI guard, not a promise about any network:
// a click on Stop within STOP_GUARD_MS of the button turning into Stop, or
// the second click of a double click, is ignored.  The toolbar's Stop and
// the interrupt keys are never guarded.

export const STOP_GUARD_MS = 400;

/** The button turns into Stop: the time is kept only on the actual change from Run (a repeated queued or running update keeps it). */
export function armStop(cell, now = performance.now()) {
  if (cell.runb.textContent !== "■") cell.stopArmedAt = now;
  cell.runb.textContent = "■";
}

/** The button is Run again (the cell settled): no guard is held. */
export function disarmStop(cell) {
  cell.stopArmedAt = null;
  cell.runb.textContent = "▶";
}

/** Whether a click on Stop is ignored: `detail` is the click's count (the event's detail; 0 from the keyboard). */
export function stopIgnored(armedAt, now, detail) {
  return detail > 1 || (armedAt != null && now - armedAt < STOP_GUARD_MS);
}
