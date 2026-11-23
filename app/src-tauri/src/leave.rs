// Closing a window and quitting the app, with several windows (#1541).  Each window's page writes what it has to disk
// before it goes (web/workspace/disk-mirror.ts drainOnQuit): asked to ("sb-quit" to every window, "sb-close" to one),
// it says it is writing (app_quit_hold) and, once done (or the person chose to go anyway), that it is done
// (app_quit_now).  This module decides, from those answers, when a window may be destroyed and when the app may exit:
//   - closing a window (not the last): that window alone is asked, and destroyed once it is done, or at once if it
//     doesn't say it is writing within ANSWER (a page that isn't the app's, or never loaded);
//   - quitting (or closing the last window): every window is asked, and the app exits once every window that said it
//     is writing is done, and each other one had ANSWER to say so;
//   - a window destroyed meanwhile (its own close, a crash) has nothing more to answer.
// The decisions are pure (Leave's methods, unit-tested); lib.rs does what they return.
use std::collections::HashSet;

/// How long a window has to say it is writing before it counts as having nothing to write.
pub const ANSWER: std::time::Duration = std::time::Duration::from_secs(3);

/// What lib.rs must do.
#[derive(Debug, PartialEq)]
pub enum Act {
    /// Ask these windows to write what they have ("sb-quit"), then call `quit_timeout` after ANSWER.
    AskQuit(Vec<String>),
    /// Ask this window to write what it has ("sb-close"), then call `close_timeout` for it after ANSWER.
    AskClose(String),
    /// Destroy this window.
    Destroy(String),
    /// Exit the app.
    Exit,
}

#[derive(Default)]
pub struct Leave {
    quitting: bool,
    /// (quitting: the windows not yet done)
    pending: HashSet<String>,
    /// (closing, each on its own: the windows asked)
    closing: HashSet<String>,
    /// (the windows that said they are writing)
    held: HashSet<String>,
}

