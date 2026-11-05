//! What the app is doing, and the folder-sync engine it runs as its sidecar.
//!
//! The engine is the same Go binary the CLI is (docs/peps/0006 §4): `login --json --print-token` signs in,
//! `init` makes the folder a synced folder, `sync --watch --events` keeps it in sync with push on (PEP 0005) and
//! reports each round as a folder-sync-event/1 line, `logout` ends the session on the server. The app only keeps
//! the session (keychain), the settings, and the tray.
//!
//! The folder is chosen the way Obsidian chooses a vault (Zach, 2026-11-04): create a new one (name and location),
//! open an existing one (its files upload), or pick one of "your folders online" (another machine set it up; this one
//! downloads it). The project is the folder's name, or the online folder that was picked: there is no fixed project.

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
    /// A sign-in that did not finish. WHY its own state and not Error: the window and tray then offer Sign in again
    /// and Cancel; the generic error screen had only Start at login and Quit (a real Windows test, 2026-10-29).
    SignInFailed { why: String },
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
            Status::Error { .. } | Status::SignInFailed { .. } => "error",
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
            Status::SignInFailed { .. } => "Sign-in failed".into(),
        }
    }

    /// The reason, when there is one worth reading (over quota above all).
    pub fn detail(&self) -> Option<String> {
        match self {
            Status::OverQuota { why } | Status::Offline { why } | Status::Error { why } | Status::SignInFailed { why } => Some(why.clone()),
            _ => None,
        }
    }
}

/// "Your folders online": the person's folders on the server, for the picker (`folder-sync projects --json`, one LIST).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Online {
    #[default]
    Idle,
    Loading,
    Ready { folders: Vec<String> },
    Failed { why: String },
}

/// What the window and the tray are drawn from.
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub status: Status,
    pub headline: String,
    pub detail: Option<String>,
    pub icon: &'static str,
    /// WHY apart from `email`: the keychain can hold a sign-in while settings.json has no email (the file was lost, a
    /// second computer sharing the keychain); the window must still offer the folder picker then (found by the real run).
    pub signed_in: bool,
    pub email: Option<String>,
    pub server: String,
    /// Where "Open online" goes: the Files page, on the folder when there is one.
    pub site: String,
    pub folder: Option<String>,
    pub project: Option<String>,
    /// The folder the picker offers a new folder in (~/folder-sync), as a person reads it, and the real path.
    pub default_parent: String,
    pub default_parent_path: String,
    /// The picker is open: the first run (no folder yet) or "Change folder…".
    pub picking: bool,
    pub online: Online,
    pub paused: bool,
    pub autostart: bool,
    /// FOLDER_SYNC_SERVER decides the server (a dev or test run), so the Advanced field is read-only.
    pub server_locked: bool,
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
    pub online: Online,
    pub picking: bool,
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
    cmd.env("FOLDER_SYNC_SERVER", settings.server());
    // WHY: an app session never uses a stray key from the person's shell; the account is the only identity.
    for name in ["FOLDER_SYNC_CREDENTIAL_PROCESS", "FOLDER_SYNC_ACCESS_KEY_ID", "FOLDER_SYNC_SECRET_ACCESS_KEY"] {
        cmd.env_remove(name);
    }
    cmd.stdin(Stdio::null());
    // WHY CREATE_NO_WINDOW: the engine is a console program; started from this windowless app, Windows would open a
    // console window for it on every start (README "macOS and Windows"). rclone, its child, inherits the hidden console.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The Files page (`<server>/fs/files`, accounts/site/files.js), on the folder's project when there is one.
pub fn site_of(settings: &Settings) -> String {
    let page = format!("{}/fs/files", settings.server().trim_end_matches('/'));
    match &settings.project {
        Some(project) if settings.folder.is_some() => format!("{page}?project={project}"),
        _ => page,
    }
}

/// Where a new folder goes unless the person chooses: ~/folder-sync (Documents\folder-sync on Windows).
pub fn default_parent(app: &AppHandle) -> PathBuf {
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cfg!(windows) {
        home.join("Documents").join("folder-sync")
    } else {
        home.join("folder-sync")
    }
}

