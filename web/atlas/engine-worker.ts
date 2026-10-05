// A Web Worker running Sagebrush's engine (/sagebrush-engine.wasm, the
// notebook's): {id, req} -> {id, reply}, reply = {ok} | {error}.
let E: any = null;

async function engine() {
  if (E) return E;
  const res = await fetch("/sagebrush-engine.wasm");
  if (!res.ok) throw new Error(`could not load the engine (HTTP ${res.status})`);
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
  return (E = instance.exports);
}

self.onmessage = async (ev: MessageEvent) => {
  const { id, req } = ev.data;
  try {
    const e = await engine();
    const b = new TextEncoder().encode(JSON.stringify(req));
    const p = e.sb_alloc(b.length);
    new Uint8Array(e.memory.buffer, p, b.length).set(b);
    const r = e.sb_call(p, b.length);
    const reply = JSON.parse(new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len())));
    e.sb_free(p, b.length);
    postMessage({ id, reply });
  } catch (err) {
    postMessage({ id, reply: { error: String((err as Error)?.message ?? err) } });
  }
};