impl Leave {
    /// Whether the app is quitting (a close asked meanwhile changes nothing: every window is already asked).
    #[cfg(test)]
    pub fn quitting(&self) -> bool {
        self.quitting
    }
    /// The person quit (or the last window is to close): every window in `windows` is asked; none: exit.
    pub fn quit(&mut self, windows: Vec<String>) -> Vec<Act> {
        if self.quitting {
            return vec![];
        }
        if windows.is_empty() {
            return vec![Act::Exit];
        }
        self.quitting = true;
        self.closing.clear();
        self.pending = windows.iter().cloned().collect();
        vec![Act::AskQuit(windows)]
    }
    /// The person closed window `label`, `windows` being every window there is: the last one quits; another is asked.
    pub fn close(&mut self, label: &str, windows: Vec<String>) -> Vec<Act> {
        if self.quitting || self.closing.contains(label) {
            return vec![];
        }
        if windows.iter().all(|w| w == label) {
            return self.quit(windows);
        }
        self.closing.insert(label.to_string());
        vec![Act::AskClose(label.to_string())]
    }
    /// Window `label` said it is writing.
    pub fn hold(&mut self, label: &str) {
        if self.pending.contains(label) || self.closing.contains(label) {
            self.held.insert(label.to_string());
        }
    }
    /// Window `label` is done (written, or the person chose to go anyway).
    pub fn done(&mut self, label: &str) -> Vec<Act> {
        self.held.remove(label);
        if self.quitting {
            self.pending.remove(label);
            return if self.pending.is_empty() { vec![Act::Exit] } else { vec![] };
        }
        if self.closing.remove(label) {
            return vec![Act::Destroy(label.to_string())];
        }
        vec![]
    }
    /// ANSWER after a quit was asked: the windows that didn't say they are writing count as done.
    pub fn quit_timeout(&mut self) -> Vec<Act> {
        if !self.quitting {
            return vec![];
        }
        let held = &self.held;
        self.pending.retain(|w| held.contains(w));
        if self.pending.is_empty() { vec![Act::Exit] } else { vec![] }
    }
    /// ANSWER after window `label` was asked to close: if it didn't say it is writing, it goes now.
    pub fn close_timeout(&mut self, label: &str) -> Vec<Act> {
        if self.quitting || !self.closing.contains(label) || self.held.contains(label) {
            return vec![];
        }
        self.closing.remove(label);
        vec![Act::Destroy(label.to_string())]
    }
    /// Window `label` is gone: it has nothing more to answer.
    pub fn destroyed(&mut self, label: &str) -> Vec<Act> {
        self.closing.remove(label);
        self.held.remove(label);
        if self.quitting && self.pending.remove(label) && self.pending.is_empty() {
            return vec![Act::Exit];
        }
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn w(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn closing_one_window_waits_for_it_alone() {
        let mut l = Leave::default();
        assert_eq!(l.close("doc-1", w(&["main", "doc-1"])), vec![Act::AskClose("doc-1".into())]);
        // (asked again while it writes: nothing more)
        assert_eq!(l.close("doc-1", w(&["main", "doc-1"])), vec![]);
        l.hold("doc-1");
        // (writing: its answer time passing doesn't close it)
        assert_eq!(l.close_timeout("doc-1"), vec![]);
        // (another window's answers change nothing of it)
        assert_eq!(l.done("main"), vec![]);
        assert_eq!(l.done("doc-1"), vec![Act::Destroy("doc-1".into())]);
        // (and never the app)
        assert!(!l.quitting());
    }

    #[test]
    fn a_window_that_doesnt_answer_closes_after_its_time() {
        let mut l = Leave::default();
        l.close("doc-2", w(&["main", "doc-2"]));
        assert_eq!(l.close_timeout("doc-2"), vec![Act::Destroy("doc-2".into())]);
        // (a late answer then changes nothing)
        assert_eq!(l.done("doc-2"), vec![]);
    }

    #[test]
    fn closing_the_last_window_quits() {
        let mut l = Leave::default();
        assert_eq!(l.close("main", w(&["main"])), vec![Act::AskQuit(w(&["main"]))]);
        l.hold("main");
        assert_eq!(l.quit_timeout(), vec![]);
        assert_eq!(l.done("main"), vec![Act::Exit]);
    }

    #[test]
    fn quitting_waits_for_every_window_that_writes() {
        let mut l = Leave::default();
        assert_eq!(l.quit(w(&["main", "doc-1", "doc-2"])), vec![Act::AskQuit(w(&["main", "doc-1", "doc-2"]))]);
        // (quit again, or a close meanwhile: nothing more)
        assert_eq!(l.quit(w(&["main"])), vec![]);
        assert_eq!(l.close("doc-1", w(&["main", "doc-1", "doc-2"])), vec![]);
        l.hold("main");
        l.hold("doc-1");
        // (the first done doesn't end the app while another writes: the bug PR 2's body states)
        assert_eq!(l.done("main"), vec![]);
        // (doc-2 never answered: counted done at its time; doc-1 still writes)
        assert_eq!(l.quit_timeout(), vec![]);
        assert_eq!(l.done("doc-1"), vec![Act::Exit]);
    }

    #[test]
    fn quitting_with_no_window_that_writes_exits_at_the_answer_time() {
        let mut l = Leave::default();
        l.quit(w(&["main", "doc-1"]));
        assert_eq!(l.quit_timeout(), vec![Act::Exit]);
        let mut none = Leave::default();
        assert_eq!(none.quit(vec![]), vec![Act::Exit]);
    }

    #[test]
    fn a_window_gone_meanwhile_has_nothing_to_answer() {
        let mut l = Leave::default();
        l.quit(w(&["main", "doc-1"]));
        l.hold("main");
        l.hold("doc-1");
        assert_eq!(l.done("main"), vec![]);
        assert_eq!(l.destroyed("doc-1"), vec![Act::Exit]);
        // (closing: a window gone before it answered isn't destroyed again)
        let mut c = Leave::default();
        c.close("doc-3", w(&["main", "doc-3"]));
        c.hold("doc-3");
        assert_eq!(c.destroyed("doc-3"), vec![]);
        assert_eq!(c.close_timeout("doc-3"), vec![]);
        assert_eq!(c.done("doc-3"), vec![]);
    }

    #[test]
    fn a_hold_from_a_window_not_asked_counts_for_nothing() {
        let mut l = Leave::default();
        l.hold("main");
        assert_eq!(l.done("main"), vec![]);
        l.quit(w(&["main"]));
        // (its earlier hold isn't this round's: it didn't answer this one)
        assert_eq!(l.quit_timeout(), vec![Act::Exit]);
    }
}