/// A path as a person reads it: ~/folder-sync/notes, not /home/<name>/folder-sync/notes.
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
        signed_in: inner.signed_in,
        email: if inner.signed_in { inner.settings.email.clone() } else { None },
        server: inner.settings.server(),
        site: site_of(&inner.settings),
        folder: inner.settings.folder.as_ref().map(|f| tilde(app, f)),
        project: inner.settings.project.clone(),
        default_parent: tilde(app, &default_parent(app)),
        default_parent_path: default_parent(app).display().to_string(),
        picking: inner.signed_in && (inner.picking || matches!(inner.status, Status::NeedsFolder)),
        online: inner.online.clone(),
        paused: inner.settings.paused,
        autostart,
        server_locked: Settings::server_locked(),
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
    // WHY chrono, not `date`: Windows has no date.exe and macOS's BSD date has no -d, so the menu's times went blank
    // there (found building the installers, 2026-10-28). chrono is already in Tauri's tree.
    chrono::Local::now().format("%H:%M:%S").to_string()
}

/// On start: signed in (keychain) → folder → engine, or the first step that is missing.
pub fn boot(app: &AppHandle) {
    let server = app.state::<Shared>().lock().settings.server();
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
        refresh_online(app);
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
    cmd.args(["login", "--json", "--print-token", "--server", &settings.server()]);
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
                        set_status(&app, Status::SignInFailed { why: "the engine signed in but handed no session back".into() });
                        continue;
                    }
                    // the token goes from the engine's pipe straight into the keychain
                    let server = app.state::<Shared>().lock().settings.server();
                    if let Err(why) = vault::store(&server, &account.to_string()) {
                        set_status(&app, Status::SignInFailed { why });
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
                        refresh_online(&app);
                    } else {
                        start_engine(&app);
                    }
                    crate::show_window(&app);
                }
                Some("error") => {
                    let why = ev["error"].as_str().unwrap_or("sign-in failed").to_string();
                    set_status(&app, Status::SignInFailed { why });
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
    if matches!(vault::load(&settings.server()), Ok(Some(_))) {
        let _ = engine(&settings).arg("logout").stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    vault::forget(&settings.server())?;
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.signed_in = false;
        inner.picking = false;
        inner.online = Online::Idle;
        inner.settings.email = None;
        inner.settings.user_id = None;
        let _ = inner.settings.save(&inner.settings_path);
    }
    set_status(app, Status::SignedOut);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// The folder: new, existing, or one of "your folders online" (the picker).

/// The project name folder-sync derives from a folder's name (config.ProjectFromFolder in Go, which this repeats): lower
/// case, anything but a-z 0-9 . _ - becomes '-', no leading . _ -, at most 63 characters. WHY here as well: the picker
/// must know the project a typed name will get before `init` runs, to say that it already exists online.
pub fn project_from_folder(name: &str) -> String {
    let mut project: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect();
    project = project.trim_start_matches(['.', '_', '-']).to_string();
    if project.is_empty() {
        project = "project".to_string();
    }
    project.truncate(63);
    project
}

/// The project a folder's `.folder-sync.toml` names.
pub fn read_project(folder: &Path) -> Option<String> {
    let text = std::fs::read_to_string(folder.join(".folder-sync.toml")).ok()?;
    text.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("project")?.trim_start().strip_prefix('=')?;
        Some(rest.trim().trim_matches('"').to_string())
    })
}

/// A folder name a person typed: one path segment, not empty, not a dot.
pub fn check_folder_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':']) {
        return Err("Give the folder a name: letters, digits and spaces, no slashes.".into());
    }
    Ok(name.to_string())
}

fn online_folders(app: &AppHandle) -> Vec<String> {
    match &app.state::<Shared>().lock().online {
        Online::Ready { folders } => folders.clone(),
        _ => Vec::new(),
    }
}

