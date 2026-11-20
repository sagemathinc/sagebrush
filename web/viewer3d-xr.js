// A 3D plot in a headset: the viewer's "Enter VR" (web/viewer3d.js) loads this, only when pressed. The plot stands in
// front of you, about 60 cm across, drawn by the viewer itself (its drawWith, once per eye). Hold a grip to take it in
// that hand: move and turn it as you move your hand. Thumbstick up and down: bigger and smaller; left and right: turn
// it about its upright axis. B or Y (or the headset's own menu) leaves. Plain WebGL, no libraries, as the viewer is.
import { createInput, startSession } from "./xr-input.js";

// ---- column-major 4×4 matrices (as WebGL and WebXR use them)
const I = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function invert(m) {
  const o = new Float32Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return I();
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}
const translate = (x, y, z) => { const m = I(); m[12] = x; m[13] = y; m[14] = z; return m; };
const scaling = (s) => { const m = I(); m[0] = m[5] = m[10] = s; return m; };
const rotY = (a) => { const m = I(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; };
// (the viewer's display coordinates have z up; a headset's have y up)
const Z_UP = new Float32Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);

// ---- the controllers, drawn as short sticks (the plot's own program knows nothing of them)
function stickProgram(gl) {
  const vs = "attribute vec3 p;uniform mat4 M;uniform mat4 P;void main(){gl_Position=P*M*vec4(p,1.0);}";
  const fs = "precision mediump float;uniform vec3 c;void main(){gl_FragColor=vec4(c,1.0);}";
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  // (a 12 cm stick along the grip's -z, and a short cross at its end)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 0, 0, -0.12, -0.012, 0, -0.12, 0.012, 0, -0.12, 0, -0.012, -0.12, 0, 0.012, -0.12]), gl.STATIC_DRAW);
  return { p, b, ap: gl.getAttribLocation(p, "p"), M: gl.getUniformLocation(p, "M"), P: gl.getUniformLocation(p, "P"), c: gl.getUniformLocation(p, "c") };
}

/** Enter VR with the viewer's `gl` and `drawWith`; `half` is the plot box's half extents (display units). Resolves once
 * the session has started, with { end(), get state() }; `onEnd` runs when it ends (any way). */
export async function enter({ gl, drawWith, half, onEnd }) {
  const { session, refSpace, layer, floor } = await startSession(gl);
  const input = createInput();
  const stick = stickProgram(gl);
  // (the plot: centred 1 m ahead, a little below eye height, 60 cm across its widest side)
  const size = 2 * Math.max(half[0], half[1], half[2], 1e-9);
  let model = mul(translate(0, floor ? 1.3 : -0.1, -1.0), mul(scaling(0.6 / size), Z_UP));
  let grab = null; // ({ hand, start: inverse of the grip's pose then, model: the plot's then })
  let frames = 0, ended = false;
  const state = () => ({ frames, grabbed: grab?.hand ?? null, model: Array.from(model) });

  function onFrame(t, frame) {
    if (ended) return;
    session.requestAnimationFrame(onFrame);
    const pose = frame.getViewerPose(refSpace);
    if (!pose) return;
    const s = input.poll(frame, refSpace);
    // grabbing: the plot follows the hand that holds it
    for (const hand of ["right", "left"]) {
      const h = s[hand];
      if (!grab && h.pressed.squeeze && h.grip) grab = { hand, start: invert(h.grip), model };
    }
    if (grab) {
      const h = s[grab.hand];
      if (!h.held.squeeze || !h.grip) grab = null;
      else model = mul(h.grip, mul(grab.start, grab.model));
    }
    // the thumbsticks: up/down scale it, left/right turn it about its upright axis (about its centre)
    for (const hand of ["right", "left"]) {
      const [ax, ay] = s[hand].axes;
      if (!ax && !ay) continue;
      const c = [model[12], model[13], model[14]];
      const k = Math.exp(-ay * 0.02), a = ax * 0.03;
      model = mul(translate(c[0], c[1], c[2]), mul(rotY(a), mul(scaling(k), mul(translate(-c[0], -c[1], -c[2]), model))));
      if (grab) grab = { ...grab, model: mul(invert(mul(s[grab.hand].grip, grab.start)), model) };
    }
    if (s.left.pressed.b || s.right.pressed.b) { end(); return; }

    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0.12, 0.13, 0.15, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const inv = invert(model);
    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      const V = view.transform.inverse.matrix, P = view.projectionMatrix;
      const e = view.transform.position;
      const eye = [0, 1, 2].map((i) => inv[i] * e.x + inv[4 + i] * e.y + inv[8 + i] * e.z + inv[12 + i]);
      drawWith({ M: Array.from(mul(V, model)), P: Array.from(P), eye, height: vp.height });
      // the controllers
      gl.useProgram(stick.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, stick.b);
      gl.vertexAttribPointer(stick.ap, 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(stick.ap);
      gl.uniformMatrix4fv(stick.P, false, P);
      for (const hand of ["left", "right"]) {
        const g = s[hand].grip;
        if (!g) continue;
        gl.uniformMatrix4fv(stick.M, false, mul(V, g));
        gl.uniform3fv(stick.c, grab?.hand === hand ? [1, 0.75, 0.2] : [0.85, 0.88, 0.95]);
        gl.drawArrays(gl.LINES, 0, 6);
      }
    }
    frames++;
  }
  function end() {
    if (ended) return;
    ended = true;
    session.end().catch(() => {});
  }
  session.addEventListener("end", () => {
    ended = true;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    onEnd?.();
  });
  session.requestAnimationFrame(onFrame);
  return { end, get state() { return state(); } };
}
