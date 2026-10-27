//! What the app is doing, and the folder-sync engine it runs as its sidecar.
//!
//! The engine is the same Go binary the CLI is (docs/peps/0005 §4): `login --json --print-token` signs in,
//! `init` makes the folder a synced folder, `sync --watch --events` keeps it in sync with push on (PEP 0004) and
//! reports each round as a folder-sync-event/1 line, `logout` ends the session on the server. The app only keeps
//! the session (keychain), the settings, and the tray.

use crate::settings::Settings;
use crate::vault;
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// What the tray shows. WHY these: Zach's list (synced, syncing, offline, over quota with its reason, signed out),
/// plus the in-between states a person passes through (signing in, no folder yet, paused) and a plain error.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    SignedOut,
    SigningIn { code: String, link: String },
    NeedsFolder,
    Starting,
    Syncing,
    Synced { at: String, machines: usize },
    Offline { why: String },
    OverQuota { why: String },
    Paused,
    Error { why: String },
}

impl Status {
    /// The tray icon's name (icons/tray/<name>.png).
    pub fn icon(&self) -> &'static str {
        match self {
            Status::SignedOut | Status::SigningIn { .. } | Status::NeedsFolder => "signed_out",
            Status::Starting | Status::Syncing => "syncing",
            Status::Synced { .. } => "synced",
            Status::Offline { .. } => "offline",
            Status::OverQuota { .. } => "over_quota",
            Status::Paused => "paused",
            Status::Error { .. } => "error",
        }
    }

    /// One line for the tray menu and the window.
    pub fn headline(&self) -> String {
        match self {
            Status::SignedOut => "Signed out".into(),
            Status::SigningIn { code, .. } => format!("Signing in: approve {code} in your browser"),
            Status::NeedsFolder => "Signed in: choose your folder".into(),
            Status::Starting => "Starting…".into(),
            Status::Syncing => "Syncing…".into(),
            Status::Synced { at, machines } => {
                let others = if *machines == 1 { "1 other machine".to_string() } else { format!("{machines} other machines") };
                if *machines == 0 {
                    format!("Synced at {at}")
                } else {
                    format!("Synced at {at} · {others}")
                }
            }
            Status::Offline { .. } => "Offline: will sync when the server answers".into(),
            Status::OverQuota { .. } => "Over quota: not uploading".into(),
            Status::Paused => "Paused".into(),
            Status::Error { .. } => "Sync error".into(),
        }
    }

    /// The reason, when there is one worth reading (over quota above all).
    pub fn detail(&self) -> Option<String> {
        match self {
            Status::OverQuota { why } | Status::Offline { why } | Status::Error { why } => Some(why.clone()),
            _ => None,
        }
    }
}

/// What the window and the tray are drawn from.
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub status: Status,
    pub headline: String,
    pub detail: Option<String>,
    pub icon: &'static str,
    pub email: Option<String>,
    pub server: String,
    pub site: String,
    pub folder: Option<String>,
    pub default_folder: String,
    pub paused: bool,
    pub autostart: bool,
}

pub struct Inner {
    pub settings: Settings,
    pub settings_path: PathBuf,
    pub log_path: PathBuf,
    pub status: Status,
    pub signed_in: bool,
    pub engine: Option<Child>,
    /// Bumped every time the engine is started or stopped on purpose: a reader thread of an older engine then
    /// knows its exit was asked for and must not restart anything.
    pub generation: u64,
    pub login: Option<Child>,
    pub quitting: bool,
}

#[derive(Clone)]
pub struct Shared(pub Arc<Mutex<Inner>>);

