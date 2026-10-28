//! The raster child's process handle and its creation (#157 simpler path:
//! r5 R2/R3, r6 S2, r7 T3/T4, r8 U4).
//!
//! A `Child` owns the process identity and the parent's ends of its pipes.
//! Every state change happens inside one of its methods, in the same native
//! step as the system call it records, so no Python bytecode (where a
//! KeyboardInterrupt can land) separates an effect from its record:
//!
//! - Running -> ExitedAwaitingReap: the life pipe reached EOF (every writer,
//!   the child alone, has exited) or the pidfd became readable (Windows: the
//!   process handle was signalled);
//! - Running or ExitedAwaitingReap -> Reaped: OUR wait returned the child's
//!   status (Windows: its exit code was read and the handle closed);
//! - -> Lost: our wait returned ECHILD (someone else reaped it: outside the
//!   supported contract; never on Windows, where the handle is the
//!   identity).  Lost and Reaped are terminal: the pid is never signalled or
//!   waited on again.
//!
//! POSIX (`sys` below): the pipes (H-1), each close-on-exec in the parent,
//! dup2'ed into the child by the spawn's file actions: request (parent
//! writes, child fd 0), reply (child fd 1, parent reads), kill (parent
//! writes, child fd 3), life (child fd 4 writes, never; the parent reads its
//! EOF).  stderr is the caller's file (fd 2).  Ending a child is a byte on
//! the kill pipe and closing it: the child's watchdog thread (raster_child.rs)
//! exits at once; SIGKILL is only a fallback, after one slice, while the life
//! pipe shows no exit, through the pidfd where there is one (identity-bound)
//! and otherwise by pid (safe only under the exclusive-reaper contract, which
//! `sigchld_refusal` checks at spawn).  Identity (#157 PIDFD note r2,
//! option B): glibc's posix_spawn, then pidfd_open of the child's pid while
//! it is ours and unreaped.  That is plan T4's I-2, conditional on the
//! reaper contract, NOT creation-atomic (I-1): see own_pidfd.
//!
//! Windows (`sys` below, r5 R3.4): created suspended, assigned to a job
//! object that kills it when the job's handle closes, then resumed; any
//! failure after the creation terminates it, waits and closes every handle
//! before `run` returns.  Only the child's three standard handles are
//! inherited (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), so a concurrent creation
//! elsewhere in the process can't receive them.  Ending it is
//! TerminateProcess on its handle (identity-bound: the object can't be reused
//! while the handle is open).

#[cfg(any(unix, windows))]
pub use api::*;

#[cfg(unix)]
mod sys {
    use pyo3::exceptions::PyOSError;
    use pyo3::prelude::*;
    use std::ffi::CString;

    fn errno() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    fn close(fd: &mut i32) {
        if *fd >= 0 {
            unsafe { libc::close(*fd) };
            *fd = -1;
        }
    }

