//! settings.json in the app's config dir: where the folder is, which server, whether sync is paused, and who is
//! signed in (email and id only, for the menu). WHY no token here: it is in the keychain (vault.rs).
//!
//! WHY the default server is vibetracks.dev (Zach, 2026-11-04): his own account and the Files page live there. A
//! robotparts.dev (or any other) deployment serves the same /fs/ and is chosen under Advanced in the first-run window.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_SERVER: &str = "https://vibetracks.dev";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Settings {
    /// The server the person chose under Advanced; empty means the default. Read it through `server()`.
    #[serde(default)]
    pub server: String,
    /// The synced folder's project, which is the folder's name (or the online folder that was picked).
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub folder: Option<PathBuf>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    /// Set once the app has turned login autostart on by itself (the first sign-in); after that it is the person's.
    #[serde(default)]
    pub autostart_decided: bool,
}

impl Settings {
    pub fn load(path: &Path) -> Settings {
        let mut s: Settings = std::fs::read(path)
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        // WHY a settings file from the 0.1 app is dropped back to the default: it wrote the default into `server`
        // (robotparts.dev), and nobody chose that.
        if s.server == "https://robotparts.dev" {
            s.server.clear();
        }
        s
    }

    /// The server in use. WHY the environment wins: a dev or test run (FOLDER_SYNC_SERVER=http://127.0.0.1:4933) must
    /// never reach production because a settings file says so. It is never written into settings.json.
    pub fn server(&self) -> String {
        match std::env::var("FOLDER_SYNC_SERVER") {
            Ok(server) if !server.is_empty() => server,
            _ if !self.server.is_empty() => self.server.clone(),
            _ => DEFAULT_SERVER.to_string(),
        }
    }

    /// True when FOLDER_SYNC_SERVER decides the server, so the Advanced field cannot change it.
    pub fn server_locked() -> bool {
        std::env::var("FOLDER_SYNC_SERVER").map(|s| !s.is_empty()).unwrap_or(false)
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let data = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_server_is_vibetracks_and_a_0_1_settings_file_does_not_pin_robotparts() {
        let dir = std::env::temp_dir().join(format!("fs-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, br#"{"server":"https://robotparts.dev","project":"robotparts"}"#).unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.server, "");
        assert_eq!(loaded.project.as_deref(), Some("robotparts"));
        if std::env::var("FOLDER_SYNC_SERVER").is_err() {
            assert_eq!(loaded.server(), "https://vibetracks.dev");
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
