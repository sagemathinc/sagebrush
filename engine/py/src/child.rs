//! The raster child's process handle and its creation (#157 simpler path:
//! r5 R2/R3, r6 S2, r7 T3/T4, r8 U4).
//!
//! A `Child` owns the process identity and the parent's ends of its pipes.
//! Every state change happens inside one of its methods, in the same native
//! step as the system call it records, so no Python bytecode (where a
//! KeyboardInterrupt can land) separates an effect from its record:
//!
//! - Running -> ExitedAwaitingReap: the life pipe reached EOF (every writer,
//!   the child alone, has exited) or the pidfd became readable;
//! - Running or ExitedAwaitingReap -> Reaped: OUR wait returned the child's
//!   status;
//! - -> Lost: our wait returned ECHILD (someone else reaped it: outside the
//!   supported contract).  Lost and Reaped are terminal: the pid is never
//!   signalled or waited on again.
//!
//! The pipes (H-1), each close-on-exec in the parent, dup2'ed into the child
//! by the spawn's file actions: request (parent writes, child fd 0), reply
//! (child fd 1, parent reads), kill (parent writes, child fd 3), life (child
//! fd 4 writes, never; the parent reads its EOF).  stderr is the caller's
//! file (fd 2).  Ending a child is a byte on the kill pipe and closing it: the
//! child's watchdog thread (raster_child.rs) exits at once; SIGKILL is only a
//! fallback, after one slice, while the life pipe shows no exit, through the
//! pidfd where there is one (identity-bound) and otherwise by pid (safe only
//! under the exclusive-reaper contract, which `sigchld_ok` checks at spawn).
//!
//! Identity (T4): with glibc's `pidfd_spawn` (found at run time) the pidfd
//! comes from the creation itself; it falls back to `posix_spawn` only when
//! `pidfd_spawn` reports ENOSYS (no child created then: H-4).

#[cfg(unix)]
pub use imp::*;

