//! settings.json in the app's config dir: where the folder is, which server, whether sync is paused, and who is
//! signed in (email and id only, for the menu). WHY no token here: it is in the keychain (vault.rs).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_PROJECT: &str = "robotparts";
pub const DEFAULT_SERVER: &str = "https://robotparts.dev";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub project: String,
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
        // WHY the environment wins for the server: a dev or test run (FOLDER_SYNC_SERVER=http://127.0.0.1:4933) must
        // never reach production because a settings file says so.
        if let Ok(server) = std::env::var("FOLDER_SYNC_SERVER") {
            if !server.is_empty() {
                s.server = server;
            }
        }
        if s.server.is_empty() {
            s.server = DEFAULT_SERVER.to_string();
        }
        if s.project.is_empty() {
            s.project = DEFAULT_PROJECT.to_string();
        }
        s
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
