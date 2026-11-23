// WebXR for Sagebrush's views, whatever draws them: starting a session on a WebGL context, and the controllers as
// plain state each frame (thumbsticks with a dead zone, buttons with their presses, the grip's pose). The 3D plot
// viewer's headset mode (web/viewer3d-xr.js) uses it; it knows nothing about what is drawn.

/** Whether this browser can enter `mode` ("immersive-vr" or "immersive-ar"). */
export async function supported(mode = "immersive-vr") {
  try {
    return !!navigator.xr && (await navigator.xr.isSessionSupported(mode));
  } catch {
    return false;
  }
}

/** An immersive session drawing with `gl`: { session, refSpace, layer, floor, ended } (floor: the reference space's
 * origin is on the floor, "local-floor"; else it is where the head started, "local"; ended(): whether the session has
 * ended, watched from the moment it was granted). Throws an error with code "context-lost" if making `gl` ready for
 * the headset cost its context (a browser may move it to another GPU): the caller's view is gone then. */
export async function startSession(gl, mode = "immersive-vr") {
  const session = await navigator.xr.requestSession(mode, { optionalFeatures: ["local-floor"] });
  let over = false;
  session.addEventListener("end", () => (over = true));
  try {
    await gl.makeXRCompatible();
    if (gl.isContextLost()) throw Object.assign(new Error("the view's graphics context was lost on entering VR"), { code: "context-lost" });
    if (over) throw new Error("the headset session ended as it started");
    const layer = new XRWebGLLayer(session, gl);
    session.updateRenderState({ baseLayer: layer });
    let refSpace, floor = true;
    try {
      refSpace = await session.requestReferenceSpace("local-floor");
    } catch {
      refSpace = await session.requestReferenceSpace("local");
      floor = false;
    }
    if (over) throw new Error("the headset session ended as it started");
    return { session, refSpace, layer, floor, ended: () => over };
  } catch (e) {
    await session.end().catch(() => {});
    throw e;
  }
}

// (the xr-standard gamepad: buttons 0 trigger, 1 squeeze, 3 thumbstick press, 4 A/X, 5 B/Y; axes 2, 3 the thumbstick)
const BUTTONS = { trigger: 0, squeeze: 1, stick: 3, a: 4, b: 5 };
const DEAD = 0.15;

/** The controllers, read once a frame: poll(frame, refSpace) gives { left, right }, each { connected, axes: [x, y]
 * (dead-zoned), held: {trigger, squeeze, stick, a, b}, pressed: (the same, true on the frame a press begins), grip
 * (the grip's pose, a column-major 4×4 Float32Array, or null) }. */
export function createInput() {
  const was = { left: {}, right: {} };
  const empty = () => ({ connected: false, axes: [0, 0], held: {}, pressed: {}, grip: null });
  return {
    poll(frame, refSpace) {
      const out = { left: empty(), right: empty() };
      for (const src of frame.session.inputSources) {
        const hand = src.handedness;
        if (hand !== "left" && hand !== "right") continue;
        const s = out[hand];
        s.connected = true;
        const gp = src.gamepad;
        if (gp) {
          const ax = gp.axes[2] ?? 0, ay = gp.axes[3] ?? 0;
          s.axes = [Math.abs(ax) > DEAD ? ax : 0, Math.abs(ay) > DEAD ? ay : 0];
          for (const [name, i] of Object.entries(BUTTONS)) {
            const on = !!gp.buttons[i]?.pressed;
            s.held[name] = on;
            s.pressed[name] = on && !was[hand][name];
            was[hand][name] = on;
          }
        }
        if (src.gripSpace) s.grip = frame.getPose(src.gripSpace, refSpace)?.transform.matrix ?? null;
      }
      return out;
    },
  };
}