    /// A pipe whose ends are close-on-exec (pipe2 on Linux; pipe + fcntl
    /// elsewhere).
    fn pipe_cloexec() -> Result<(i32, i32), i32> {
        let mut fds = [-1i32; 2];
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
                return Err(errno());
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        {
            if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
                return Err(errno());
            }
            for fd in fds {
                if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
                    // (a pipe whose ends would be inherited: refused, both closed)
                    let e = errno();
                    unsafe {
                        libc::close(fds[0]);
                        libc::close(fds[1]);
                    }
                    return Err(e);
                }
            }
        }
        Ok((fds[0], fds[1]))
    }

    /// The supported reaper contract (r6 S2.1): SIGCHLD neither ignored nor
    /// SA_NOCLDWAIT.  Read only: the application's signal state is never
    /// changed.
    pub(super) fn sigchld_refusal() -> Option<String> {
        let mut old: libc::sigaction = unsafe { std::mem::zeroed() };
        if unsafe { libc::sigaction(libc::SIGCHLD, std::ptr::null(), &mut old) } != 0 {
            return Some(format!("SIGCHLD's action can't be read (errno {})", errno()));
        }
        if old.sa_sigaction == libc::SIG_IGN {
            return Some("SIGCHLD is ignored in this process (SIG_IGN), so its child processes are reaped by the system and the PNG engine's process can't be tracked safely".into());
        }
        if old.sa_flags & libc::SA_NOCLDWAIT != 0 {
            return Some("SIGCHLD has SA_NOCLDWAIT in this process, so its child processes are reaped by the system and the PNG engine's process can't be tracked safely".into());
        }
        None
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    pub(super) enum State {
        Running,
        Exited,
        Reaped,
        Lost,
    }

    /// The process and the parent's ends of its pipes.
    pub(super) struct Proc {
        pid: libc::pid_t,
        pidfd: i32,
        pub(super) wfd: i32,
        pub(super) rfd: i32,
        killfd: i32,
        lifefd: i32,
        pub(super) state: State,
        status: Option<i32>,
        pub(super) signals: u64,
        // (slices waited since the life pipe's EOF without our wait seeing the exit)
        exited_waits: u32,
    }

    impl Proc {
        pub(super) fn pid(&self) -> i64 {
            self.pid as i64
        }

        pub(super) fn has_pidfd(&self) -> bool {
            self.pidfd >= 0
        }

        /// os.waitstatus_to_exitcode's value, once reaped.
        pub(super) fn code(&self) -> Option<i32> {
            self.status.map(|st| {
                if libc::WIFEXITED(st) {
                    libc::WEXITSTATUS(st)
                } else if libc::WIFSIGNALED(st) {
                    -libc::WTERMSIG(st)
                } else {
                    st
                }
            })
        }

        pub(super) fn terminal(&self) -> bool {
            matches!(self.state, State::Reaped | State::Lost)
        }

        /// The life pipe (or the pidfd) shows the exit: Running -> Exited.
        /// Exited and not yet reaped: a slice's wait (on the pidfd if there is
        /// one), counted.
        pub(super) fn observe(&mut self, timeout_ms: i32) {
            if self.state == State::Exited {
                if self.pidfd >= 0 {
                    let mut p = libc::pollfd { fd: self.pidfd, events: libc::POLLIN, revents: 0 };
                    unsafe { libc::poll(&mut p, 1, timeout_ms) };
                } else if timeout_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(timeout_ms as u64));
                }
                self.exited_waits = self.exited_waits.saturating_add(1);
                return;
            }
            if self.state != State::Running {
                return;
            }
            let fd = if self.lifefd >= 0 { self.lifefd } else { self.pidfd };
            if fd < 0 {
                return;
            }
            let mut p = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
            let n = unsafe { libc::poll(&mut p, 1, timeout_ms) };
            if n > 0 && p.revents != 0 {
                if fd == self.lifefd {
                    // (nothing is ever written: readable means EOF)
                    let mut b = [0u8; 1];
                    let r = unsafe { libc::read(fd, b.as_mut_ptr() as *mut libc::c_void, 1) };
                    if r == 0 || (p.revents & libc::POLLHUP) != 0 {
                        self.state = State::Exited;
                    }
                } else {
                    self.state = State::Exited;
                }
            }
        }

        /// One non-blocking wait (ours): Reaped with the status, Lost on
        /// ECHILD, or unchanged.
        pub(super) fn try_wait(&mut self) {
            if self.terminal() {
                return;
            }
            let mut st: libc::c_int = 0;
            let r = loop {
                let r = unsafe { libc::waitpid(self.pid, &mut st, libc::WNOHANG) };
                if r < 0 && errno() == libc::EINTR {
                    continue;
                }
                break r;
            };
            if r == self.pid {
                self.status = Some(st);
                self.state = State::Reaped;
                self.release_identity();
            } else if r < 0 && errno() == libc::ECHILD {
                self.state = State::Lost;
                self.release_identity();
            }
        }

        fn release_identity(&mut self) {
            close(&mut self.pidfd);
            close(&mut self.lifefd);
            close(&mut self.killfd);
        }

        /// The end asked for: a byte on the kill pipe and its close (the
        /// watchdog exits at once); then, after `wake_ms` with no exit seen,
        /// SIGKILL while the child is ours and running.
        pub(super) fn kill(&mut self, wake_ms: i32) {
            if self.terminal() {
                return;
            }
            if self.killfd >= 0 {
                write_without_sigpipe(self.killfd, b"k");
                close(&mut self.killfd);
            }
            self.observe(wake_ms);
            if !self.terminal() {
                self.try_wait();
            }
            if !self.terminal() {
                self.signal_kill();
            }
        }

        /// SIGKILL is allowed while the child is ours and unreaped: running,
        /// or past its life pipe's EOF by a whole slice with our wait still
        /// not seeing its exit (a child that closed fd 4 itself: still ours,
        /// as our WNOHANG wait just showed).
        fn may_signal(&self) -> bool {
            self.state == State::Running || (self.state == State::Exited && self.exited_waits >= 1)
        }

        pub(super) fn signal_kill(&mut self) {
            if !self.may_signal() {
                return;
            }
            #[cfg(target_os = "linux")]
            if self.pidfd >= 0 {
                unsafe { libc::syscall(libc::SYS_pidfd_send_signal, self.pidfd, libc::SIGKILL, std::ptr::null::<libc::c_void>(), 0) };
                self.signals += 1;
                return;
            }
            // (by pid: safe only under the exclusive-reaper contract; never
            // once Reaped or Lost, which `terminal` excludes above)
            unsafe { libc::kill(self.pid, libc::SIGKILL) };
            self.signals += 1;
        }

        pub(super) fn close_io(&mut self) {
            close(&mut self.wfd);
            close(&mut self.rfd);
        }
    }

    impl Drop for Proc {
        fn drop(&mut self) {
            // (a handle collected with its child unreaped: ended and reaped
            // here, so nothing is left behind)
            self.close_io();
            if !self.terminal() {
                self.kill(25);
                while !self.terminal() {
                    self.observe(25);
                    self.try_wait();
                    if !self.terminal() {
                        self.signal_kill();
                    }
                }
            }
            self.release_identity();
        }
    }

    /// A byte written to a pipe whose reader may be gone, without SIGPIPE
    /// reaching the process (an application may have restored its default
    /// action): SIGPIPE blocked in this thread for the write, and the one
    /// the write raised, if any, consumed before the mask is restored.
    fn write_without_sigpipe(fd: i32, b: &[u8]) {
        unsafe {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGPIPE);
            let mut old: libc::sigset_t = std::mem::zeroed();
            libc::pthread_sigmask(libc::SIG_BLOCK, &set, &mut old);
            let mut pending: libc::sigset_t = std::mem::zeroed();
            libc::sigpending(&mut pending);
            let already = libc::sigismember(&pending, libc::SIGPIPE) == 1;
            let r = libc::write(fd, b.as_ptr() as *const libc::c_void, b.len());
            if r < 0 && errno() == libc::EPIPE && !already {
                libc::sigpending(&mut pending);
                if libc::sigismember(&pending, libc::SIGPIPE) == 1 {
                    let mut sig: libc::c_int = 0;
                    libc::sigwait(&set, &mut sig);
                }
            }
            libc::pthread_sigmask(libc::SIG_SETMASK, &old, std::ptr::null_mut());
        }
    }

    // ---------------------------------------------------------------- spawning

    pub(super) struct Spec {
        path: CString,
        argv: Vec<CString>,
        envp: Vec<CString>,
        err_fd: i32,
        fail_after: Option<u32>,
    }

    fn cstr(s: &str) -> PyResult<CString> {
        CString::new(s).map_err(|_| PyOSError::new_err("an argument with a NUL byte"))
    }

    impl Spec {
        pub(super) fn new(path: &str, argv: &[String], env: &[(String, String)], err_fd: i32, fail_after: Option<u32>) -> PyResult<Self> {
            let envp = env.iter().map(|(k, v)| cstr(&format!("{}={}", k, v))).collect::<PyResult<_>>()?;
            Ok(Spec { path: cstr(path)?, argv: argv.iter().map(|a| cstr(a)).collect::<PyResult<_>>()?, envp, err_fd, fail_after })
        }
    }

    /// Test stages past the pipes (`fail_after`, tests only): 10 the
    /// pidfd_open failing, 11 a fault after the creation, 12 waitid(P_PIDFD)
    /// unsupported, 13 the child reaped by "someone else" before pidfd_open,
    /// 14 the file actions' initialisation failing, 15 the attributes',
    /// 16 waitid(P_PIDFD) answering ECHILD, 17 waitid interrupted once (EINTR).
    const T_FA_INIT: u32 = 14;
    const T_AT_INIT: u32 = 15;
    #[cfg(target_os = "linux")]
    const T_WAITID_ECHILD: u32 = 16;
    #[cfg(target_os = "linux")]
    const T_WAITID_EINTR: u32 = 17;
    #[cfg(target_os = "linux")]
    const T_NO_PIDFD: u32 = 10;
    const T_FAULT_AFTER: u32 = 11;
    #[cfg(target_os = "linux")]
    const T_NO_P_PIDFD: u32 = 12;
    #[cfg(target_os = "linux")]
    const T_FOREIGN_REAP: u32 = 13;

    /// Linux: a pidfd for our child `pid`, opened right after its creation,
    /// while it is ours and unreaped (#157 PIDFD note r2, option B; astra2's
    /// and daybreak2's CLEAR).  **Identity here is conditional (plan T4's
    /// I-2), not creation-atomic:** under the reaper contract (no SIG_IGN or
    /// SA_NOCLDWAIT for SIGCHLD, nobody else reaping our children) the pid
    /// stays ours until our own wait, even if the child has already exited,
    /// so the pidfd names our child.  A violation is detected only where it
    /// is observable: waitid(P_PIDFD, WNOHANG|WNOWAIT) failing with ECHILD
    /// (a process that isn't our child, or one already reaped) makes the
    /// handle Lost, and that identity is never signalled or waited on.  A
    /// recycled pid that is another child of this process passes the check,
    /// and a foreign reap after it isn't seen: both are outside the
    /// contract, and nothing is promised for them.
    /// Returns (the pidfd or -1, lost).
    #[cfg(target_os = "linux")]
    fn own_pidfd(pid: libc::pid_t, test: Option<u32>) -> (i32, bool) {
        if test == Some(T_FOREIGN_REAP) {
            // (the negative control: reaped here as an outside reaper would)
            let mut st = 0;
            unsafe { libc::waitpid(pid, &mut st, 0) };
        }
        let fd = if test == Some(T_NO_PIDFD) { -1 } else { unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) as i32 } };
        if fd < 0 {
            // (no pidfd: ENOSYS before 5.3, EMFILE, seccomp, or the pid gone
            // (ESRCH: a foreign reap).  The numeric pid stays the obligation,
            // under I-2: our own wait decides, and ECHILD there is Lost)
            return (-1, false);
        }
        let mut interrupted = false;
        loop {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let fake = match test {
                Some(T_NO_P_PIDFD) => Some(libc::EINVAL),
                Some(T_WAITID_ECHILD) => Some(libc::ECHILD),
                Some(T_WAITID_EINTR) if !interrupted => {
                    interrupted = true;
                    Some(libc::EINTR)
                }
                _ => None,
            };
            let r = if let Some(e) = fake {
                unsafe { *libc::__errno_location() = e };
                -1
            } else {
                unsafe { libc::waitid(libc::P_PIDFD, fd as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) }
            };
            if r == 0 {
                // (si_pid 0: alive; else exited and waiting for OUR reap
                // (WNOWAIT): ours either way)
                return (fd, false);
            }
            match errno() {
                libc::EINTR => continue,
                libc::ECHILD => {
                    // (not our child: Lost.  The pidfd closed, nothing sent)
                    unsafe { libc::close(fd) };
                    return (-1, true);
                }
                // (EINVAL: waitid has no P_PIDFD before 5.4.  The pidfd is
                // kept for poll and pidfd_send_signal; waits go by pid)
                _ => return (fd, false),
            }
        }
    }

    /// The creation itself (no lock held): the four pipes; safe duplicates of
    /// the five descriptors the child gets; the file actions; an empty signal
    /// mask; glibc's posix_spawn (which handles its internal signals,
    /// cancellation and stack itself, and creates no pidfd: nothing of it can
    /// leak); then, on Linux, a pidfd of the child (own_pidfd).  On any error
    /// before the process exists every descriptor made is closed; after it
    /// exists, the Proc owns it, and an error drops the Proc, whose Drop
    /// ends and reaps it before this returns.
    pub(super) fn create(spec: &Spec) -> Result<Proc, (i32, String)> {
        let mut made: Vec<i32> = Vec::new();
        let close_all = |v: &mut Vec<i32>| {
            for fd in v.drain(..) {
                unsafe { libc::close(fd) };
            }
        };
        let fail = |made: &mut Vec<i32>, e: i32, what: &str| {
            for fd in made.drain(..) {
                unsafe { libc::close(fd) };
            }
            Err((e, format!("{} (errno {})", what, e)))
        };
        if let Some(m) = sigchld_refusal() {
            return Err((0, m));
        }
        let mut pipes = [(-1, -1); 4];
        for (i, slot) in pipes.iter_mut().enumerate() {
            if spec.fail_after == Some(i as u32) {
                return fail(&mut made, libc::EMFILE, "a pipe for the PNG engine's process (test fault)");
            }
            match pipe_cloexec() {
                Ok(p) => {
                    made.push(p.0);
                    made.push(p.1);
                    *slot = p;
                }
                Err(e) => return fail(&mut made, e, "a pipe for the PNG engine's process"),
            }
        }
        let (req, rep, kil, life) = (pipes[0], pipes[1], pipes[2], pipes[3]);
        // (every source duplicated above the five targets first, close-on-exec,
        // before any action can overwrite a target: a source that is itself
        // 0..4 (a parent whose standard descriptors were closed) can't be
        // clobbered by an earlier dup2.  Each duplicate closed once, below)
        let mut dups: Vec<i32> = Vec::new();
        for from in [req.0, rep.1, spec.err_fd, kil.0, life.1] {
            let d = unsafe { libc::fcntl(from, libc::F_DUPFD_CLOEXEC, 5) };
            if d < 0 {
                let e = errno();
                close_all(&mut dups);
                return fail(&mut made, e, "a descriptor for the PNG engine's process");
            }
            dups.push(d);
        }
        // (each initialisation checked, its own result kept (they return an
        // errno value; on macOS they allocate, and ENOMEM is theirs): an
        // object is used and destroyed only if its initialisation succeeded,
        // and nothing is spawned after a failure (astra2's SPAWN-INIT))
        let mut fa: libc::posix_spawn_file_actions_t = unsafe { std::mem::zeroed() };
        let mut at: libc::posix_spawnattr_t = unsafe { std::mem::zeroed() };
        let r = if spec.fail_after == Some(T_FA_INIT) { libc::ENOMEM } else { unsafe { libc::posix_spawn_file_actions_init(&mut fa) } };
        if r != 0 {
            close_all(&mut dups);
            return fail(&mut made, r, "the PNG engine's process: its file actions");
        }
        let r = if spec.fail_after == Some(T_AT_INIT) { libc::ENOMEM } else { unsafe { libc::posix_spawnattr_init(&mut at) } };
        if r != 0 {
            unsafe { libc::posix_spawn_file_actions_destroy(&mut fa) };
            close_all(&mut dups);
            return fail(&mut made, r, "the PNG engine's process: its attributes");
        }
        let mut r = 0;
        for (to, from) in dups.iter().enumerate() {
            if r == 0 {
                r = unsafe { libc::posix_spawn_file_actions_adddup2(&mut fa, *from, to as i32) };
            }
        }
        if r == 0 {
            let mut empty: libc::sigset_t = unsafe { std::mem::zeroed() };
            unsafe { libc::sigemptyset(&mut empty) };
            r = unsafe { libc::posix_spawnattr_setsigmask(&mut at, &empty) };
            if r == 0 {
                r = unsafe { libc::posix_spawnattr_setflags(&mut at, libc::POSIX_SPAWN_SETSIGMASK as libc::c_short) };
            }
        }
        let argv: Vec<*mut libc::c_char> = spec.argv.iter().map(|a| a.as_ptr() as *mut libc::c_char).chain(std::iter::once(std::ptr::null_mut())).collect();
        let envp: Vec<*mut libc::c_char> = spec.envp.iter().map(|a| a.as_ptr() as *mut libc::c_char).chain(std::iter::once(std::ptr::null_mut())).collect();
        let mut pid: libc::pid_t = -1;
        if r == 0 {
            r = unsafe { libc::posix_spawn(&mut pid, spec.path.as_ptr(), &fa, &at, argv.as_ptr(), envp.as_ptr()) };
        }
        unsafe {
            libc::posix_spawn_file_actions_destroy(&mut fa);
            libc::posix_spawnattr_destroy(&mut at);
        }
        close_all(&mut dups);
        if r != 0 {
            // (no child exists: glibc reaped its own failed one)
            return fail(&mut made, r, "starting the PNG engine's process");
        }
        // (the child's ends closed in the parent; the process is the Proc's from here)
        for fd in [req.0, rep.1, kil.0, life.1] {
            unsafe { libc::close(fd) };
        }
        made.clear();
        #[allow(unused_mut)]
        let mut p = Proc { pid, pidfd: -1, wfd: req.1, rfd: rep.0, killfd: kil.1, lifefd: life.0, state: State::Running, status: None, signals: 0, exited_waits: 0 };
        #[cfg(target_os = "linux")]
        {
            let (fd, lost) = own_pidfd(pid, spec.fail_after);
            p.pidfd = fd;
            if lost {
                p.state = State::Lost;
                p.release_identity();
            }
        }
        if spec.fail_after == Some(T_FAULT_AFTER) {
            // (an error after the creation: the Proc dropped here ends and
            // reaps the child before the error is returned)
            drop(p);
            return Err((libc::EIO, "after starting the PNG engine's process (test fault)".into()));
        }
        Ok(p)
    }
}

