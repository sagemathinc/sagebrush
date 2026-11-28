// Closing a window and quitting the app, with several windows (#1541).  Each window's page writes what it has to disk
// before it goes (web/workspace/disk-mirror.ts drainOnQuit): asked to ("sb-quit" to every window, "sb-close" to one),
// it says it is writing (app_quit_hold) and, once done (or the person chose to lose what wasn't saved), that it is done
// (app_quit_now).  This module decides, from those answers, when a window may be destroyed and when the app may exit:
//   - closing a window (not the last): that window alone is asked, and destroyed once it is done;
//   - quitting (or closing the last window): every window is asked, and the app exits once every window is done;
//   - a window that hasn't said it is writing within ANSWER (stalled, or not the app's page) is never given up on
//     silently, since it may hold unsaved changes: the person is asked, natively, "Wait" (it is watched again for
//     ANSWER) or "Close anyway" (it counts as done, what it hadn't saved lost);
//   - a window destroyed meanwhile has nothing more to answer.
// The decisions are pure (Leave's methods, unit-tested); lib.rs does what they return.
use std::collections::HashSet;

/// How long a window has to say it is writing before the person is asked about it.
pub const ANSWER: std::time::Duration = std::time::Duration::from_secs(3);

/// What lib.rs must do.
#[derive(Debug, PartialEq)]
pub enum Act {
    /// Ask these windows to write what they have ("sb-quit"); then watch each.
    AskQuit(Vec<String>),
    /// Ask this window to write what it has ("sb-close"); then watch it.
    AskClose(String),
    /// After ANSWER, call `answer_timeout` for this window.
    Watch(String),
    /// Ask the person about this window, natively: "Wait" or "Close anyway" (then call `stalled`).
    Stalled(String),
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
    /// (the windows the person is being asked about now)
    asking: HashSet<String>,
}