impl Shared {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The engine binary: next to this executable (Tauri's externalBin, bundled as `folder-sync`), unless
/// FOLDER_SYNC_DESKTOP_ENGINE names another (development).
pub fn engine_path() -> PathBuf {
    if let Ok(path) = std::env::var("FOLDER_SYNC_DESKTOP_ENGINE") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let name = if cfg!(windows) { "folder-sync.exe" } else { "folder-sync" };
    exe.parent().map(|dir| dir.join(name)).unwrap_or_else(|| PathBuf::from(name))
}

/// The engine command with this app as its account process.
fn engine(settings: &Settings) -> Command {
    let mut cmd = Command::new(engine_path());
    let me = std::env::current_exe().unwrap_or_default();
    let argv = serde_json::to_string(&[me.to_string_lossy().to_string(), "--account-process".to_string()]).unwrap();
    cmd.env("FOLDER_SYNC_ACCOUNT_PROCESS", argv);
    cmd.env("FOLDER_SYNC_SERVER", &settings.server);
    // WHY: an app session never uses a stray key from the person's shell; the account is the only identity.
    for name in ["FOLDER_SYNC_CREDENTIAL_PROCESS", "FOLDER_SYNC_ACCESS_KEY_ID", "FOLDER_SYNC_SECRET_ACCESS_KEY"] {
        cmd.env_remove(name);
    }
    cmd.stdin(Stdio::null());
    cmd
}

pub fn site_of(settings: &Settings) -> String {
    format!("{}/saved/", settings.server.trim_end_matches('/'))
}

pub fn default_folder(app: &AppHandle, project: &str) -> PathBuf {
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cfg!(windows) {
        home.join("Documents").join(project)
    } else {
        home.join(project)
    }
}

/// A path as a person reads it: ~/robotparts, not /home/<name>/robotparts.
pub fn tilde(app: &AppHandle, path: &Path) -> String {
    if !cfg!(windows) {
        if let Ok(home) = app.path().home_dir() {
            if let Ok(rest) = path.strip_prefix(&home) {
                return format!("~/{}", rest.display());
            }
        }
    }
    path.display().to_string()
}

pub fn snapshot(app: &AppHandle) -> Snapshot {
    let shared = app.state::<Shared>();
    let inner = shared.lock();
    let autostart = {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().unwrap_or(false)
    };
    Snapshot {
        headline: inner.status.headline(),
        detail: inner.status.detail(),
        icon: inner.status.icon(),
        status: inner.status.clone(),
        email: if inner.signed_in { inner.settings.email.clone() } else { None },
        server: inner.settings.server.clone(),
        site: site_of(&inner.settings),
        folder: inner.settings.folder.as_ref().map(|f| tilde(app, f)),
        default_folder: tilde(app, &default_folder(app, &inner.settings.project)),
        paused: inner.settings.paused,
        autostart,
    }
}

/// Redraw the tray and tell the window.
pub fn refresh(app: &AppHandle) {
    let snap = snapshot(app);
    crate::tray::update(app, &snap);
    let _ = app.emit("state", &snap);
}

pub fn set_status(app: &AppHandle, status: Status) {
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        if inner.status == status {
            return;
        }
        match status.detail() {
            Some(why) => log(&inner.log_path, &format!("status: {} ({why})", status.headline())),
            None => log(&inner.log_path, &format!("status: {}", status.headline())),
        }
        inner.status = status;
    }
    refresh(app);
}

pub fn log(path: &Path, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {}", now_hms(), line);
    }
}

