// The engine subprocess (app/engine/, design/native-desktop.md §2), on the
// desktop: started by the page (engine_start), which then sends it frames
// (engine_send) and receives its frames on a channel, in order.  This side
// only carries frames: their length is checked, their content is the page's
// and the engine's (app/engine/frames.mjs).  One engine for the app; starting
// it again (a reloaded page) ends the one before.  When it ends, the page is
// told with one last message of this side's own, {"engineExit": why}.
//
// What may wait, both ways, is bounded:
// - to the engine: engine_send only queues the frame (it never blocks the app
//   on the pipe) for one writer thread, at most SEND_MAX bytes waiting; past
//   that the frame is refused, and the page ends the engine.  A frame sent
//   urgent (Stop: the request's Sagebrush-Urgent header) goes ahead of every
//   frame still waiting, so it waits at most for the one being written.
// - to the page: the reader passes a frame on only while the page has
//   acknowledged (engine_ack) all but WINDOW bytes of what it was given (one
//   frame at a time past that, when nothing is unacknowledged).  A page that
//   stops reading stops the reader; the engine's own output then waits in the
//   pipe and in the engine, which stops itself past its bound (app/engine/serve.mjs
//   OUT_MAX).
//
// Which engine: SAGEBRUSH_APP_ENGINE, the engine's main.mjs, run by Node
// (SAGEBRUSH_APP_ENGINE_NODE, or `node` on the PATH) with
// SAGEBRUSH_APP_ENGINE_ROOT as its root (the page's worker and its files).
// Without them there is no engine, and the page runs Python as before.
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};

// (app/engine/frames.mjs FRAME_MAX)
const FRAME_MAX: usize = 512 * 1024 * 1024;
// the bytes that may wait for the writer
const SEND_MAX: usize = FRAME_MAX + 64 * 1024 * 1024;
// the bytes the page may hold unacknowledged
const WINDOW: usize = 64 * 1024 * 1024;

/// Frames waiting for the writer: urgent ones first, at most `max` bytes in all.
pub struct SendQueue {
    urgent: VecDeque<Vec<u8>>,
    data: VecDeque<Vec<u8>>,
    bytes: usize,
    max: usize,
    closed: bool,
}

impl SendQueue {
    pub fn new(max: usize) -> Self {
        SendQueue { urgent: VecDeque::new(), data: VecDeque::new(), bytes: 0, max, closed: false }
    }
    /// Queues a frame's payload; an error if the queue is closed or would pass its bound.
    pub fn push(&mut self, payload: Vec<u8>, urgent: bool) -> Result<(), &'static str> {
        if self.closed {
            return Err("the engine stopped");
        }
        if self.bytes + payload.len() > self.max {
            return Err("the engine isn't taking messages");
        }
        self.bytes += payload.len();
        if urgent { self.urgent.push_back(payload) } else { self.data.push_back(payload) }
        Ok(())
    }
    /// The next frame to write, urgent first.
    pub fn pop(&mut self) -> Option<Vec<u8>> {
        let p = self.urgent.pop_front().or_else(|| self.data.pop_front())?;
        self.bytes -= p.len();
        Some(p)
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.urgent.clear();
        self.data.clear();
        self.bytes = 0;
    }
}

/// What the page holds unacknowledged.
pub struct Window {
    unacked: usize,
    max: usize,
    closed: bool,
}

impl Window {
    pub fn new(max: usize) -> Self {
        Window { unacked: 0, max, closed: false }
    }
    /// Whether a frame of `n` bytes may go to the page now (a frame larger than the window goes alone).
    pub fn admits(&self, n: usize) -> bool {
        self.unacked == 0 || self.unacked + n <= self.max
    }
    pub fn sent(&mut self, n: usize) {
        self.unacked += n;
    }
    pub fn ack(&mut self, n: usize) {
        self.unacked -= n.min(self.unacked);
    }
}

struct Shared<T> {
    state: Mutex<T>,
    cv: Condvar,
}

struct Running {
    child: Child,
    send: Arc<Shared<SendQueue>>,
    window: Arc<Shared<Window>>,
}

#[derive(Default)]
pub struct Engine(Mutex<Option<Running>>);

