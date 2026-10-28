//! The session token lives in the OS keychain and nowhere else (Secret Service on Linux, Keychain on macOS,
//! Credential Manager on Windows), through the stock `keyring` crate.
//!
//! WHY the whole folder-sync-account/1 document as the secret: the engine asks for it through
//! FOLDER_SYNC_ACCOUNT_PROCESS (`folder-sync-desktop --account-process`, docs/peps/0006), so the app never writes
//! account.json, and the token never touches the disk in plain text.

use keyring::Entry;

const SERVICE: &str = "dev.folder-sync.desktop";

/// One keychain entry per server. WHY: a sign-in to a local or staging stack must never be picked up by a run against
/// robotparts.dev (or the other way round); the document names its server, and the engine would follow it.
fn entry(server: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("session@{}", server.trim_end_matches('/'))).map_err(|e| format!("the keychain is not available: {e}"))
}

/// The server the app (and the engine it starts) talks to: $FOLDER_SYNC_SERVER, which the app sets for every engine
/// it runs, else the default.
pub fn server_from_env() -> String {
    std::env::var("FOLDER_SYNC_SERVER").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| crate::settings::DEFAULT_SERVER.to_string())
}

/// The stored folder-sync-account/1 document for `server`, or None when this machine is not signed in there.
pub fn load(server: &str) -> Result<Option<String>, String> {
    match entry(server)?.get_password() {
        Ok(doc) => Ok(Some(doc)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("the keychain did not answer: {e}")),
    }
}

pub fn store(server: &str, doc: &str) -> Result<(), String> {
    entry(server)?
        .set_password(doc)
        .map_err(|e| format!("the keychain refused the sign-in: {e}"))
}

pub fn forget(server: &str) -> Result<(), String> {
    match entry(server)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("the keychain did not forget the sign-in: {e}")),
    }
}

/// `folder-sync-desktop --account-process`: print the sign-in for the engine (exit 0), or exit 3 when there is none
/// (folder-sync's "not signed in"), or 1 when the keychain cannot be read. Nothing but the document goes to stdout.
pub fn account_process() -> i32 {
    match load(&server_from_env()) {
        Ok(Some(doc)) => {
            print!("{doc}");
            0
        }
        Ok(None) => {
            eprintln!("folder-sync-desktop: not signed in");
            3
        }
        Err(e) => {
            eprintln!("folder-sync-desktop: {e}");
            1
        }
    }
}
