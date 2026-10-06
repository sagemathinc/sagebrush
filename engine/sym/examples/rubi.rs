//! Score the integrator on Rubi's test suite (converted by
//! bench/rubi/convert.py): one JSON line per problem with its status
//! (found = an antiderivative verified by differentiation, none, timeout,
//! error, bug) and time, for the problems start..end.
//!
//!     rubi <rubi.jsonl> <start> <end> <timeout ms>
use sagebrush_sym::{integrate::integrate, parse::parse};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static DEADLINE: AtomicU64 = AtomicU64::new(u64::MAX);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (path, start, end, timeout): (&str, usize, usize, u64) = (&args[1], args[2].parse().unwrap(), args[3].parse().unwrap(), args[4].parse().unwrap());
    std::panic::set_hook(Box::new(|_| {}));
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(5));
        let d = DEADLINE.load(Ordering::Relaxed);
        if now_ms() > d {
            sagebrush_interrupt::request();
            // a computation that never checks for interrupts: give up on
            // the process (score.py records a crash and goes on)
            if now_ms() > d.saturating_add(9 * timeout) {
                std::process::exit(3);
            }
        }
    });
    let out = std::io::stdout();
    let mut out = out.lock();
    let file = std::io::BufReader::new(std::fs::File::open(path).unwrap());
    for (i, line) in file.lines().enumerate() {
        if i < start {
            continue;
        }
        if i >= end {
            break;
        }
        let line = line.unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        let (f, x) = (v["in"].as_str().unwrap().to_string(), v["var"].as_str().unwrap().to_string());
        sagebrush_interrupt::clear();
        DEADLINE.store(now_ms() + timeout, Ordering::Relaxed);
        let t0 = Instant::now();
        let r = std::panic::catch_unwind(|| integrate(&parse(&f), &x).map(|r| sagebrush_sym::to_string(&r)));
        DEADLINE.store(u64::MAX, Ordering::Relaxed);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let (status, detail) = match r {
            Ok(Some(s)) => ("found", s),
            Ok(None) => ("none", String::new()),
            Err(p) if p.is::<sagebrush_interrupt::Interrupted>() => ("timeout", String::new()),
            Err(p) => match p.downcast::<sagebrush_sym::err::SymError>() {
                Ok(e) => ("error", e.to_string()),
                Err(p) => {
                    let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                    ("bug", msg)
                }
            },
        };
        let detail: String = detail.chars().take(300).collect();
        writeln!(out, "{}", serde_json::json!({"i": i, "status": status, "ms": (ms * 10.0).round() / 10.0, "detail": detail})).unwrap();
        out.flush().unwrap();
    }
}