impl Engine {
    /// Ends the engine, if one runs (the app is quitting, or a new one starts).
    pub fn stop(&self) {
        if let Some(mut r) = self.0.lock().unwrap().take() {
            // (the writer stops and closes the engine's stdin: the engine stops its interpreters and exits by itself;
            // the kill is for one that doesn't; the reader, if waiting for the page, is released)
            r.send.state.lock().unwrap().close();
            r.send.cv.notify_all();
            r.window.state.lock().unwrap().closed = true;
            r.window.cv.notify_all();
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

fn command() -> Option<Command> {
    let main = std::env::var_os("SAGEBRUSH_APP_ENGINE").filter(|s| !s.is_empty())?;
    let root = std::env::var_os("SAGEBRUSH_APP_ENGINE_ROOT").filter(|s| !s.is_empty())?;
    let node = std::env::var_os("SAGEBRUSH_APP_ENGINE_NODE")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "node".into());
    let mut c = Command::new(node);
    c.arg(main).arg("--stdio").arg("--root").arg(root);
    Some(c)
}

/// A message of this side's own, as app/engine/frames.mjs encodes one: its JSON's length, then the JSON.
fn own_message(json: &str) -> Vec<u8> {
    let mut p = (json.len() as u32).to_le_bytes().to_vec();
    p.extend_from_slice(json.as_bytes());
    p
}

/// Starts `cmd` as the engine: a writer thread for what the page sends, a reader thread giving each frame to
/// `deliver` once the window admits it (false: the page is gone), and at the end one {"engineExit"} of its own.
fn spawn_engine(mut cmd: Command, deliver: impl Fn(Vec<u8>) -> bool + Send + 'static) -> Result<Running, String> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("the engine didn't start: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("the engine has no stdin")?;
    let mut stdout = child.stdout.take().ok_or("the engine has no stdout")?;
    let send = Arc::new(Shared { state: Mutex::new(SendQueue::new(SEND_MAX)), cv: Condvar::new() });
    let window = Arc::new(Shared { state: Mutex::new(Window::new(WINDOW)), cv: Condvar::new() });
    // the writer: one frame at a time, urgent ones first; it ends (closing stdin) when the queue is closed or the
    // pipe fails (a killed engine's pipe fails at once, so a write blocked on an engine that doesn't read ends with it)
    let q = send.clone();
    std::thread::spawn(move || loop {
        let p = {
            let mut s = q.state.lock().unwrap();
            loop {
                if s.closed {
                    return;
                }
                if let Some(p) = s.pop() {
                    break p;
                }
                s = q.cv.wait(s).unwrap();
            }
        };
        let ok = stdin
            .write_all(&(p.len() as u32).to_le_bytes())
            .and_then(|_| stdin.write_all(&p))
            .and_then(|_| stdin.flush());
        if ok.is_err() {
            q.state.lock().unwrap().close();
            return;
        }
    });
    // the reader: each frame to the page once the window admits it
    let w = window.clone();
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
            {
                let mut s = w.state.lock().unwrap();
                while !s.closed && !s.admits(n) {
                    s = w.cv.wait_timeout(s, Duration::from_secs(1)).unwrap().0;
                }
                if s.closed {
                    return;
                }
                s.sent(n);
            }
            if !deliver(payload) {
                break "lost its page";
            }
        };
        deliver(own_message(&format!("{{\"engineExit\":\"{why}\"}}")));
    });
    Ok(Running { child, send, window })
}