/// Ask the server which folders this person has (`folder-sync projects --json`, one LIST), for "Your folders online".
pub fn refresh_online(app: &AppHandle) {
    let settings = {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        if !inner.signed_in {
            return;
        }
        inner.online = Online::Loading;
        inner.settings.clone()
    };
    refresh(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let answer = engine(&settings).args(["projects", "--json"]).output();
        let online = match answer {
            Err(e) => Online::Failed { why: format!("could not start the sync engine: {e}") },
            Ok(out) if !out.status.success() => Online::Failed { why: last_line(&out.stderr) },
            Ok(out) => match serde_json::from_slice::<Value>(&out.stdout) {
                Ok(doc) => Online::Ready {
                    folders: doc["projects"].as_array().map(|a| a.iter().filter_map(|n| n.as_str().map(String::from)).collect()).unwrap_or_default(),
                },
                Err(e) => Online::Failed { why: format!("the engine's answer was not JSON: {e}") },
            },
        };
        match &online {
            Online::Ready { folders } => log_line(&app, &format!("online folders: {}", folders.join(", "))),
            Online::Failed { why } => log_line(&app, &format!("online folders failed: {why}")),
            _ => {}
        }
        app.state::<Shared>().lock().online = online;
        refresh(&app);
    });
}

fn last_line(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.trim().lines().last().unwrap_or("the engine stopped without saying why").to_string()
}

/// Open the picker ("Change folder…", or a tray item while there is no folder).
pub fn open_picker(app: &AppHandle) {
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        if !inner.signed_in {
            return;
        }
        inner.picking = true;
    }
    refresh(app);
    refresh_online(app);
    crate::show_window(app);
}

pub fn close_picker(app: &AppHandle) {
    app.state::<Shared>().lock().picking = false;
    refresh(app);
}

/// A new folder `name` inside `parent`: made, shared, and synced.
pub fn create_folder(app: &AppHandle, name: &str, parent: PathBuf) -> Result<(), String> {
    let name = check_folder_name(name)?;
    let project = project_from_folder(&name);
    if online_folders(app).contains(&project) {
        // WHY a refusal: `init` would attach this empty folder to the online one of that name, which is a download
        // the person did not ask for; "Your folders online" says that out loud.
        return Err(format!("You already have a folder named {project} online. Pick it under Your folders online to download it, or give this one another name."));
    }
    use_folder(app, parent.join(name), None, true)
}

/// An existing folder: whatever is in it uploads. Refuses a place that is not a folder to sync.
pub fn open_existing_folder(app: &AppHandle, folder: PathBuf) -> Result<(), String> {
    let home = app.path().home_dir().ok();
    if home.as_deref() == Some(folder.as_path()) || folder.parent().is_none() {
        // WHY: syncing the home folder (or a drive's root) would upload everything the person owns
        return Err("Pick a folder inside your home folder, not the home folder itself.".into());
    }
    use_folder(app, folder, None, true)
}

/// One of "your folders online", downloaded into `parent/<project>`.
pub fn join_folder(app: &AppHandle, project: &str, parent: PathBuf) -> Result<(), String> {
    let folder = parent.join(project);
    let own = read_project(&folder).as_deref() == Some(project);
    let busy = std::fs::read_dir(&folder).map(|mut d| d.next().is_some()).unwrap_or(false);
    if busy && !own {
        // WHY: merging an online folder into a folder that already holds other files is how work gets mixed up
        return Err(format!("{} is not empty. Choose an empty place for {project}.", folder.display()));
    }
    // WHY `share` here too: it is idempotent for a folder that is already shared, and a folder set up before the shared
    // tree existed would otherwise download as one read-only copy per machine under hosts/, not as the folder itself
    use_folder(app, folder, Some(project.to_string()), true)
}

