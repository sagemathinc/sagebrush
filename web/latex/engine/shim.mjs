// Browser shims for the two node globals the D4 core uses (timing and UTF-8 byte length).
if (typeof globalThis.process === "undefined") globalThis.process = { hrtime: { bigint: () => BigInt(Math.round(performance.now() * 1e6)) } };
if (typeof globalThis.Buffer === "undefined") { const enc = new TextEncoder(); globalThis.Buffer = { byteLength: (s) => enc.encode(s).length }; }
