# Sagebrush desktop app (Tauri 2)

The sagebrush.space notebook as an app for macOS, Linux and Windows. The
page runs in the system's web view (WebKit on macOS and Linux, WebView2 on
Windows), and Python and the engines run there as WebAssembly, exactly as
on the site. The installers are about 10–15 MB.

The Rust shell (`src-tauri/src/main.rs`) adds what a web page cannot do:

- **The computer's files.** File → *Open file…* and *Save as…* use the
  system's dialogs. A notebook opened from disk is its `.ipynb` file and is
  saved there as you work.
- **The notebook's folder.** The files next to the notebook (up to 64 MB
  each, 256 MB in all) are Python's files, so `loadmat('data.mat')` works.
  What Python writes in its folder goes back next to the notebook.
- **Opening files.** Double-clicking a `.ipynb` or `.sage` file opens it
  (the installers register the types), and so do paths on the command line
  and `open -a Sagebrush f.ipynb`.
- **Cross-origin isolation.** The page is served with COOP/COEP, so Stop
  raises KeyboardInterrupt and keeps the variables, as on the site.

The page itself is `web/index.html`, in its "app mode" (`window.__TAURI__`).
The service worker is off in the app, since the app's files are local.

## Build

```sh
pnpm run build && node scripts/build-cli.mjs   # the Python library
bun web/build.ts                               # the notebook page (web/dist)
node app/build-frontend.mjs                    # app/dist: the page's files for the app
cd app/src-tauri && cargo tauri build          # or `tauri build` with npm's @tauri-apps/cli
```

On Linux, Tauri needs `libwebkit2gtk-4.1-dev librsvg2-dev patchelf` (see
`.github/workflows/app.yml`). The bundles are in
`app/src-tauri/target/release/bundle/` (`.app`/`.dmg`, `.deb`/`.AppImage`/`.rpm`,
`.msi`/`.exe`). They are not signed or notarized yet.

## Self-test

```sh
node app/selftest/run.mjs app/src-tauri/target/release/sagebrush-app
```

This starts the app with `SAGEBRUSH_APP_SELFTEST` pointing at a copy of
`app/selftest/selftest.ipynb`. The page opens that notebook from disk and
runs it: Sage factors $2^{64}+1$, Python reads `data.csv` from the
notebook's folder and writes a file there, and a 3D plot is drawn. It then
checks the file Python wrote and saves the notebook. The app prints the
report and exits. CI (`.github/workflows/app.yml`) builds the app and runs
this self-test on macOS, Linux (under xvfb) and Windows.

## Next

- Signing: an Apple Developer ID with notarization, and Windows code signing.
- Updates: Tauri's updater plugin, fed from get.sagebrush.space.
- Native menus, recent files, and several windows.
- The Rust engines natively (Tauri commands) instead of as WebAssembly, for
  speed and for computations bigger than WebAssembly's 4 GB.
- iOS and Android, from this same project (Tauri 2 mobile).
