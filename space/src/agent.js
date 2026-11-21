// An agent in the space: a small figure that floats where it works.  A rounded head with a face screen (two eyes that
// blink, look about, and scan while it thinks), a body below it, two hands that float beside it, and a ring of light
// at its waist that turns while it works.  It moves along an arc to where it is going, turning to face its way; it
// says things in a bubble above it; while it works on something it reaches toward it with a beam.  Everything is made
// here from three.js shapes: no model file is fetched.
//   const a = createAgent(THREE, { color }); scene.add(a.group); each frame a.step(dt, eye)
//   a.moveTo(position, lookAt) -> Promise (arrived); a.say(text, ms); a.think(on); a.work(target | null); a.wave()
import { texToText } from "./tex.js";

export function createAgent(THREE, { color = 0x4a9d6f, name = "Sage" } = {}) {
  const group = new THREE.Group();
  group.name = "agent";
  const body = new THREE.Group(); // (bobs; the group itself moves)
  group.add(body);
  const c = new THREE.Color(color);
  const shell = new THREE.MeshStandardMaterial({ color: 0xf4f6f2, roughness: 0.35, metalness: 0.05 });
  const accent = new THREE.MeshStandardMaterial({ color: c, roughness: 0.4, metalness: 0.1 });
  const glow = new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color(0xffffff), 0.35) });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15202b, roughness: 0.2, metalness: 0.3 });

  // the head: a rounded box with a dark face screen and two eyes
  const head = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 0.35, 8, 20).rotateZ(Math.PI / 2), shell);
  head.position.y = 1.55;
  body.add(head);
  const face = new THREE.Mesh(new THREE.CapsuleGeometry(0.44, 0.3, 6, 16).rotateZ(Math.PI / 2).scale(1, 0.85, 0.5), dark);
  face.position.set(0, 1.55, 0.36);
  body.add(face);
  const eyes = [-0.24, 0.24].map((x) => {
    const e = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.12, 4, 10), glow);
    e.position.set(x, 1.58, 0.58);
    body.add(e);
    return e;
  });
  // an antenna with a light, a sprig of sagebrush green
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.35, 8), shell);
  stalk.position.set(0, 2.32, 0);
  body.add(stalk);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), glow);
  bulb.position.set(0, 2.52, 0);
  body.add(bulb);
  // the body: a rounded cone, and a ring at its waist
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.45, 6, 16).scale(1, 1, 0.8), accent);
  torso.position.y = 0.55;
  body.add(torso);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.035, 8, 48), glow);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.55;
  body.add(ring);
  const dots = new THREE.Group();
  for (let k = 0; k < 3; k++) {
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), glow);
    d.position.set(Math.cos((k * 2 * Math.PI) / 3) * 0.62, 0, Math.sin((k * 2 * Math.PI) / 3) * 0.62);
    dots.add(d);
  }
  dots.position.y = 0.55;
  body.add(dots);
  // the hands, floating
  const hands = [-1, 1].map((s) => {
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 14), shell);
    h.position.set(s * 0.72, 0.65, 0.12);
    body.add(h);
    return h;
  });
  // a soft shadow on the floor below it
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.6, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12, depthWrite: false }));
  shadow.position.y = -0.45;
  group.add(shadow);

  // the speech bubble: a sprite drawn on a canvas
  const bc = document.createElement("canvas");
  bc.width = 1024; bc.height = 384;
  const btex = new THREE.CanvasTexture(bc);
  btex.colorSpace = THREE.SRGBColorSpace;
  const bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: btex, transparent: true, depthWrite: false }));
  bubble.scale.set(4.8, 1.8, 1);
  bubble.position.set(0, 3.9, 0);
  bubble.renderOrder = 15;
  bubble.visible = false;
  group.add(bubble);
  function drawBubble(text) {
    const g = bc.getContext("2d");
    g.clearRect(0, 0, bc.width, bc.height);
    g.fillStyle = "rgba(255,255,255,0.96)";
    g.strokeStyle = "#" + c.getHexString();
    g.lineWidth = 6;
    g.beginPath(); g.roundRect(8, 8, bc.width - 16, bc.height - 70, 40); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(bc.width / 2 - 30, bc.height - 64); g.lineTo(bc.width / 2, bc.height - 12); g.lineTo(bc.width / 2 + 30, bc.height - 64); g.fill();
    g.fillStyle = "#1f2328";
    g.font = "600 30px system-ui, sans-serif";
    g.fillText(name, 40, 56);
    g.font = "38px system-ui, sans-serif";
    const words = texToText(text).replace(/\*\*|`/g, "").split(/\s+/), rows = [];
    let row = "";
    for (const w of words) { const t = row ? row + " " + w : w; if (g.measureText(t).width > bc.width - 80 && row) { rows.push(row); row = w; } else row = t; }
    if (row) rows.push(row);
    rows.slice(0, 5).forEach((r, i) => g.fillText(i === 4 && rows.length > 5 ? r + " …" : r, 40, 108 + i * 46));
    btex.needsUpdate = true;
  }

  // the work beam: from the right hand to what it works on
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 8, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color(0xffffff), 0.5), transparent: true, opacity: 0.6, depthWrite: false }));
  beam.visible = false;
  group.add(beam);

  // ---- behaviour
  let t = 0, thinking = false, target = null, sayUntil = 0, move = null, blinkAt = 2, wave = 0;
  const look = new THREE.Vector3(); // (where it faces, when not moving)
  let faceYaw = 0;
  function step(dt, eye) {
    t += dt;
    // (bobbing, and the hands with it, a little behind)
    body.position.y = Math.sin(t * 1.6) * 0.08;
    hands.forEach((h, k) => { h.position.y = 0.65 + Math.sin(t * 1.6 - 0.6 + k) * 0.06; });
    // (the ring turns, fast while thinking or working)
    dots.rotation.y += dt * (thinking || target ? 4 : 0.6);
    ring.material.opacity = 1;
    bulb.scale.setScalar(thinking ? 1 + 0.35 * Math.sin(t * 9) : 1);
    // (the eyes: a blink now and then; while thinking they scan from side to side)
    if (t > blinkAt) { blinkAt = t + 2.5 + Math.random() * 3; eyes.forEach((e) => (e.userData.blink = 0.14)); }
    for (const e of eyes) {
      e.userData.blink = Math.max(0, (e.userData.blink ?? 0) - dt);
      e.scale.y = e.userData.blink > 0 ? 0.15 : 1;
      e.position.x = Math.sign(e.position.x) * 0.24 + (thinking ? Math.sin(t * 3) * 0.1 : 0);
    }
    // (moving: along an arc, facing its way)
    if (move) {
      const u = Math.min(1, (performance.now() - move.t0) / move.ms), e = u * u * (3 - 2 * u);
      group.position.lerpVectors(move.from, move.to, e);
      group.position.y += Math.sin(Math.PI * u) * Math.min(4, move.from.distanceTo(move.to) * 0.15);
      const d = new THREE.Vector3().subVectors(move.to, move.from);
      if (d.lengthSq() > 1e-4) faceYaw = Math.atan2(d.x, d.z);
      if (u >= 1) { const done = move.done; move = null; if (move === null && look.lengthSq()) faceYaw = Math.atan2(look.x - group.position.x, look.z - group.position.z); done(); }
    } else if (target) {
      faceYaw = Math.atan2(target.x - group.position.x, target.z - group.position.z);
    } else if (eye) {
      // (idle: it turns to you)
      faceYaw = Math.atan2(eye.x - group.position.x, eye.z - group.position.z);
    }
    let dy = faceYaw - group.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    group.rotation.y += dy * Math.min(1, dt * 4);
    // (a wave: the right hand up and back)
    if (wave > 0) { wave = Math.max(0, wave - dt); hands[1].position.y += Math.sin((1 - wave / 1.2) * Math.PI * 3) * 0.25 + 0.5 * Math.sin((wave / 1.2) * Math.PI); }
    // (the beam, from the right hand to the target)
    beam.visible = !!target;
    if (target) {
      const from = hands[1].getWorldPosition(new THREE.Vector3());
      const local = group.worldToLocal(from.clone()), to = group.worldToLocal(target.clone());
      beam.position.copy(local);
      beam.lookAt(group.localToWorld(to.clone()));
      beam.scale.set(1, 1, local.distanceTo(to));
      beam.material.opacity = 0.35 + 0.25 * Math.sin(t * 12);
    }
    if (bubble.visible && sayUntil && performance.now() > sayUntil) bubble.visible = false;
  }
  return {
    group, step,
    get busy() { return thinking || !!target || !!move; },
    moveTo(to, lookAt = null, ms = null) {
      return new Promise((done) => {
        const from = group.position.clone(), dest = to.clone();
        if (lookAt) look.copy(lookAt);
        // (a move replaced, or the figure gone: its promise still settles)
        move?.done();
        move = { from, to: dest, t0: performance.now(), ms: ms ?? Math.max(500, Math.min(2200, from.distanceTo(dest) * 90)), done };
      });
    },
    say(text, ms = 0) { drawBubble(text); bubble.visible = true; sayUntil = ms ? performance.now() + ms : 0; },
    hush() { bubble.visible = false; },
    think(on) { thinking = !!on; },
    work(pos) { target = pos ? pos.clone() : null; },
    wave() { wave = 1.2; },
    stop() { move?.done(); move = null; target = null; thinking = false; },
  };
}