impl Leave {
    /// Whether the app is quitting (a close asked meanwhile changes nothing: every window is already asked).
    #[cfg(test)]
    pub fn quitting(&self) -> bool {
        self.quitting
    }
    fn asked(&self, label: &str) -> bool {
        if self.quitting { self.pending.contains(label) } else { self.closing.contains(label) }
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
        // (a window being closed on its own is asked again, as every window is: its answer counts for the quit)
        self.closing.clear();
        self.pending = windows.iter().cloned().collect();
        let mut acts = vec![Act::AskQuit(windows.clone())];
        acts.extend(windows.into_iter().map(Act::Watch));
        acts
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
        vec![Act::AskClose(label.to_string()), Act::Watch(label.to_string())]
    }
    /// Window `label` said it is writing.
    pub fn hold(&mut self, label: &str) {
        if self.asked(label) {
            self.held.insert(label.to_string());
        }
    }
    /// Window `label` is gone from the leaving: done, or given up on by the person.
    fn gone(&mut self, label: &str) -> Vec<Act> {
        self.held.remove(label);
        if self.quitting {
            return if self.pending.remove(label) && self.pending.is_empty() { vec![Act::Exit] } else { vec![] };
        }
        if self.closing.remove(label) {
            return vec![Act::Destroy(label.to_string())];
        }
        vec![]
    }
    /// Window `label` is done (written, or the person chose there to lose what wasn't saved).
    pub fn done(&mut self, label: &str) -> Vec<Act> {
        self.gone(label)
    }
    /// ANSWER after window `label` was asked (or watched again): if it hasn't said it is writing, the person is asked.
    pub fn answer_timeout(&mut self, label: &str) -> Vec<Act> {
        if !self.asked(label) || self.held.contains(label) || self.asking.contains(label) {
            return vec![];
        }
        self.asking.insert(label.to_string());
        vec![Act::Stalled(label.to_string())]
    }
    /// The person's answer about stalled window `label`: close it anyway (it counts as done), or wait (it is watched
    /// again).  An answer about a window that is no longer stalled changes nothing: one that said it is writing
    /// meanwhile is waited for until it is done, as any writing window (the native dialog can't be withdrawn, so its
    /// answer is ignored instead), and one done or gone meanwhile has nothing left to decide.
    pub fn stalled(&mut self, label: &str, close_anyway: bool) -> Vec<Act> {
        self.asking.remove(label);
        if !self.asked(label) || self.held.contains(label) {
            return vec![];
        }
        if close_anyway {
            return self.gone(label);
        }
        vec![Act::Watch(label.to_string())]
    }
    /// Window `label` is destroyed: it has nothing more to answer.
    pub fn destroyed(&mut self, label: &str) -> Vec<Act> {
        self.closing.remove(label);
        self.held.remove(label);
        self.asking.remove(label);
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
    fn s(x: &str) -> String {
        x.to_string()
    }

    #[test]
    fn an_unasked_hold_left_standing_doesnt_hide_a_later_stall() {
        // (a hold from a window nobody asked counts for nothing: left standing, it would hide that window's "isn't
        // responding" in a later quit, and the app would wait on it with no dialog)
        let mut l = Leave::default();
        l.hold("main");
        l.quit(w(&["main"]));
        assert_eq!(l.answer_timeout("main"), vec![Act::Stalled(s("main"))]);
    }

    #[test]
    fn closing_one_window_waits_for_it_alone() {
        let mut l = Leave::default();
        assert_eq!(l.close("doc-1", w(&["main", "doc-1"])), vec![Act::AskClose(s("doc-1")), Act::Watch(s("doc-1"))]);
        // (asked again while it writes: nothing more)
        assert_eq!(l.close("doc-1", w(&["main", "doc-1"])), vec![]);
        l.hold("doc-1");
        // (writing: its answer time passing asks nobody anything)
        assert_eq!(l.answer_timeout("doc-1"), vec![]);
        // (another window's answers change nothing of it)
        assert_eq!(l.done("main"), vec![]);
        assert_eq!(l.done("doc-1"), vec![Act::Destroy(s("doc-1"))]);
        assert!(!l.quitting());
    }

    #[test]
    fn a_window_that_never_answers_is_asked_about_never_closed_silently() {
        // (the mock page never answers: the person is asked; Wait watches it again, and asks again; Close anyway closes)
        let mut l = Leave::default();
        l.close("doc-2", w(&["main", "doc-2"]));
        assert_eq!(l.answer_timeout("doc-2"), vec![Act::Stalled(s("doc-2"))]);
        // (one question at a time about it)
        assert_eq!(l.answer_timeout("doc-2"), vec![]);
        assert_eq!(l.stalled("doc-2", false), vec![Act::Watch(s("doc-2"))]);
        assert_eq!(l.answer_timeout("doc-2"), vec![Act::Stalled(s("doc-2"))]);
        assert_eq!(l.stalled("doc-2", true), vec![Act::Destroy(s("doc-2"))]);
        // (a late answer from it then changes nothing)
        assert_eq!(l.done("doc-2"), vec![]);
    }

    #[test]
    fn a_window_that_says_it_is_writing_while_the_person_is_asked_is_waited_for() {
        // (it holds while the dialog is up: Close anyway is ignored, and it isn't destroyed until it is done)
        let mut l = Leave::default();
        l.close("doc-4", w(&["main", "doc-4"]));
        assert_eq!(l.answer_timeout("doc-4"), vec![Act::Stalled(s("doc-4"))]);
        l.hold("doc-4");
        assert_eq!(l.stalled("doc-4", true), vec![]);
        assert_eq!(l.answer_timeout("doc-4"), vec![]);
        assert_eq!(l.done("doc-4"), vec![Act::Destroy(s("doc-4"))]);
        // (the same in a quit: Close anyway ignored, the app waits for its done)
        let mut q = Leave::default();
        q.quit(w(&["main"]));
        assert_eq!(q.answer_timeout("main"), vec![Act::Stalled(s("main"))]);
        q.hold("main");
        assert_eq!(q.stalled("main", true), vec![]);
        assert_eq!(q.stalled("main", false), vec![]);
        assert_eq!(q.done("main"), vec![Act::Exit]);
    }

    #[test]
    fn a_window_that_finishes_while_the_person_is_asked_goes_its_own_way() {
        let mut l = Leave::default();
        l.close("doc-3", w(&["main", "doc-3"]));
        assert_eq!(l.answer_timeout("doc-3"), vec![Act::Stalled(s("doc-3"))]);
        l.hold("doc-3");
        assert_eq!(l.done("doc-3"), vec![Act::Destroy(s("doc-3"))]);
        // (the person's answer, after: nothing more)
        assert_eq!(l.stalled("doc-3", true), vec![]);
        assert_eq!(l.stalled("doc-3", false), vec![]);
    }

    #[test]
    fn closing_the_last_window_quits() {
        let mut l = Leave::default();
        assert_eq!(l.close("main", w(&["main"])), vec![Act::AskQuit(w(&["main"])), Act::Watch(s("main"))]);
        l.hold("main");
        assert_eq!(l.answer_timeout("main"), vec![]);
        assert_eq!(l.done("main"), vec![Act::Exit]);
    }

    #[test]
    fn quitting_waits_for_every_window() {
        let mut l = Leave::default();
        let mut want = vec![Act::AskQuit(w(&["main", "doc-1", "doc-2"]))];
        want.extend(["main", "doc-1", "doc-2"].map(|x| Act::Watch(s(x))));
        assert_eq!(l.quit(w(&["main", "doc-1", "doc-2"])), want);
        // (quit again, or a close meanwhile: nothing more)
        assert_eq!(l.quit(w(&["main"])), vec![]);
        assert_eq!(l.close("doc-1", w(&["main", "doc-1", "doc-2"])), vec![]);
        l.hold("main");
        l.hold("doc-1");
        // (the first done doesn't end the app while another writes: the bug PR 2's body states)
        assert_eq!(l.done("main"), vec![]);
        assert_eq!(l.answer_timeout("main"), vec![]);
        assert_eq!(l.answer_timeout("doc-1"), vec![]);
        // (doc-2 never answers: the person is asked about it, and waits once, then quits anyway)
        assert_eq!(l.answer_timeout("doc-2"), vec![Act::Stalled(s("doc-2"))]);
        assert_eq!(l.stalled("doc-2", false), vec![Act::Watch(s("doc-2"))]);
        assert_eq!(l.answer_timeout("doc-2"), vec![Act::Stalled(s("doc-2"))]);
        assert_eq!(l.stalled("doc-2", true), vec![]);
        // (doc-1 still writes: the app waits for it)
        assert_eq!(l.done("doc-1"), vec![Act::Exit]);
    }

    #[test]
    fn quitting_with_no_window_answering_asks_about_each_then_exits() {
        let mut l = Leave::default();
        l.quit(w(&["main", "doc-1"]));
        assert_eq!(l.answer_timeout("main"), vec![Act::Stalled(s("main"))]);
        assert_eq!(l.answer_timeout("doc-1"), vec![Act::Stalled(s("doc-1"))]);
        assert_eq!(l.stalled("main", true), vec![]);
        assert_eq!(l.stalled("doc-1", true), vec![Act::Exit]);
        let mut none = Leave::default();
        assert_eq!(none.quit(vec![]), vec![Act::Exit]);
    }

    #[test]
    fn a_window_gone_meanwhile_has_nothing_to_answer() {
        let mut l = Leave::default();
        l.quit(w(&["main", "doc-1"]));
        l.hold("main");
        assert_eq!(l.done("main"), vec![]);
        assert_eq!(l.answer_timeout("doc-1"), vec![Act::Stalled(s("doc-1"))]);
        assert_eq!(l.destroyed("doc-1"), vec![Act::Exit]);
        assert_eq!(l.stalled("doc-1", true), vec![]);
        // (closing: a window gone before it answered isn't destroyed again, nor asked about)
        let mut c = Leave::default();
        c.close("doc-3", w(&["main", "doc-3"]));
        assert_eq!(c.destroyed("doc-3"), vec![]);
        assert_eq!(c.answer_timeout("doc-3"), vec![]);
        assert_eq!(c.done("doc-3"), vec![]);
    }

    #[test]
    fn a_hold_from_a_window_not_asked_counts_for_nothing() {
        let mut l = Leave::default();
        l.hold("main");
        assert_eq!(l.done("main"), vec![]);
        l.quit(w(&["main"]));
        // (its earlier hold isn't this round's: it didn't answer this one, so the person is asked)
        assert_eq!(l.answer_timeout("main"), vec![Act::Stalled(s("main"))]);
    }
}