fn now_hms() -> String {
    // local time without a time crate: the engine's events carry RFC 3339; the menu wants HH:MM:SS
    let out = Command::new("date").arg("+%H:%M:%S").output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// On start: signed in (keychain) → folder → engine, or the first step that is missing.
pub fn boot(app: &AppHandle) {
    let server = app.state::<Shared>().lock().settings.server.clone();
    let signed_in = matches!(vault::load(&server), Ok(Some(_)));
    let (has_folder, paused) = {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.signed_in = signed_in;
        (inner.settings.folder.is_some(), inner.settings.paused)
    };
    if !signed_in {
        set_status(app, Status::SignedOut);
    } else if !has_folder {
        set_status(app, Status::NeedsFolder);
    } else if paused {
        set_status(app, Status::Paused);
    } else {
        start_engine(app);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Sign in: the device grant, through the engine, in the system browser (RFC 8252: never a web view of our own).

pub fn sign_in(app: &AppHandle) -> Result<(), String> {
    let settings = {
        let shared = app.state::<Shared>();
        let inner = shared.lock();
        if inner.login.is_some() {
            return Ok(()); // already waiting for an approval
        }
        inner.settings.clone()
    };
    let mut cmd = engine(&settings);
    cmd.args(["login", "--json", "--print-token", "--server", &settings.server]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("could not start the sync engine ({}): {e}", engine_path().display()))?;
    let stdout = child.stdout.take().unwrap();
    {
        let shared = app.state::<Shared>();
        shared.lock().login = Some(child);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut signed = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(ev) = serde_json::from_str::<Value>(&line) else { continue };
            match ev["event"].as_str() {
                Some("device") => {
                    let link = ev["link"].as_str().unwrap_or_default().to_string();
                    let code = ev["user_code"].as_str().unwrap_or_default().to_string();
                    set_status(&app, Status::SigningIn { code, link: link.clone() });
                    open_url(&app, &link);
                }
                Some("signed_in") => {
                    let account = &ev["account"];
                    if account.is_null() {
                        set_status(&app, Status::Error { why: "the engine signed in but handed no session back".into() });
                        continue;
                    }
                    // the token goes from the engine's pipe straight into the keychain
                    let server = app.state::<Shared>().lock().settings.server.clone();
                    if let Err(why) = vault::store(&server, &account.to_string()) {
                        set_status(&app, Status::Error { why });
                        continue;
                    }
                    signed = true;
                    let (needs_folder, first) = {
                        let shared = app.state::<Shared>();
                        let mut inner = shared.lock();
                        inner.signed_in = true;
                        inner.settings.email = ev["user"]["email"].as_str().map(String::from);
                        inner.settings.user_id = ev["user"]["id"].as_str().map(String::from);
                        let first = !inner.settings.autostart_decided;
                        inner.settings.autostart_decided = true;
                        let _ = inner.settings.save(&inner.settings_path);
                        (inner.settings.folder.is_none(), first)
                    };
                    if first {
                        // WHY on by default after the first sign-in: a sync app that stops at reboot silently stops
                        // syncing; the menu's "Start at login" turns it off.
                        use tauri_plugin_autostart::ManagerExt;
                        let _ = app.autolaunch().enable();
                    }
                    if needs_folder {
                        set_status(&app, Status::NeedsFolder);
                    } else {
                        start_engine(&app);
                    }
                    crate::show_window(&app);
                }
                Some("error") => {
                    let why = ev["error"].as_str().unwrap_or("sign-in failed").to_string();
                    set_status(&app, Status::Error { why });
                }
                _ => {}
            }
        }
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        if let Some(mut child) = inner.login.take() {
            let _ = child.wait();
        }
        let back_to_signed_out = !signed && matches!(inner.status, Status::SigningIn { .. });
        drop(inner);
        if back_to_signed_out {
            set_status(&app, Status::SignedOut);
        }
    });
    Ok(())
}

pub fn cancel_sign_in(app: &AppHandle) {
    let child = {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.login.take()
    };
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    set_status(app, Status::SignedOut);
}

/// The system browser, or FOLDER_SYNC_DESKTOP_OPEN_URL (a program given the URL) for headless tests.
pub fn open_url(app: &AppHandle, url: &str) {
    if let Ok(program) = std::env::var("FOLDER_SYNC_DESKTOP_OPEN_URL") {
        if !program.is_empty() {
            let _ = Command::new(program).arg(url).stdin(Stdio::null()).spawn();
            return;
        }
    }
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url, None::<&str>);
}

pub fn sign_out(app: &AppHandle) -> Result<(), String> {
    stop_engine(app);
    let settings = {
        let shared = app.state::<Shared>();
        let inner = shared.lock();
        inner.settings.clone()
    };
    // the server ends this machine's session (the engine asks this app for the token one last time)
    if matches!(vault::load(&settings.server), Ok(Some(_))) {
        let _ = engine(&settings).arg("logout").stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    vault::forget(&settings.server)?;
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.signed_in = false;
        inner.settings.email = None;
        inner.settings.user_id = None;
        let _ = inner.settings.save(&inner.settings_path);
    }
    set_status(app, Status::SignedOut);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// The folder: the app makes it itself.

pub fn use_folder(app: &AppHandle, folder: PathBuf) -> Result<(), String> {
    if !app.state::<Shared>().lock().signed_in {
        // WHY: `init` asks the account for the folder's root; a folder made before sign-in would only fail
        return Err("sign in first".into());
    }
    std::fs::create_dir_all(&folder).map_err(|e| format!("could not make {}: {e}", folder.display()))?;
    let settings = {
        let shared = app.state::<Shared>();
        let inner = shared.lock();
        inner.settings.clone()
    };
    set_status(app, Status::Starting);
    let out = engine(&settings)
        .args(["init", "--project", &settings.project, "--dir"])
        .arg(&folder)
        .output()
        .map_err(|e| format!("could not start the sync engine: {e}"))?;
    {
        let shared = app.state::<Shared>();
        let inner = shared.lock();
        log(&inner.log_path, &format!("init {}: {}", folder.display(), String::from_utf8_lossy(&out.stdout).trim()));
    }
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        set_status(app, Status::Error { why: why.clone() });
        return Err(why);
    }
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.settings.folder = Some(folder);
        inner.settings.paused = false;
        let _ = inner.settings.save(&inner.settings_path);
    }
    start_engine(app);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// The engine: `sync --watch --events`, restarted if it dies, stopped with SIGTERM so it finishes its round.

