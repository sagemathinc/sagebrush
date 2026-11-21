"""The relay and a page for docker/remote/smoke.sh: the repository's fake relay (engine/py/test_remote_relay.py) on
127.0.0.1:PORT, a page that pairs through it with a real WebCrypto key (remote_test_signer.mjs), binds and runs a cell,
and the container under test as the computer.  It runs inside the image itself (its Python has sagebrush, and Node
is there for the signer), with the repository's engine/py mounted at /t.

  python smoke_harness.py OUT_DIR PORT

Phases, each said on stdout and as a file in OUT_DIR, so smoke.sh can act between them:
  key.json      the computer's enrolled key, for the relay at http://127.0.0.1:PORT (smoke.sh puts it in the volume)
  phase1.ok     the container connected offering claude and codex, a page paired and bound, a cell printed 42 from
                ~/work
  phase2.ok     a new container on the same volume (smoke.sh removed the first) connected with the same key: no new
                pairing, and the same
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, "/t")
import test_remote_relay as T  # noqa: E402
from sagebrush.remote import keys as K  # noqa: E402

OUT, PORT = sys.argv[1], int(sys.argv[2])


def say(what):
    print("smoke: " + what, flush=True)


async def run_cell(leg, sg, gen):
    page, res = await T.paired(leg, sg, gen=gen)
    assert res["via"] == "relay", res
    st, b = await page.answer(await page.request("g.bind", {}, {}))
    assert st == 200, (st, b)
    binding = b["binding"]
    payload = {"code": "import os\nprint(6 * 7, os.getcwd())", "mode": "python"}
    st, a = await page.answer(await page.request("g.run", {"b": binding}, {"request": "r%d" % gen, "epoch": b.get("epoch", 1), "payload": payload}))
    assert st == 202, (st, a)
    ev = await page.events(await page.request("g.events", {"b": binding, "r": "r%d" % gen, "after": 0}))
    text = "".join(e.get("text", "") for e in ev if e["type"] == "stream")
    # (42, run in ~/work, the folder the entrypoint starts the runner in)
    assert text == "42 /home/sb/work\n" and ev[-1]["outcome"]["status"] == "ok", ev
    return text


async def main():
    relay = T.FakeRelay(None)
    relay.server = await asyncio.start_server(relay.handle, "127.0.0.1", PORT)
    relay.port, relay.origin = PORT, "http://127.0.0.1:%d" % PORT
    key = T.enrolled(relay.origin)
    key.name = "smoke-box"
    relay.key = key
    # (saved as enrollment saves it, in a private directory of this user's; then handed to smoke.sh, which copies it
    # into the volume, 0600)
    private = os.path.join(os.path.expanduser("~"), "smoke-key")
    os.makedirs(private, mode=0o700, exist_ok=True)
    K.save(key, os.path.join(private, "key.json"))
    with open(os.path.join(private, "key.json")) as f, open(os.path.join(OUT, "key.json.part"), "w") as g:
        g.write(f.read())
    os.rename(os.path.join(OUT, "key.json.part"), os.path.join(OUT, "key.json"))
    say("key written; waiting for the container")
    sg = await T.Signer().start()
    try:
        leg = await relay.leg(timeout=180)
        assert relay.upgrades[-1]["ok"], relay.upgrades
        # (both agents offered: the entrypoint's --serve-agents with claude and codex)
        assert relay.upgrades[-1]["agents"] == "claude,codex", relay.upgrades[-1]
        say("connected (upgrade signed by the enrolled key; agents %s)" % relay.upgrades[-1]["agents"])
        out = await run_cell(leg, sg, 1)
        say("ran print(6 * 7, os.getcwd()): %r" % out)
        open(os.path.join(OUT, "phase1.ok"), "w").write(out)
        leg2 = await relay.leg(timeout=180)
        assert relay.upgrades[-1]["ok"] and len(relay.upgrades) >= 2, relay.upgrades
        assert relay.upgrades[-1]["agents"] == "claude,codex", relay.upgrades[-1]
        say("connected again from a new container on the same volume, with the same key; agents %s" % relay.upgrades[-1]["agents"])
        out = await run_cell(leg2, sg, 2)
        say("ran print(6 * 7) again: %r" % out)
        open(os.path.join(OUT, "phase2.ok"), "w").write(out)
    finally:
        sg.close()
        relay.stop()


asyncio.run(main())