#[cfg(windows)]
#[allow(non_snake_case, clippy::upper_case_acronyms)]
mod sys {
    use pyo3::exceptions::PyOSError;
    use pyo3::prelude::*;
    use std::ffi::c_void;

    type HANDLE = isize;

    #[repr(C)]
    struct SecurityAttributes {
        n_length: u32,
        descriptor: *mut c_void,
        inherit: i32,
    }

    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_count_chars: u32,
        y_count_chars: u32,
        fill_attribute: u32,
        flags: u32,
        show_window: u16,
        cb_reserved2: u16,
        reserved2: *mut u8,
        std_input: HANDLE,
        std_output: HANDLE,
        std_error: HANDLE,
    }

    #[repr(C)]
    struct StartupInfoExW {
        si: StartupInfoW,
        attributes: *mut c_void,
    }

    #[repr(C)]
    struct ProcessInformation {
        process: HANDLE,
        thread: HANDLE,
        pid: u32,
        tid: u32,
    }

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operations: u64,
        write_operations: u64,
        other_operations: u64,
        read_transfer: u64,
        write_transfer: u64,
        other_transfer: u64,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreatePipe(read: *mut HANDLE, write: *mut HANDLE, sa: *const SecurityAttributes, size: u32) -> i32;
        fn SetHandleInformation(h: HANDLE, mask: u32, flags: u32) -> i32;
        fn DuplicateHandle(source_process: HANDLE, source: HANDLE, target_process: HANDLE, target: *mut HANDLE, access: u32, inherit: i32, options: u32) -> i32;
        fn GetCurrentProcess() -> HANDLE;
        fn CloseHandle(h: HANDLE) -> i32;
        fn CreateJobObjectW(sa: *const SecurityAttributes, name: *const u16) -> HANDLE;
        fn SetInformationJobObject(job: HANDLE, class: i32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: HANDLE, process: HANDLE) -> i32;
        fn InitializeProcThreadAttributeList(list: *mut c_void, count: u32, flags: u32, size: *mut usize) -> i32;
        fn UpdateProcThreadAttribute(list: *mut c_void, flags: u32, attribute: usize, value: *const c_void, size: usize, previous: *mut c_void, returned: *mut usize) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn CreateProcessW(
            application: *const u16,
            command_line: *mut u16,
            process_attributes: *const SecurityAttributes,
            thread_attributes: *const SecurityAttributes,
            inherit_handles: i32,
            flags: u32,
            environment: *const c_void,
            directory: *const u16,
            startup: *const StartupInfoW,
            info: *mut ProcessInformation,
        ) -> i32;
        fn ResumeThread(thread: HANDLE) -> u32;
        fn TerminateProcess(process: HANDLE, code: u32) -> i32;
        fn WaitForSingleObject(h: HANDLE, ms: u32) -> u32;
        fn GetExitCodeProcess(process: HANDLE, code: *mut u32) -> i32;
        fn GetLastError() -> u32;
    }

    // (the C runtime's descriptors, which Python's os.read/os.write use)
    extern "C" {
        fn _open_osfhandle(h: isize, flags: i32) -> i32;
        fn _get_osfhandle(fd: i32) -> isize;
        fn _close(fd: i32) -> i32;
    }

    const HANDLE_FLAG_INHERIT: u32 = 1;
    const DUPLICATE_SAME_ACCESS: u32 = 2;
    const STARTF_USESTDHANDLES: u32 = 0x100;
    const CREATE_SUSPENDED: u32 = 0x4;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x400;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x80000;
    const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x20002;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const WAIT_OBJECT_0: u32 = 0;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const O_RDONLY: i32 = 0;
    const O_WRONLY: i32 = 1;
    const O_NOINHERIT: i32 = 0x80;
    const O_BINARY: i32 = 0x8000;
    const ERROR_INVALID_HANDLE: i32 = 6;
    const ERROR_TOO_MANY_OPEN_FILES: i32 = 4;
    const ERROR_ACCESS_DENIED: i32 = 5;
    /// TerminateProcess's exit code, as subprocess.Popen.kill gives it.
    const KILLED: u32 = 1;

    fn last_error() -> i32 {
        unsafe { GetLastError() as i32 }
    }

    fn close_handle(h: &mut HANDLE) {
        if *h != 0 {
            unsafe { CloseHandle(*h) };
            *h = 0;
        }
    }

    fn close_fd(fd: &mut i32) {
        if *fd >= 0 {
            unsafe { _close(*fd) };
            *fd = -1;
        }
    }

    /// No reaping on Windows: nothing to refuse (r6 S2.2).
    pub(super) fn sigchld_refusal() -> Option<String> {
        None
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    pub(super) enum State {
        Running,
        Exited,
        Reaped,
        #[allow(dead_code)]
        Lost,
    }

    /// The process (its handle and its job's) and the parent's ends of its
    /// pipes, as C runtime descriptors.
    pub(super) struct Proc {
        pid: u32,
        handle: HANDLE,
        job: HANDLE,
        pub(super) wfd: i32,
        pub(super) rfd: i32,
        pub(super) state: State,
        status: Option<i32>,
        pub(super) signals: u64,
    }

    impl Proc {
        pub(super) fn pid(&self) -> i64 {
            self.pid as i64
        }

        pub(super) fn has_pidfd(&self) -> bool {
            false
        }

        /// The exit code (subprocess's returncode), once read.
        pub(super) fn code(&self) -> Option<i32> {
            self.status
        }

        pub(super) fn terminal(&self) -> bool {
            matches!(self.state, State::Reaped | State::Lost)
        }

        /// The handle signalled: Running -> Exited.
        pub(super) fn observe(&mut self, timeout_ms: i32) {
            if self.state != State::Running || self.handle == 0 {
                return;
            }
            if unsafe { WaitForSingleObject(self.handle, timeout_ms.max(0) as u32) } == WAIT_OBJECT_0 {
                self.state = State::Exited;
            }
        }

        /// Exited: its code read and the identity released (Reaped), in one
        /// step.
        pub(super) fn try_wait(&mut self) {
            if self.terminal() {
                return;
            }
            if self.state == State::Running {
                self.observe(0);
            }
            if self.state == State::Exited {
                let mut code: u32 = 0;
                self.status = if unsafe { GetExitCodeProcess(self.handle, &mut code) } != 0 { Some(code as i32) } else { None };
                self.state = State::Reaped;
                self.release_identity();
            }
        }

        fn release_identity(&mut self) {
            close_handle(&mut self.handle);
            // (the job's last handle: anything the child started ends with it)
            close_handle(&mut self.job);
        }

        /// The end: TerminateProcess on the handle, then up to `wake_ms` for
        /// it to show.
        pub(super) fn kill(&mut self, wake_ms: i32) {
            if self.terminal() {
                return;
            }
            self.signal_kill();
            self.observe(wake_ms);
            self.try_wait();
        }

        pub(super) fn signal_kill(&mut self) {
            if self.state != State::Running || self.handle == 0 {
                return;
            }
            unsafe { TerminateProcess(self.handle, KILLED) };
            self.signals += 1;
        }

        pub(super) fn close_io(&mut self) {
            close_fd(&mut self.wfd);
            close_fd(&mut self.rfd);
        }
    }

    impl Drop for Proc {
        fn drop(&mut self) {
            self.close_io();
            if !self.terminal() {
                self.kill(25);
                while !self.terminal() {
                    self.observe(25);
                    self.try_wait();
                    if !self.terminal() {
                        self.signal_kill();
                    }
                }
            }
            self.release_identity();
        }
    }

    // ---------------------------------------------------------------- spawning

    pub(super) struct Spec {
        application: Vec<u16>,
        command_line: Vec<u16>,
        environment: Vec<u16>,
        err_fd: i32,
        fail_after: Option<u32>,
    }

    fn wide(s: &str) -> PyResult<Vec<u16>> {
        if s.contains('\0') {
            return Err(PyOSError::new_err("an argument with a NUL byte"));
        }
        Ok(s.encode_utf16().collect())
    }

    /// subprocess.list2cmdline's quoting (the C runtime's argv parsing).
    fn quote(arg: &str, out: &mut String) {
        let needs = arg.is_empty() || arg.contains(' ') || arg.contains('\t');
        if needs {
            out.push('"');
        }
        let mut backslashes = 0;
        for c in arg.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                    out.push('"');
                    backslashes = 0;
                }
                _ => {
                    out.extend(std::iter::repeat('\\').take(backslashes));
                    backslashes = 0;
                    out.push(c);
                }
            }
        }
        out.extend(std::iter::repeat('\\').take(backslashes));
        if needs {
            out.extend(std::iter::repeat('\\').take(backslashes));
            out.push('"');
        }
    }

    impl Spec {
        pub(super) fn new(path: &str, argv: &[String], env: &[(String, String)], err_fd: i32, fail_after: Option<u32>) -> PyResult<Self> {
            let mut application = wide(path)?;
            application.push(0);
            let mut line = String::new();
            for (i, a) in argv.iter().enumerate() {
                if i > 0 {
                    line.push(' ');
                }
                quote(a, &mut line);
            }
            let mut command_line = wide(&line)?;
            command_line.push(0);
            let mut environment = Vec::new();
            for (k, v) in env {
                // (a leading '=' is allowed: Windows' per-drive "=C:" names)
                if k.is_empty() || k.chars().skip(1).any(|c| c == '=') {
                    return Err(PyOSError::new_err("an environment name that is empty or holds '='"));
                }
                environment.extend(wide(&format!("{}={}", k, v))?);
                environment.push(0);
            }
            if environment.is_empty() {
                environment.push(0);
            }
            environment.push(0);
            Ok(Spec { application, command_line, environment, err_fd, fail_after })
        }
    }

    fn fail<T>(made: &mut Vec<HANDLE>, e: i32, what: &str) -> Result<T, (i32, String)> {
        for mut h in made.drain(..) {
            close_handle(&mut h);
        }
        Err((e, format!("{} (error {})", what, e)))
    }

    /// The creation itself (no lock held), r5 R3.4: two pipes, the job, the
    /// process suspended with only its three standard handles inherited,
    /// assigned, resumed.  On any error every handle made is closed, and a
    /// process already created is terminated and waited for first.
    pub(super) fn create(spec: &Spec) -> Result<Proc, (i32, String)> {
        let mut made: Vec<HANDLE> = Vec::new();
        let sa = SecurityAttributes { n_length: std::mem::size_of::<SecurityAttributes>() as u32, descriptor: std::ptr::null_mut(), inherit: 0 };
        let mut pipes = [(0isize, 0isize); 2];
        for (i, slot) in pipes.iter_mut().enumerate() {
            if spec.fail_after == Some(i as u32) {
                return fail(&mut made, ERROR_TOO_MANY_OPEN_FILES, "a pipe for the PNG engine's process (test fault)");
            }
            let (mut r, mut w) = (0, 0);
            if unsafe { CreatePipe(&mut r, &mut w, &sa, 0) } == 0 {
                return fail(&mut made, last_error(), "a pipe for the PNG engine's process");
            }
            made.push(r);
            made.push(w);
            *slot = (r, w);
        }
        // (the child reads req.0 and writes rep.1; the parent keeps req.1 and rep.0)
        let (req, rep) = (pipes[0], pipes[1]);
        let eh = unsafe { _get_osfhandle(spec.err_fd) };
        if eh == -1 || eh == -2 {
            return fail(&mut made, ERROR_INVALID_HANDLE, "the PNG engine's standard error file");
        }
        let cur = unsafe { GetCurrentProcess() };
        let mut err: HANDLE = 0;
        if unsafe { DuplicateHandle(cur, eh, cur, &mut err, 0, 1, DUPLICATE_SAME_ACCESS) } == 0 {
            return fail(&mut made, last_error(), "the PNG engine's standard error file");
        }
        made.push(err);
        for h in [req.0, rep.1] {
            if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
                return fail(&mut made, last_error(), "a pipe for the PNG engine's process");
            }
        }
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job == 0 {
            return fail(&mut made, last_error(), "the PNG engine process's job object");
        }
        made.push(job);
        let mut limits: ExtendedLimitInformation = unsafe { std::mem::zeroed() };
        limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe { SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, &limits as *const _ as *const c_void, std::mem::size_of::<ExtendedLimitInformation>() as u32) } == 0 {
            return fail(&mut made, last_error(), "the PNG engine process's job object");
        }
        // (only these three are inherited)
        let inherit: [HANDLE; 3] = [req.0, rep.1, err];
        let mut size: usize = 0;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
        let mut list_buf: Vec<u64> = vec![0; size / 8 + 1];
        let list = list_buf.as_mut_ptr() as *mut c_void;
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
            return fail(&mut made, last_error(), "starting the PNG engine's process");
        }
        if unsafe { UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit.as_ptr() as *const c_void, std::mem::size_of_val(&inherit), std::ptr::null_mut(), std::ptr::null_mut()) } == 0 {
            let e = last_error();
            unsafe { DeleteProcThreadAttributeList(list) };
            return fail(&mut made, e, "starting the PNG engine's process");
        }
        let mut si: StartupInfoExW = unsafe { std::mem::zeroed() };
        si.si.cb = std::mem::size_of::<StartupInfoExW>() as u32;
        si.si.flags = STARTF_USESTDHANDLES;
        si.si.std_input = req.0;
        si.si.std_output = rep.1;
        si.si.std_error = err;
        si.attributes = list;
        let mut pi: ProcessInformation = unsafe { std::mem::zeroed() };
        let mut command_line = spec.command_line.clone();
        let ok = unsafe {
            CreateProcessW(
                spec.application.as_ptr(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                spec.environment.as_ptr() as *const c_void,
                std::ptr::null(),
                &si.si,
                &mut pi,
            )
        };
        let e = last_error();
        unsafe { DeleteProcThreadAttributeList(list) };
        drop(list_buf);
        if ok == 0 {
            return fail(&mut made, e, "starting the PNG engine's process");
        }
        // (the child's ends closed in the parent)
        for mut h in [req.0, rep.1, err] {
            made.retain(|&x| x != h);
            close_handle(&mut h);
        }
        // (from here the process exists, suspended: any failure ends it, waits for it and closes its handles)
        let end = |made: &mut Vec<HANDLE>, e: i32, what: &str| -> Result<Proc, (i32, String)> {
            unsafe {
                TerminateProcess(pi.process, KILLED);
                WaitForSingleObject(pi.process, INFINITE);
                CloseHandle(pi.thread);
                CloseHandle(pi.process);
            }
            fail(made, e, what)
        };
        if spec.fail_after == Some(2) {
            return end(&mut made, ERROR_ACCESS_DENIED, "assigning the PNG engine's process to its job (test fault)");
        }
        if unsafe { AssignProcessToJobObject(job, pi.process) } == 0 {
            return end(&mut made, last_error(), "assigning the PNG engine's process to its job");
        }
        if spec.fail_after == Some(3) {
            return end(&mut made, ERROR_ACCESS_DENIED, "resuming the PNG engine's process (test fault)");
        }
        if unsafe { ResumeThread(pi.thread) } == u32::MAX {
            return end(&mut made, last_error(), "resuming the PNG engine's process");
        }
        unsafe { CloseHandle(pi.thread) };
        // (the parent's ends as C runtime descriptors, each owning its handle from then on)
        let wfd = unsafe { _open_osfhandle(req.1, O_WRONLY | O_BINARY | O_NOINHERIT) };
        if wfd < 0 {
            return end(&mut made, ERROR_TOO_MANY_OPEN_FILES, "a descriptor for the PNG engine's pipe");
        }
        made.retain(|&x| x != req.1);
        let rfd = unsafe { _open_osfhandle(rep.0, O_RDONLY | O_BINARY | O_NOINHERIT) };
        if rfd < 0 {
            unsafe { _close(wfd) };
            return end(&mut made, ERROR_TOO_MANY_OPEN_FILES, "a descriptor for the PNG engine's pipe");
        }
        Ok(Proc { pid: pi.pid, handle: pi.process, job, wfd, rfd, state: State::Running, status: None, signals: 0 })
    }
}