pub fn start_engine(app: &AppHandle) {
    let (settings, generation, log_path) = {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        if inner.engine.is_some() || inner.quitting {
            return;
        }
        inner.generation += 1;
        (inner.settings.clone(), inner.generation, inner.log_path.clone())
    };
    let Some(folder) = settings.folder.clone() else {
        set_status(app, Status::NeedsFolder);
        return;
    };
    let stderr = std::fs::OpenOptions::new().create(true).append(true).open(&log_path);
    let mut cmd = engine(&settings);
    cmd.args(["sync", "--watch", "--events", "--dir"]).arg(&folder).stdout(Stdio::piped());
    match stderr {
        Ok(f) => cmd.stderr(Stdio::from(f)),
        Err(_) => cmd.stderr(Stdio::null()),
    };
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            set_status(app, Status::Error { why: format!("could not start the sync engine ({}): {e}", engine_path().display()) });
            return;
        }
    };
    let stdout = child.stdout.take().unwrap();
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        log(&inner.log_path, &format!("engine started (pid {}) on {}", child.id(), folder.display()));
        inner.engine = Some(child);
    }
    set_status(app, Status::Starting);
    let app = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(ev) = serde_json::from_str::<Value>(&line) {
                on_event(&app, generation, &ev);
            }
        }
        // the engine ended: on purpose (generation moved on), or it died
        let restart = {
            let shared = app.state::<Shared>();
            let mut inner = shared.lock();
            if inner.generation != generation {
                false
            } else {
                if let Some(mut child) = inner.engine.take() {
                    let _ = child.wait();
                }
                !inner.quitting && inner.signed_in && !inner.settings.paused
            }
        };
        if restart {
            set_status(&app, Status::Error { why: "the sync engine stopped; restarting".into() });
            // WHY a floor on the backoff: an engine that dies at once must not spin
            let wait = if started.elapsed() < Duration::from_secs(10) { 10 } else { 2 };
            std::thread::sleep(Duration::from_secs(wait));
            let still = {
                let shared = app.state::<Shared>();
                let inner = shared.lock();
                inner.generation == generation && inner.engine.is_none() && !inner.quitting
            };
            if still {
                start_engine(&app);
            }
        }
    });
}

fn on_event(app: &AppHandle, generation: u64, ev: &Value) {
    {
        let shared = app.state::<Shared>();
        if shared.lock().generation != generation {
            return;
        }
    }
    match ev["event"].as_str() {
        Some("round_start") => {
            // WHY not on a timer round: the safety-net round every minute must not flicker the icon for nothing;
            // a round a change started (this folder, the hub, a catch-up) or the first one is real work.
            let source = ev["source"].as_str().unwrap_or_default();
            if source != "timer" {
                set_status(app, Status::Syncing);
            }
        }
        Some("round") => {
            if ev["ok"].as_bool() == Some(true) {
                let at = ev["at"].as_str().and_then(local_hms).unwrap_or_default();
                let machines = ev["peers"].as_u64().unwrap_or(0) as usize;
                set_status(app, Status::Synced { at, machines });
            } else {
                let why = ev["why"].as_str().unwrap_or_default().to_string();
                match ev["kind"].as_str() {
                    Some("signed_out") => {
                        // the server no longer knows this machine (signed out elsewhere, revoked)
                        stop_engine(app);
                        let server = app.state::<Shared>().lock().settings.server.clone();
                        let _ = vault::forget(&server);
                        {
                            let shared = app.state::<Shared>();
                            shared.lock().signed_in = false;
                        }
                        set_status(app, Status::SignedOut);
                    }
                    Some("over_quota") => set_status(app, Status::OverQuota { why }),
                    Some("offline") => set_status(app, Status::Offline { why }),
                    _ => set_status(app, Status::Error { why }),
                }
            }
        }
        _ => {}
    }
}

/// HH:MM:SS of an RFC 3339 UTC stamp, in local time.
fn local_hms(stamp: &str) -> Option<String> {
    let out = Command::new("date").args(["-d", stamp, "+%H:%M:%S"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Stop the engine and wait for it (SIGTERM: `--watch` finishes the round and the manifest publish first).
pub fn stop_engine(app: &AppHandle) {
    let child = {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.generation += 1;
        inner.engine.take()
    };
    let Some(mut child) = child else { return };
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill(); // TODO(windows): CTRL_BREAK_EVENT through a process group, then kill
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    let shared = app.state::<Shared>();
    let inner = shared.lock();
    log(&inner.log_path, "engine stopped");
}

pub fn set_paused(app: &AppHandle, paused: bool) {
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.settings.paused = paused;
        let _ = inner.settings.save(&inner.settings_path);
    }
    if paused {
        stop_engine(app);
        set_status(app, Status::Paused);
    } else {
        start_engine(app);
    }
}