/// Make `folder` the synced folder: `init` (the project is the folder's name unless one is named), `share` for a folder
/// this machine starts (WHY: Zach wants Obsidian Sync, the same files on every machine, not one read-only copy per
/// machine, docs/peps/0010), then the engine. Nothing about the running folder changes until `init` has succeeded.
pub fn use_folder(app: &AppHandle, folder: PathBuf, project: Option<String>, share: bool) -> Result<(), String> {
    let settings = {
        let shared = app.state::<Shared>();
        let inner = shared.lock();
        if !inner.signed_in {
            // WHY: `init` asks the account for the folder's root; a folder made before sign-in would only fail
            return Err("sign in first".into());
        }
        inner.settings.clone()
    };
    std::fs::create_dir_all(&folder).map_err(|e| format!("could not make {}: {e}", folder.display()))?;
    let mut init = engine(&settings);
    init.arg("init");
    if let Some(project) = &project {
        init.args(["--project", project]);
    }
    let out = init.arg("--dir").arg(&folder).output().map_err(|e| format!("could not start the sync engine: {e}"))?;
    log_line(app, &format!("init {}: {}", folder.display(), String::from_utf8_lossy(&out.stdout).trim()));
    if !out.status.success() {
        return Err(last_line(&out.stderr));
    }
    if share {
        let out = engine(&settings).arg("share").arg("--dir").arg(&folder).output().map_err(|e| format!("could not start the sync engine: {e}"))?;
        log_line(app, &format!("share {}: {}", folder.display(), String::from_utf8_lossy(&out.stdout).trim()));
        if !out.status.success() {
            return Err(last_line(&out.stderr));
        }
    }
    let project = read_project(&folder).or(project);
    stop_engine(app);
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.settings.folder = Some(folder);
        inner.settings.project = project;
        inner.settings.paused = false;
        inner.picking = false;
        let _ = inner.settings.save(&inner.settings_path);
    }
    start_engine(app);
    Ok(())
}

fn log_line(app: &AppHandle, line: &str) {
    let shared = app.state::<Shared>();
    let inner = shared.lock();
    log(&inner.log_path, line);
}