#[cfg(any(unix, windows))]
mod api {
    use super::sys::{create, sigchld_refusal, Proc, Spec, State};
    use pyo3::exceptions::{PyOSError, PyRuntimeError};
    use pyo3::prelude::*;
    use pyo3::types::PyDict;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Condvar, Mutex};

    #[pyfunction]
    pub fn sigchld_check() -> PyResult<()> {
        match sigchld_refusal() {
            Some(m) => Err(PyRuntimeError::new_err(m)),
            None => Ok(()),
        }
    }

    static THREAD_IDS: AtomicU64 = AtomicU64::new(1);
    thread_local! {
        static THREAD_ID: u64 = THREAD_IDS.fetch_add(1, Ordering::Relaxed);
    }
    fn this_thread() -> u64 {
        THREAD_ID.with(|t| *t)
    }

    /// The native handle (see the module comment).
    #[pyclass(module = "sagebrush._native.raster")]
    pub struct Child {
        p: Mutex<Proc>,
        busy: AtomicU64,
    }

    /// The method's thread marked as inside the handle; cleared on any exit
    /// (only by the thread that marked it).
    struct Busy<'a>(Option<&'a AtomicU64>);
    impl Drop for Busy<'_> {
        fn drop(&mut self) {
            if let Some(b) = self.0 {
                b.store(0, Ordering::Release);
            }
        }
    }

    impl Child {
        fn new_from(p: Proc) -> Self {
            Child { p: Mutex::new(p), busy: AtomicU64::new(0) }
        }

        /// A call from a signal handler on the thread already inside one of
        /// this handle's methods is refused ("busy"), never a deadlock.
        fn enter(&self) -> PyResult<Busy<'_>> {
            let me = this_thread();
            if self.busy.load(Ordering::Acquire) == me {
                return Err(PyRuntimeError::new_err("the PNG engine's process handle is busy in this thread (a signal handler's call?)"));
            }
            // (another thread inside: this one isn't marked, and never clears
            // that thread's mark; the lock alone serialises the two)
            match self.busy.compare_exchange(0, me, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => Ok(Busy(Some(&self.busy))),
                Err(_) => Ok(Busy(None)),
            }
        }

        /// f(&mut Proc) with the handle's lock, taken and held only without
        /// the GIL (a holder never needs the GIL, so no deadlock).
        fn with<T: Send>(&self, py: Python<'_>, f: impl FnOnce(&mut Proc) -> T + Send) -> T {
            py.detach(|| {
                let mut g = self.p.lock().unwrap_or_else(|e| e.into_inner());
                f(&mut g)
            })
        }
    }

    fn state_name(s: State) -> &'static str {
        match s {
            State::Running => "running",
            State::Exited => "exited",
            State::Reaped => "reaped",
            State::Lost => "lost",
        }
    }

    #[pymethods]
    impl Child {
        #[getter]
        fn pid(&self, py: Python<'_>) -> i64 {
            self.with(py, |p| p.pid())
        }
        #[getter]
        fn wfd(&self, py: Python<'_>) -> i32 {
            self.with(py, |p| p.wfd)
        }
        #[getter]
        fn rfd(&self, py: Python<'_>) -> i32 {
            self.with(py, |p| p.rfd)
        }
        #[getter]
        fn state(&self, py: Python<'_>) -> &'static str {
            state_name(self.with(py, |p| p.state))
        }
        #[getter]
        fn signals_sent(&self, py: Python<'_>) -> u64 {
            self.with(py, |p| p.signals)
        }
        #[getter]
        fn has_pidfd(&self, py: Python<'_>) -> bool {
            self.with(py, |p| p.has_pidfd())
        }
        /// The exit status as os.waitstatus_to_exitcode gives it (Windows:
        /// the exit code), once reaped; None before, or when Lost.
        #[getter]
        fn returncode(&self, py: Python<'_>) -> Option<i32> {
            self.with(py, |p| p.code())
        }

        /// Whether the process has ended (reaped here, or lost), after one
        /// non-blocking look: the old `_exited(child)`.
        fn poll_exit(&self, py: Python<'_>) -> PyResult<bool> {
            let _b = self.enter()?;
            Ok(self.with(py, |p| {
                p.observe(0);
                // (an exited child is reaped here, and so is one whose life
                // pipe is still open but that has exited: its zombie keeps
                // the pid ours)
                p.try_wait();
                p.terminal()
            }))
        }

        /// The end, then the reap: wake seconds per slice, signals checked
        /// between slices (a Stop leaves the state as it is: a retry is safe).
        /// Returns the exit code (None if lost).
        #[pyo3(signature = (wake=0.025))]
        fn kill_and_reap(&self, py: Python<'_>, wake: f64) -> PyResult<Option<i32>> {
            let _b = self.enter()?;
            let ms = (wake * 1000.0).max(1.0) as i32;
            self.with(py, |p| p.kill(ms));
            loop {
                let done = self.with(py, |p| {
                    p.observe(ms);
                    p.try_wait();
                    if !p.terminal() {
                        p.signal_kill();
                    }
                    p.terminal()
                });
                // (after every slice, the last too: a Stop raised after the
                // reap leaves Reaped, and a retry returns the code)
                py.check_signals()?;
                if done {
                    break;
                }
            }
            Ok(self.with(py, |p| p.code()))
        }

        /// The exit waited for, without ending it (a child whose reply ended:
        /// its own status, not a kill's), in slices of `wake` seconds with
        /// signals checked between them.  Returns the exit code (None if
        /// lost).
        #[pyo3(signature = (wake=0.025))]
        fn wait(&self, py: Python<'_>, wake: f64) -> PyResult<Option<i32>> {
            let _b = self.enter()?;
            let ms = (wake * 1000.0).max(1.0) as i32;
            loop {
                let done = self.with(py, |p| {
                    p.observe(ms);
                    p.try_wait();
                    p.terminal()
                });
                if done {
                    break;
                }
                py.check_signals()?;
            }
            Ok(self.with(py, |p| p.code()))
        }

        /// The parent's request/reply ends closed (each set to -1 with its
        /// close).  The kill pipe stays: closing it ends the child.
        fn close_io(&self, py: Python<'_>) -> PyResult<()> {
            let _b = self.enter()?;
            self.with(py, |p| p.close_io());
            Ok(())
        }
    }

    // ---------------------------------------------------------------- spawning

    #[derive(Clone, Copy, PartialEq)]
    enum TaskState {
        Queued,
        Running,
        Done,
        Cancelled,
        Taken,
    }

    struct TaskInner {
        state: TaskState,
        spec: Option<Spec>,
        out: Option<Result<Proc, (i32, String)>>,
        // (run() has returned: whatever it made is kept or cleaned)
        finished: bool,
    }

    /// A child's creation on the persistent spawner thread (r5 R3): the
    /// state and the result are written only by these methods.
    #[pyclass(module = "sagebrush._native.raster")]
    pub struct SpawnTask {
        m: Mutex<TaskInner>,
        cv: Condvar,
    }

    #[pymethods]
    impl SpawnTask {
        /// The creation's spec: the program's path, its argv, its environment
        /// (a dict), the stderr file's descriptor; `fail_after` (tests only):
        /// fail at that stage (POSIX: before making that pipe; Windows: 0-1
        /// before a pipe, 2 at the job assignment, 3 at the resume).
        #[new]
        #[pyo3(signature = (path, argv, env, err_fd, fail_after=None))]
        fn new(path: &str, argv: Vec<String>, env: &Bound<'_, PyDict>, err_fd: i32, fail_after: Option<u32>) -> PyResult<Self> {
            let mut pairs = Vec::new();
            for (k, v) in env.iter() {
                pairs.push((k.extract::<String>()?, v.extract::<String>()?));
            }
            let spec = Spec::new(path, &argv, &pairs, err_fd, fail_after)?;
            Ok(SpawnTask { m: Mutex::new(TaskInner { state: TaskState::Queued, spec: Some(spec), out: None, finished: false }), cv: Condvar::new() })
        }

        /// Run on the spawner thread: the child created unless cancelled; if
        /// cancelled meanwhile, it is ended and reaped here.
        fn run(&self, py: Python<'_>) {
            py.detach(|| {
                let spec = {
                    let mut g = self.m.lock().unwrap_or_else(|e| e.into_inner());
                    if g.state != TaskState::Queued {
                        return;
                    }
                    g.state = TaskState::Running;
                    g.spec.take()
                };
                let out = match spec {
                    Some(s) => create(&s),
                    None => Err((0, "no spec".into())),
                };
                let mut g = self.m.lock().unwrap_or_else(|e| e.into_inner());
                if g.state == TaskState::Cancelled {
                    // (the caller is gone: this thread ends what it made)
                    drop(out);
                } else {
                    g.out = Some(out);
                    g.state = TaskState::Done;
                }
                g.finished = true;
                drop(g);
                self.cv.notify_all();
            });
        }

        /// Whether run() has finished (or the task was cancelled).
        fn done(&self) -> bool {
            let g = self.m.lock().unwrap_or_else(|e| e.into_inner());
            matches!(g.state, TaskState::Done | TaskState::Cancelled | TaskState::Taken)
        }

        /// done(), after waiting up to `timeout` seconds for it (without the
        /// GIL; woken at once when run() finishes).
        fn wait_done(&self, py: Python<'_>, timeout: f64) -> bool {
            let d = std::time::Duration::from_secs_f64(timeout.max(0.0));
            py.detach(|| {
                let g = self.m.lock().unwrap_or_else(|e| e.into_inner());
                let fin = |g: &TaskInner| matches!(g.state, TaskState::Done | TaskState::Cancelled | TaskState::Taken);
                if fin(&g) {
                    return true;
                }
                let (g, _) = self.cv.wait_timeout_while(g, d, |g| !fin(g)).unwrap_or_else(|e| e.into_inner());
                fin(&g)
            })
        }

        /// The child moved into `ob.<name>` in one native step (or the
        /// creation's error raised as OSError, nothing left behind).
        #[pyo3(signature = (ob, name="child"))]
        fn take_into(&self, py: Python<'_>, ob: &Bound<'_, PyAny>, name: &str) -> PyResult<()> {
            let out = {
                let mut g = self.m.lock().unwrap_or_else(|e| e.into_inner());
                if g.state != TaskState::Done {
                    return Err(PyRuntimeError::new_err("the PNG engine's process isn't ready to take"));
                }
                g.state = TaskState::Taken;
                g.out.take()
            };
            match out {
                Some(Ok(p)) => {
                    // (the handle owns the process from here: if setting the
                    // attribute fails, dropping it ends and reaps the child)
                    let c = Bound::new(py, Child::new_from(p))?;
                    ob.setattr(name, c)
                }
                Some(Err((e, m))) => Err(PyOSError::new_err((e, m))),
                None => Err(PyRuntimeError::new_err("the PNG engine's process was already taken")),
            }
        }

        /// The caller ends: a queued task never runs; a running one is
        /// cleaned by the spawner thread (waited for, in slices of `wake`
        /// with signals checked); a finished, untaken child is ended and
        /// reaped here.
        #[pyo3(signature = (wake=0.025))]
        fn cancel_and_clean(&self, py: Python<'_>, wake: f64) -> PyResult<()> {
            let (out, wait) = {
                let mut g = self.m.lock().unwrap_or_else(|e| e.into_inner());
                match g.state {
                    TaskState::Queued => {
                        g.state = TaskState::Cancelled;
                        (None, false)
                    }
                    TaskState::Running => {
                        g.state = TaskState::Cancelled;
                        (None, true)
                    }
                    TaskState::Done => {
                        g.state = TaskState::Cancelled;
                        (g.out.take(), false)
                    }
                    TaskState::Cancelled => (None, !g.finished && g.spec.is_none()),
                    TaskState::Taken => (None, false),
                }
            };
            // (an untaken child: ended and reaped by its drop, here)
            py.detach(|| drop(out));
            // (a running creation: the spawner thread ends what it makes; the
            // call doesn't end before that, in slices with signals checked)
            if wait {
                let ms = std::time::Duration::from_millis((wake * 1000.0).max(1.0) as u64);
                loop {
                    let finished = py.detach(|| {
                        let g = self.m.lock().unwrap_or_else(|e| e.into_inner());
                        if g.finished {
                            return true;
                        }
                        let (g, _) = self.cv.wait_timeout(g, ms).unwrap_or_else(|e| e.into_inner());
                        g.finished
                    });
                    if finished {
                        break;
                    }
                    py.check_signals()?;
                }
            }
            Ok(())
        }
    }

    /// Up to n bytes from the start of the file at path, read and closed
    /// natively (a /proc or cgroup file: no descriptor for Python to close,
    /// so an interruption can't leave one open).
    #[pyfunction]
    pub fn read_prefix(py: Python<'_>, path: std::path::PathBuf, n: usize) -> PyResult<pyo3::Bound<'_, pyo3::types::PyBytes>> {
        let out = py.detach(|| -> std::io::Result<Vec<u8>> {
            use std::io::Read;
            let mut f = std::fs::File::open(&path)?;
            let mut buf = vec![0u8; n];
            let k = f.read(&mut buf)?;
            buf.truncate(k);
            Ok(buf)
        });
        match out {
            Ok(b) => Ok(pyo3::types::PyBytes::new(py, &b)),
            Err(e) => Err(PyOSError::new_err((e.raw_os_error().unwrap_or(0), e.to_string()))),
        }
    }

    pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
        m.add_function(wrap_pyfunction!(read_prefix, m)?)?;
        m.add_class::<Child>()?;
        m.add_class::<SpawnTask>()?;
        m.add_function(wrap_pyfunction!(sigchld_check, m)?)?;
        Ok(())
    }
}
