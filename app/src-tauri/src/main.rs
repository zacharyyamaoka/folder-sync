//! folder-sync desktop (docs/peps/0006): sign in, and your folder is just there.
//!
//! `folder-sync-desktop`            the tray app (and its window)
//! `folder-sync-desktop --hidden`   the same, tray only (login autostart)
//! `folder-sync-desktop --account-process`   print the keychain's sign-in for the engine; exit 3 when signed out

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;
mod settings;
mod tray;
mod vault;

use crate::core::{Online, Shared, Snapshot, Status};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_folder(app: &AppHandle) {
    let folder = app.state::<Shared>().lock().settings.folder.clone();
    if let Some(folder) = folder {
        let _ = app.opener().open_path(folder.to_string_lossy(), None::<&str>);
    }
}

fn open_online(app: &AppHandle) {
    let site = core::site_of(&app.state::<Shared>().lock().settings);
    core::open_url(app, &site);
}

/// The native folder dialog (the stock tauri-plugin-dialog), off the main thread: it blocks until the person answers.
async fn pick_folder(app: &AppHandle, title: &str, start: Option<PathBuf>) -> Option<PathBuf> {
    let app = app.clone();
    let title = title.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title(title);
        if let Some(start) = start.filter(|p| p.is_dir()) {
            dialog = dialog.set_directory(start);
        }
        dialog.blocking_pick_folder().and_then(|p| p.into_path().ok())
    })
    .await
    .ok()
    .flatten()
}

fn set_autostart(app: &AppHandle, on: bool) {
    let launcher = app.autolaunch();
    let _ = if on { launcher.enable() } else { launcher.disable() };
    core::refresh(app);
}

fn quit(app: &AppHandle) {
    app.state::<Shared>().lock().quitting = true;
    let app = app.clone();
    std::thread::spawn(move || {
        core::stop_engine(&app);
        if let Some(mut login) = app.state::<Shared>().lock().login.take() {
            let _ = login.kill();
        }
        app.exit(0);
    });
}

pub fn on_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    match id {
        "sign_in" => {
            if let Err(why) = core::sign_in(&app) {
                core::set_status(&app, Status::SignInFailed { why });
            }
        }
        "reopen_link" => {
            let status = app.state::<Shared>().lock().status.clone();
            if let Status::SigningIn { link, .. } = status {
                core::open_url(&app, &link);
            }
        }
        "cancel_sign_in" => core::cancel_sign_in(&app),
        "choose_folder" => core::open_picker(&app),
        "cancel_picker" => core::close_picker(&app),
        "open_folder" => open_folder(&app),
        "open_online" => open_online(&app),
        "pause" => {
            std::thread::spawn(move || core::set_paused(&app, true));
        }
        "resume" => {
            std::thread::spawn(move || core::set_paused(&app, false));
        }
        "show" => show_window(&app),
        "autostart" => {
            let on = !app.autolaunch().is_enabled().unwrap_or(false);
            set_autostart(&app, on);
        }
        "sign_out" => {
            std::thread::spawn(move || {
                if let Err(why) = core::sign_out(&app) {
                    core::set_status(&app, Status::Error { why });
                }
            });
        }
        "quit" => quit(&app),
        _ => {}
    }
}

// The window's commands: the same actions as the menu.
#[tauri::command]
fn snapshot(app: AppHandle) -> Snapshot {
    core::snapshot(&app)
}

/// The picker's commands. A failure comes back as the text the window shows under the button.
async fn background<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_folder(app: AppHandle, name: String, parent: String) -> Result<(), String> {
    background(move || core::create_folder(&app, &name, PathBuf::from(parent))).await
}

#[tauri::command]
async fn join_folder(app: AppHandle, project: String, parent: String) -> Result<(), String> {
    background(move || core::join_folder(&app, &project, PathBuf::from(parent))).await
}

/// "Open existing folder": the native dialog, then the folder is synced. Ok(false) when the person closed the dialog.
#[tauri::command]
async fn open_existing(app: AppHandle) -> Result<bool, String> {
    let start = Some(core::default_parent(&app).parent().map(PathBuf::from).unwrap_or_default());
    let Some(folder) = pick_folder(&app, "Open an existing folder", start).await else { return Ok(false) };
    background(move || core::open_existing_folder(&app, folder).map(|()| true)).await
}

/// A location for a new or downloaded folder: the native dialog, starting at `start`. None when it was closed.
#[tauri::command]
async fn pick_location(app: AppHandle, start: Option<String>) -> Option<String> {
    pick_folder(&app, "Choose where the folder goes", start.map(PathBuf::from)).await.map(|p| p.display().to_string())
}

#[tauri::command]
fn set_server(app: AppHandle, server: String) -> Result<(), String> {
    core::set_server(&app, &server)
}

#[tauri::command]
fn refresh_online(app: AppHandle) {
    core::refresh_online(&app);
}

#[tauri::command]
fn action(app: AppHandle, id: String, on: Option<bool>) {
    if id == "autostart" {
        set_autostart(&app, on.unwrap_or(true));
        return;
    }
    on_menu(&app, &id);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--account-process") {
        std::process::exit(vault::account_process());
    }
    let hidden = args.iter().any(|a| a == "--hidden");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_window(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .invoke_handler(tauri::generate_handler![snapshot, action, create_folder, join_folder, open_existing, pick_location, set_server, refresh_online])
        .setup(move |app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let settings_path = config_dir.join("settings.json");
            let settings = settings::Settings::load(&settings_path);
            app.manage(Shared(Arc::new(Mutex::new(core::Inner {
                settings,
                settings_path,
                log_path: data_dir.join("engine.log"),
                status: Status::SignedOut,
                signed_in: false,
                engine: None,
                generation: 0,
                login: None,
                quitting: false,
                online: Online::Idle,
                picking: false,
            }))));
            let handle = app.handle().clone();
            tray::create(&handle)?;
            core::boot(&handle);
            // First run (signed out) shows the window with its one button; autostart (--hidden) stays in the tray.
            let signed_out = matches!(handle.state::<Shared>().lock().status, Status::SignedOut);
            if !hidden || signed_out {
                show_window(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // WHY: closing the window leaves sync running in the tray, like every sync app; Quit is in the menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("folder-sync desktop failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // keep running in the tray when the last window hides; an explicit Quit passes a code
                if code.is_none() && !app.state::<Shared>().lock().quitting {
                    api.prevent_exit();
                }
            }
        });
}
