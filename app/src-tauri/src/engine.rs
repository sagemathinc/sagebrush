// The engine subprocess (app/engine/, design/native-desktop.md §2), on the
// desktop: started by the page (engine_start), which then sends it frames
// (engine_send) and receives its frames on a channel, in order.  This side
// only carries frames: their length is checked, their content is the page's
// and the engine's (app/engine/frames.mjs).  One engine for the app; starting
// it again (a reloaded page) ends the one before.  When it ends, the page is
// told with one last message of this side's own, {"engineExit": code}.
//
// Which engine:
// - SAGEBRUSH_APP_ENGINE=off: none (the page runs Python itself, as before);
// - SAGEBRUSH_APP_ENGINE=<main.mjs>: that engine, run by Node
//   (SAGEBRUSH_APP_ENGINE_NODE, or `node` on the PATH) with
//   SAGEBRUSH_APP_ENGINE_ROOT as its root (development, tests);
// - otherwise, on macOS, the one the app ships (app/engine/bundle.mjs): its
//   Node beside the app's executable (externalBin), the engine and its root
//   in the app's resources; where the app has none, none.
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};

// (app/engine/frames.mjs FRAME_MAX)
const FRAME_MAX: usize = 512 * 1024 * 1024;

struct Running {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Engine(Mutex<Option<Running>>);

impl Engine {
    /// Ends the engine, if one runs (the app is quitting, or a new one starts).
    pub fn stop(&self) {
        if let Some(mut r) = self.0.lock().unwrap().take() {
            // (its stdin closed first: the engine stops its interpreters and exits by itself; the kill is for one
            // that doesn't)
            drop(r.stdin);
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

fn command(app: &tauri::AppHandle) -> Option<Command> {
    let main = std::env::var_os("SAGEBRUSH_APP_ENGINE").filter(|s| !s.is_empty());
    if main.as_deref() == Some(std::ffi::OsStr::new("off")) {
        return None;
    }
    let Some(main) = main else {
        return shipped(app);
    };
    let root = std::env::var_os("SAGEBRUSH_APP_ENGINE_ROOT").filter(|s| !s.is_empty())?;
    let node = std::env::var_os("SAGEBRUSH_APP_ENGINE_NODE")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "node".into());
    let mut c = Command::new(node);
    c.arg(main).arg("--stdio").arg("--root").arg(root);
    Some(c)
}

/// The engine the app ships, if it has one.
#[cfg(target_os = "macos")]
fn shipped(app: &tauri::AppHandle) -> Option<Command> {
    use tauri::Manager;
    let node = std::env::current_exe().ok()?.parent()?.join("sagebrush-node");
    let engine = app.path().resource_dir().ok()?.join("engine");
    if !node.is_file() || !engine.join("main.mjs").is_file() {
        return None;
    }
    let mut c = Command::new(node);
    c.arg(engine.join("main.mjs"))
        .arg("--stdio")
        .arg("--root")
        .arg(engine.join("root"));
    Some(c)
}

#[cfg(not(target_os = "macos"))]
fn shipped(_app: &tauri::AppHandle) -> Option<Command> {
    None
}

/// A message of this side's own, as app/engine/frames.mjs encodes one: its JSON's length, then the JSON.
fn own_message(json: &str) -> Vec<u8> {
    let mut p = (json.len() as u32).to_le_bytes().to_vec();
    p.extend_from_slice(json.as_bytes());
    p
}

/// Starts the engine (ending one already running); false if this app has none.
#[tauri::command]
pub fn engine_start(
    app: tauri::AppHandle,
    state: tauri::State<Engine>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<bool, String> {
    state.stop();
    let Some(mut cmd) = command(&app) else {
        return Ok(false);
    };
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("the engine didn't start: {e}"))?;
    let stdin = child.stdin.take().ok_or("the engine has no stdin")?;
    let mut stdout = child.stdout.take().ok_or("the engine has no stdout")?;
    std::thread::spawn(move || {
        let why = loop {
            let mut len = [0u8; 4];
            if stdout.read_exact(&mut len).is_err() {
                break "ended";
            }
            let n = u32::from_le_bytes(len) as usize;
            if n > FRAME_MAX {
                break "sent a frame past the limit";
            }
            let mut payload = vec![0u8; n];
            if stdout.read_exact(&mut payload).is_err() {
                break "ended in a frame";
            }
            if on_frame.send(InvokeResponseBody::Raw(payload)).is_err() {
                break "lost its page";
            }
        };
        let _ = on_frame.send(InvokeResponseBody::Raw(own_message(&format!(
            "{{\"engineExit\":\"{why}\"}}"
        ))));
    });
    *state.0.lock().unwrap() = Some(Running { child, stdin });
    Ok(true)
}

/// One frame's payload, the request's raw body, to the engine.
#[tauri::command]
pub fn engine_send(state: tauri::State<Engine>, request: Request) -> Result<(), String> {
    let InvokeBody::Raw(payload) = request.body() else {
        return Err("a frame is sent as bytes".into());
    };
    if payload.len() > FRAME_MAX {
        return Err("a frame past the limit".into());
    }
    let mut guard = state.0.lock().unwrap();
    let r = guard.as_mut().ok_or("no engine is running")?;
    // (the length and the payload under one lock: frames from the page never interleave)
    r.stdin
        .write_all(&(payload.len() as u32).to_le_bytes())
        .and_then(|_| r.stdin.write_all(payload))
        .and_then(|_| r.stdin.flush())
        .map_err(|e| format!("the engine stopped: {e}"))
}

/// Ends the engine.
#[tauri::command]
pub fn engine_stop(state: tauri::State<Engine>) {
    state.stop();
}
