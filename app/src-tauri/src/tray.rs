//! The tray icon and its menu, rebuilt from a Snapshot on every state change.

use crate::core::{self, Snapshot, Status};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

const TRAY_ID: &str = "main";

pub fn icon(name: &str) -> Image<'static> {
    let bytes: &'static [u8] = match name {
        "synced" => include_bytes!("../icons/tray/synced.png"),
        "syncing" => include_bytes!("../icons/tray/syncing.png"),
        "offline" => include_bytes!("../icons/tray/offline.png"),
        "over_quota" => include_bytes!("../icons/tray/over_quota.png"),
        "paused" => include_bytes!("../icons/tray/paused.png"),
        "error" => include_bytes!("../icons/tray/error.png"),
        _ => include_bytes!("../icons/tray/signed_out.png"),
    };
    Image::from_bytes(bytes).expect("tray icons are PNGs")
}

/// Cut a reason to fit a menu line (the window shows it whole).
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max - 1).collect();
    format!("{cut}…")
}

fn menu(app: &AppHandle, snap: &Snapshot) -> tauri::Result<Menu<Wry>> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    let label = |id: &str, text: &str| MenuItem::with_id(app, id, text, false, None::<&str>);
    let action = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);

    items.push(Box::new(label("status", &snap.headline)?));
    if let Some(detail) = &snap.detail {
        items.push(Box::new(label("detail", &clip(detail, 72))?));
    }
    if let Some(email) = &snap.email {
        items.push(Box::new(label("who", &format!("Signed in as {email}"))?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));

    match &snap.status {
        Status::SignedOut => items.push(Box::new(action("sign_in", "Sign in…")?)),
        Status::SigningIn { .. } => {
            items.push(Box::new(action("reopen_link", "Open the approval page again")?));
            items.push(Box::new(action("cancel_sign_in", "Cancel sign-in")?));
        }
        Status::NeedsFolder => {
            items.push(Box::new(action("create_folder", &format!("Create folder {}", snap.default_folder))?));
            items.push(Box::new(action("choose_folder", "Choose folder…")?));
        }
        _ => {}
    }
    if snap.folder.is_some() && snap.email.is_some() {
        items.push(Box::new(action("open_folder", "Open folder")?));
        items.push(Box::new(action("open_site", "Open robotparts.dev")?));
        if snap.paused {
            items.push(Box::new(action("resume", "Resume sync")?));
        } else {
            items.push(Box::new(action("pause", "Pause sync")?));
        }
        items.push(Box::new(action("choose_folder", "Change folder…")?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(action("show", "Show window")?));
    items.push(Box::new(CheckMenuItem::with_id(app, "autostart", "Start at login", true, snap.autostart, None::<&str>)?));
    if snap.email.is_some() {
        items.push(Box::new(action("sign_out", "Sign out")?));
    }
    items.push(Box::new(action("quit", "Quit folder-sync")?));

    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let snap = core::snapshot(app);
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(snap.icon))
        .tooltip(format!("folder-sync: {}", snap.headline))
        .menu(&menu(app, &snap)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| crate::on_menu(app, event.id.as_ref()))
        .build(app)?;
    Ok(())
}

pub fn update(app: &AppHandle, snap: &Snapshot) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let _ = tray.set_icon(Some(icon(snap.icon)));
    let _ = tray.set_tooltip(Some(format!("folder-sync: {}", snap.headline)));
    if let Ok(m) = menu(app, snap) {
        let _ = tray.set_menu(Some(m));
    }
    let _ = app.get_webview_window("main"); // keep Manager in use on every platform
}