/// Change the server (the first-run window's Advanced field). Only while signed out: a session belongs to one server.
pub fn set_server(app: &AppHandle, server: &str) -> Result<(), String> {
    if Settings::server_locked() {
        return Err("FOLDER_SYNC_SERVER decides the server in this run.".into());
    }
    let server = server.trim().trim_end_matches('/').to_string();
    let valid = server.strip_prefix("https://").or_else(|| server.strip_prefix("http://")).map(|rest| !rest.is_empty() && !rest.contains(char::is_whitespace)).unwrap_or(false);
    if !valid {
        return Err("A server address starts with https:// (or http:// for a local one).".into());
    }
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        if inner.signed_in || inner.login.is_some() {
            return Err("Sign out first: a sign-in belongs to one server.".into());
        }
        inner.settings.server = if server == crate::settings::DEFAULT_SERVER { String::new() } else { server };
        let _ = inner.settings.save(&inner.settings_path);
    }
    boot(app); // the new server may already have a session in the keychain
    refresh(app);
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
                // WHY minus one: every folder this app makes or joins is a shared tree (use_folder), and the engine counts the
                // tree itself among the peers it pulled from; a person's other machines are the rest
                let machines = (ev["peers"].as_u64().unwrap_or(0) as usize).saturating_sub(1);
                set_status(app, Status::Synced { at, machines });
            } else {
                let why = ev["why"].as_str().unwrap_or_default().to_string();
                match ev["kind"].as_str() {
                    Some("signed_out") => {
                        // the server no longer knows this machine (signed out elsewhere, revoked)
                        stop_engine(app);
                        let server = app.state::<Shared>().lock().settings.server();
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
    let at = chrono::DateTime::parse_from_rfc3339(stamp).ok()?;
    Some(at.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
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

#[cfg(test)]
mod tests {
    use super::{check_folder_name, local_hms, project_from_folder, read_project, site_of, Online, Status};
    use crate::settings::Settings;

    // The same table as Go's TestProjectFromFolder (internal/config): the picker must name the project the engine will.
    #[test]
    fn a_typed_folder_name_gets_the_project_the_engine_gives_it() {
        for (typed, project) in [("My Notes", "my-notes"), ("vibetracks", "vibetracks"), ("_hidden", "hidden"), ("日本", "project"), ("___", "project")] {
            assert_eq!(project_from_folder(typed), project, "{typed}");
        }
        assert_eq!(project_from_folder(&"a".repeat(80)).len(), 63);
    }

    #[test]
    fn a_folder_name_is_one_path_segment() {
        assert_eq!(check_folder_name("  Field notes ").as_deref(), Ok("Field notes"));
        for bad in ["", "   ", ".", "..", "a/b", "a\\b", "c:"] {
            assert!(check_folder_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_project_is_read_back_from_the_folders_config() {
        let dir = std::env::temp_dir().join(format!("fs-read-project-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_project(&dir), None);
        std::fs::write(dir.join(".folder-sync.toml"), "# folder-sync\nproject = \"my-notes\"\nbucket = \"folder-sync\"\n").unwrap();
        assert_eq!(read_project(&dir).as_deref(), Some("my-notes"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // "Open online" is the Files page (accounts/site/files.js), on the folder's project once there is a folder.
    #[test]
    fn open_online_is_the_files_page_of_the_folder() {
        let mut settings = Settings { server: "https://example.test/".into(), ..Settings::default() };
        if !Settings::server_locked() {
            assert_eq!(site_of(&settings), "https://example.test/fs/files");
            settings.folder = Some("/home/x/folder-sync/notes".into());
            settings.project = Some("notes".into());
            assert_eq!(site_of(&settings), "https://example.test/fs/files?project=notes");
        }
    }

    #[test]
    fn the_online_list_reaches_the_window_as_state_and_folders() {
        let ready = serde_json::to_value(Online::Ready { folders: vec!["notes".into()] }).unwrap();
        assert_eq!(ready["state"], "ready");
        assert_eq!(ready["folders"][0], "notes");
        assert_eq!(serde_json::to_value(Online::Failed { why: "no route".into() }).unwrap()["why"], "no route");
    }

    // The picker the window draws (Zach, 2026-11-04: like Obsidian's vault picker): create new, open existing, and one of
    // "your folders online"; Server under Advanced; Open online. The journey drives these ids (app/test/journey.mjs).
    #[test]
    fn the_window_offers_the_pickers_choices() {
        let page = include_str!("../../ui/index.html");
        for id in ["new-name", "new-location", "create-folder", "open-existing", "online-list", "join-folder", "server-input", "open-online", "change-folder"] {
            assert!(page.contains(&format!("data-testid=\"{id}\"")), "the window has no {id}");
        }
        assert!(page.contains("<details id=\"advanced\""), "Server sits under an Advanced disclosure");
        // a keychain sign-in with no email in settings.json still gets the picker (the real run's second computer)
        let script = include_str!("../../ui/app.js");
        assert!(script.contains("show(\"step-folder\", s.signed_in && s.picking)"));
        // the listener is registered before the snapshot is asked for, so no update is missed in between
        assert!(script.contains("listen(\"state\", (e) => render(e.payload)).then(() => invoke(\"snapshot\"))"));
    }

    #[test]
    fn local_hms_reads_rfc3339_without_a_date_command() {
        let shown = local_hms("2026-10-28T12:34:56Z").expect("a valid stamp");
        assert_eq!(shown.len(), 8);
        assert!(shown.ends_with(":34:56") || shown.ends_with(":04:56"), "{shown}"); // whole- or half-hour zones
        assert!(local_hms("not a time").is_none());
    }

    // A failed sign-in (a rate limit, the server down, a refused grant) used to land in the generic "Sync error"
    // screen, whose only buttons were Start at login and Quit (a real Windows test, 2026-10-29).
    #[test]
    fn a_failed_sign_in_is_its_own_state_with_a_way_back() {
        let failed = Status::SignInFailed { why: "Too many requests".into() };
        assert_eq!(failed.headline(), "Sign-in failed");
        assert_eq!(failed.detail().as_deref(), Some("Too many requests"));
        assert_eq!(failed.icon(), "error");
        assert_eq!(serde_json::to_value(&failed).unwrap()["state"], "sign_in_failed");

        // the window offers Sign in again and Cancel (back to signed out) for exactly that state
        let page = include_str!("../../ui/index.html");
        let script = include_str!("../../ui/app.js");
        let section = page.split("id=\"step-failed\"").nth(1).expect("a step-failed section").split("</section>").next().unwrap();
        assert!(section.contains("data-action=\"sign_in\""), "{section}");
        assert!(section.contains("data-action=\"cancel_sign_in\""), "{section}");
        assert!(script.contains("show(\"step-failed\", state === \"sign_in_failed\")"));
    }
}
