# Security policy

## Status: early alpha

Sagebrush is in **early alpha, before launch**, and is **not yet
security-hardened**. Don't store anything sensitive in it.

Its security design, and the reviews and fixes so far, are in
[design/security.md](design/security.md) and the other notes in
[design/](design/).

## Reporting a vulnerability in Sagebrush

While Sagebrush is in early alpha, it has no paying users. So a security issue
in Sagebrush itself may be reported, discussed and fixed **in public**: open an
[issue](https://github.com/sagemathinc/sagebrush/issues) or a pull request in
this repository. Please include what you found, how to reproduce it, and what
it lets someone do.

## Exception: anything that affects CoCalc

Report these **privately**, never in a public issue or pull request:

- the board frame that CoCalc embeds (`/frame/board/`, and the board host
  protocol between it and CoCalc);
- the user-content hosting on `cocalcusercontent.com` (and `.dev`);
- CoCalc accounts, sign-in with CoCalc, and CoCalc tokens or secrets.

They can affect CoCalc's users. Report them through
[CoCalc's private vulnerability reporting](https://github.com/sagemathinc/cocalc-ai/security/advisories/new),
or by email to [security@cocalc.ai](mailto:security@cocalc.ai). CoCalc's own
policy is in its
[SECURITY.md](https://github.com/sagemathinc/cocalc-ai/blob/main/SECURITY.md).

If you aren't sure whether an issue touches CoCalc, report it privately.

## This policy will change

Before Sagebrush launches, or before it charges anyone, this policy becomes
private disclosure for everything, and the early-alpha notice on
sagebrush.space comes down.