#[cfg(unix)]
mod imp {
    use pyo3::exceptions::{PyOSError, PyRuntimeError};
    use pyo3::prelude::*;
    use pyo3::types::PyDict;
    use std::ffi::CString;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Condvar, Mutex, MutexGuard};

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
                unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
            }
        }
        Ok((fds[0], fds[1]))
    }

    /// The supported reaper contract (r6 S2.1): SIGCHLD neither ignored nor
    /// SA_NOCLDWAIT.  Read only: the application's signal state is never
    /// changed.
    pub fn sigchld_refusal() -> Option<String> {
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

    #[pyfunction]
    pub fn sigchld_check() -> PyResult<()> {
        match sigchld_refusal() {
            Some(m) => Err(PyRuntimeError::new_err(m)),
            None => Ok(()),
        }
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum State {
        Running,
        Exited,
        Reaped,
        Lost,
    }

    /// The process and the parent's ends of its pipes.
    struct Proc {
        pid: libc::pid_t,
        pidfd: i32,
        wfd: i32,
        rfd: i32,
        killfd: i32,
        lifefd: i32,
        state: State,
        status: Option<i32>,
        signals: u64,
    }

    impl Proc {
        fn terminal(&self) -> bool {
            matches!(self.state, State::Reaped | State::Lost)
        }

        /// The life pipe (or the pidfd) shows the exit: Running -> Exited.
        fn observe(&mut self, timeout_ms: i32) {
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
        fn try_wait(&mut self) {
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
        fn kill(&mut self, wake_ms: i32) {
            if self.terminal() {
                return;
            }
            if self.killfd >= 0 {
                let b = [b'k'];
                unsafe { libc::write(self.killfd, b.as_ptr() as *const libc::c_void, 1) };
                close(&mut self.killfd);
            }
            self.observe(wake_ms);
            if self.state == State::Running {
                self.try_wait();
            }
            if self.state == State::Running {
                self.signal_kill();
            }
        }

        fn signal_kill(&mut self) {
            if self.state != State::Running {
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

        fn close_io(&mut self) {
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

    /// os.waitstatus_to_exitcode's value.
    fn exit_code(st: i32) -> i32 {
        if libc::WIFEXITED(st) {
            libc::WEXITSTATUS(st)
        } else if libc::WIFSIGNALED(st) {
            -libc::WTERMSIG(st)
        } else {
            st
        }
    }

    #[pymethods]
    impl Child {
        #[getter]
        fn pid(&self, py: Python<'_>) -> i64 {
            self.with(py, |p| p.pid as i64)
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
            self.with(py, |p| p.pidfd >= 0)
        }
        /// The exit status as os.waitstatus_to_exitcode gives it, once
        /// reaped; None before, or when Lost.
        #[getter]
        fn returncode(&self, py: Python<'_>) -> Option<i32> {
            self.with(py, |p| p.status.map(exit_code))
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
                    if p.state == State::Running {
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
            Ok(self.with(py, |p| p.status.map(exit_code)))
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

    struct Spec {
        path: CString,
        argv: Vec<CString>,
        envp: Vec<CString>,
        err_fd: i32,
        fail_after: Option<u32>,
    }

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

    type SpawnFn = unsafe extern "C" fn(
        *mut libc::c_int,
        *const libc::c_char,
        *const libc::posix_spawn_file_actions_t,
        *const libc::posix_spawnattr_t,
        *const *mut libc::c_char,
        *const *mut libc::c_char,
    ) -> libc::c_int;

    fn pidfd_spawn_fn() -> Option<SpawnFn> {
        #[cfg(target_os = "linux")]
        {
            let name = b"pidfd_spawn\0";
            let f = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr() as *const libc::c_char) };
            if !f.is_null() {
                return Some(unsafe { std::mem::transmute::<*mut libc::c_void, SpawnFn>(f) });
            }
        }
        None
    }

    #[cfg(target_os = "linux")]
    fn pidfd_pid(pidfd: i32) -> libc::pid_t {
        // (/proc/self/fdinfo's "Pid:" line: the pid the pidfd refers to)
        let path = format!("/proc/self/fdinfo/{}", pidfd);
        if let Ok(s) = std::fs::read_to_string(path) {
            for line in s.lines() {
                if let Some(v) = line.strip_prefix("Pid:") {
                    if let Ok(p) = v.trim().parse() {
                        return p;
                    }
                }
            }
        }
        -1
    }

    /// The creation itself (no lock held): the four pipes, the file actions,
    /// an empty signal mask, then pidfd_spawn or posix_spawn; on any error
    /// every descriptor made is closed.
    fn create(spec: &Spec) -> Result<Proc, (i32, String)> {
        let mut made: Vec<i32> = Vec::new();
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
        let mut fa: libc::posix_spawn_file_actions_t = unsafe { std::mem::zeroed() };
        let mut at: libc::posix_spawnattr_t = unsafe { std::mem::zeroed() };
        unsafe {
            libc::posix_spawn_file_actions_init(&mut fa);
            libc::posix_spawnattr_init(&mut at);
        }
        let mut r = 0;
        for (from, to) in [(req.0, 0), (rep.1, 1), (spec.err_fd, 2), (kil.0, 3), (life.1, 4)] {
            if r == 0 {
                r = unsafe { libc::posix_spawn_file_actions_adddup2(&mut fa, from, to) };
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
        let mut pidfd: i32 = -1;
        if r == 0 {
            let mut done = false;
            if let Some(f) = pidfd_spawn_fn() {
                let mut fd: libc::c_int = -1;
                let e = unsafe { f(&mut fd, spec.path.as_ptr(), &fa, &at, argv.as_ptr(), envp.as_ptr()) };
                if e == 0 {
                    pidfd = fd;
                    #[cfg(target_os = "linux")]
                    {
                        pid = pidfd_pid(fd);
                    }
                    done = true;
                } else if e != libc::ENOSYS {
                    // (no fallback on any other error: H-4)
                    r = e;
                    done = true;
                }
            }
            if !done {
                r = unsafe { libc::posix_spawn(&mut pid, spec.path.as_ptr(), &fa, &at, argv.as_ptr(), envp.as_ptr()) };
            }
        }
        unsafe {
            libc::posix_spawn_file_actions_destroy(&mut fa);
            libc::posix_spawnattr_destroy(&mut at);
        }
        if r != 0 {
            return fail(&mut made, r, "starting the PNG engine's process");
        }
        if pid <= 0 {
            // (a pidfd whose pid can't be read: the child is killed through
            // it and reaped through its pid... which we don't have; refuse)
            if pidfd >= 0 {
                #[cfg(target_os = "linux")]
                unsafe {
                    libc::syscall(libc::SYS_pidfd_send_signal, pidfd, libc::SIGKILL, std::ptr::null::<libc::c_void>(), 0)
                };
                unsafe { libc::close(pidfd) };
            }
            return fail(&mut made, libc::ESRCH, "reading the PNG engine process's pid from its pidfd");
        }
        // (the child's ends closed in the parent)
        for fd in [req.0, rep.1, kil.0, life.1] {
            unsafe { libc::close(fd) };
        }
        Ok(Proc { pid, pidfd, wfd: req.1, rfd: rep.0, killfd: kil.1, lifefd: life.0, state: State::Running, status: None, signals: 0 })
    }

    fn cstr(s: &str) -> PyResult<CString> {
        CString::new(s).map_err(|_| PyOSError::new_err("an argument with a NUL byte"))
    }

    #[pymethods]
    impl SpawnTask {
        /// The creation's spec: the program's path, its argv, its environment
        /// (a dict), the stderr file's descriptor; `fail_after` (tests only):
        /// fail before making that pipe.
        #[new]
        #[pyo3(signature = (path, argv, env, err_fd, fail_after=None))]
        fn new(path: &str, argv: Vec<String>, env: &Bound<'_, PyDict>, err_fd: i32, fail_after: Option<u32>) -> PyResult<Self> {
            let mut envp = Vec::new();
            for (k, v) in env.iter() {
                envp.push(cstr(&format!("{}={}", k.extract::<String>()?, v.extract::<String>()?))?);
            }
            let spec = Spec { path: cstr(path)?, argv: argv.iter().map(|a| cstr(a)).collect::<PyResult<_>>()?, envp, err_fd, fail_after };
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

    pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
        m.add_class::<Child>()?;
        m.add_class::<SpawnTask>()?;
        m.add_function(wrap_pyfunction!(sigchld_check, m)?)?;
        Ok(())
    }
}
