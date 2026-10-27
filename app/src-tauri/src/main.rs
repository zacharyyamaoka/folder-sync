//! folder-sync desktop (docs/peps/0005): sign in, and your folder is just there.
//!
//! `folder-sync-desktop`            the tray app (and its window)
//! `folder-sync-desktop --hidden`   the same, tray only (login autostart)
//! `folder-sync-desktop --account-process`   print the keychain's sign-in for the engine; exit 3 when signed out

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;
mod settings;
mod tray;
mod vault;

use crate::core::{Shared, Snapshot, Status};
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

fn open_site(app: &AppHandle) {
    let site = core::site_of(&app.state::<Shared>().lock().settings);
    core::open_url(app, &site);
}

fn choose_folder(app: &AppHandle) {
    let start = {
        let inner = app.state::<Shared>();
        let inner = inner.lock();
        inner.settings.folder.clone().unwrap_or_else(|| core::default_folder(app, &inner.settings.project))
    };
    let handle = app.clone();
    let mut dialog = app.dialog().file().set_title("Choose the folder to sync");
    if let Some(parent) = start.parent() {
        dialog = dialog.set_directory(parent);
    }
    dialog.pick_folder(move |picked| {
        if let Some(path) = picked.and_then(|p| p.into_path().ok()) {
            run_folder_change(&handle, path);
        }
    });
}

fn run_folder_change(app: &AppHandle, folder: std::path::PathBuf) {
    let app = app.clone();
    std::thread::spawn(move || {
        core::stop_engine(&app);
        let _ = core::use_folder(&app, folder);
    });
}

fn create_folder(app: &AppHandle) {
    let folder = {
        let inner = app.state::<Shared>();
        let inner = inner.lock();
        core::default_folder(app, &inner.settings.project)
    };
    run_folder_change(app, folder);
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
                core::set_status(&app, Status::Error { why });
            }
        }
        "reopen_link" => {
            let status = app.state::<Shared>().lock().status.clone();
            if let Status::SigningIn { link, .. } = status {
                core::open_url(&app, &link);
            }
        }
        "cancel_sign_in" => core::cancel_sign_in(&app),
        "create_folder" => create_folder(&app),
        "choose_folder" => choose_folder(&app),
        "open_folder" => open_folder(&app),
        "open_site" => open_site(&app),
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
        .invoke_handler(tauri::generate_handler![snapshot, action])
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