/// Starts the engine (ending one already running); false if this app has none.
#[tauri::command]
pub fn engine_start(
    state: tauri::State<Engine>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<bool, String> {
    state.stop();
    let Some(cmd) = command() else {
        return Ok(false);
    };
    let running = spawn_engine(cmd, move |p| on_frame.send(InvokeResponseBody::Raw(p)).is_ok())?;
    *state.0.lock().unwrap() = Some(running);
    Ok(true)
}

/// One frame's payload, the request's raw body, queued for the engine; urgent with a Sagebrush-Urgent header.
#[tauri::command]
pub fn engine_send(state: tauri::State<Engine>, request: Request) -> Result<(), String> {
    let InvokeBody::Raw(payload) = request.body() else {
        return Err("a frame is sent as bytes".into());
    };
    if payload.len() > FRAME_MAX {
        return Err("a frame past the limit".into());
    }
    let urgent = request.headers().get("sagebrush-urgent").is_some();
    let guard = state.0.lock().unwrap();
    let r = guard.as_ref().ok_or("no engine is running")?;
    r.send.state.lock().unwrap().push(payload.clone(), urgent)?;
    r.send.cv.notify_all();
    Ok(())
}

/// The page has taken `bytes` more of what it was given.
#[tauri::command]
pub fn engine_ack(state: tauri::State<Engine>, bytes: usize) {
    if let Some(r) = state.0.lock().unwrap().as_ref() {
        r.window.state.lock().unwrap().ack(bytes);
        r.window.cv.notify_all();
    }
}

/// Ends the engine.
#[tauri::command]
pub fn engine_stop(state: tauri::State<Engine>) {
    state.stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_queue_bounds_bytes_and_puts_urgent_first() {
        let mut q = SendQueue::new(10);
        q.push(vec![1; 4], false).unwrap();
        q.push(vec![2; 4], false).unwrap();
        assert_eq!(q.push(vec![3; 3], false), Err("the engine isn't taking messages"));
        assert_eq!(q.push(vec![9; 3], true), Err("the engine isn't taking messages"));
        q.push(vec![9; 2], true).unwrap();
        assert_eq!(q.pop(), Some(vec![9; 2]));
        assert_eq!(q.pop(), Some(vec![1; 4]));
        q.push(vec![3; 6], false).unwrap();
        assert_eq!(q.pop(), Some(vec![2; 4]));
        assert_eq!(q.pop(), Some(vec![3; 6]));
        assert_eq!(q.pop(), None);
        q.push(vec![1; 1], false).unwrap();
        q.close();
        assert_eq!(q.pop(), None);
        assert_eq!(q.push(vec![1; 1], true), Err("the engine stopped"));
    }

    // An engine that never reads: the writer blocks in the pipe, and still stop() returns at once (it never waits on
    // the writer), the queue refuses past its bound meanwhile, and the writer's thread ends with the engine.
    #[cfg(unix)]
    #[test]
    fn a_non_reading_engine_cannot_block_stop() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let r = spawn_engine(cmd, |_| true).unwrap();
        let send = r.send.clone();
        // (well past a pipe's buffer, so the writer is blocked in write_all)
        for _ in 0..8 {
            send.state.lock().unwrap().push(vec![0u8; 1 << 20], false).unwrap();
        }
        send.cv.notify_all();
        std::thread::sleep(Duration::from_millis(300));
        let e = Engine::default();
        *e.0.lock().unwrap() = Some(r);
        let t = std::time::Instant::now();
        e.stop();
        assert!(t.elapsed() < Duration::from_secs(5), "stop took {:?}", t.elapsed());
        assert!(e.0.lock().unwrap().is_none());
        assert_eq!(send.state.lock().unwrap().push(vec![1], true), Err("the engine stopped"));
    }

    // A page that stops taking frames: the reader passes on only a window's worth, however many valid frames the
    // engine writes, and stop() releases it.
    #[cfg(unix)]
    #[test]
    fn a_stalled_page_holds_the_reader_to_the_window() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // (an engine writing 4096 frames of 64 KiB: 256 MiB, four windows)
        let script = "f=$(mktemp); head -c 65536 /dev/zero > $f; i=0; while [ $i -lt 4096 ]; do printf '\\000\\000\\001\\000'; cat $f; i=$((i+1)); done";
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        let got = Arc::new(AtomicUsize::new(0));
        let g = got.clone();
        let r = spawn_engine(cmd, move |p| {
            g.fetch_add(p.len(), Ordering::SeqCst);
            true
        })
        .unwrap();
        // (until what the page was given stops growing: the window, or the engine's end)
        let settle = |got: &AtomicUsize| {
            let mut last = usize::MAX;
            for _ in 0..60 {
                std::thread::sleep(Duration::from_millis(1500));
                let now = got.load(Ordering::SeqCst);
                if now == last {
                    return now;
                }
                last = now;
            }
            last
        };
        let given = settle(&got);
        assert!(given <= WINDOW, "the page was given {given} bytes unacknowledged");
        assert!(given >= WINDOW - 65536, "the page was given only {given} bytes");
        // (acknowledged: the next window's worth)
        r.window.state.lock().unwrap().ack(given);
        r.window.cv.notify_all();
        let more = settle(&got);
        assert!(more > given && more <= given + WINDOW, "after the acknowledgement: {more}");
        let e = Engine::default();
        *e.0.lock().unwrap() = Some(r);
        e.stop();
    }

    #[test]
    fn window_holds_the_reader_until_acknowledged() {
        let mut w = Window::new(10);
        assert!(w.admits(25)); // (a frame larger than the window goes alone)
        w.sent(25);
        assert!(!w.admits(1));
        w.ack(20);
        assert!(!w.admits(6));
        assert!(w.admits(5));
        w.ack(100); // (never below zero)
        assert!(w.admits(10));
        w.sent(6);
        assert!(w.admits(4) && !w.admits(5));
    }
}
