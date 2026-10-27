//! The session token lives in the OS keychain and nowhere else (Secret Service on Linux, Keychain on macOS,
//! Credential Manager on Windows), through the stock `keyring` crate.
//!
//! WHY the whole folder-sync-account/1 document as the secret: the engine asks for it through
//! FOLDER_SYNC_ACCOUNT_PROCESS (`folder-sync-desktop --account-process`, docs/peps/0005), so the app never writes
//! account.json, and the token never touches the disk in plain text.

use keyring::Entry;

const SERVICE: &str = "dev.folder-sync.desktop";
const USER: &str = "session";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, USER).map_err(|e| format!("the keychain is not available: {e}"))
}

/// The stored folder-sync-account/1 document, or None when this machine is not signed in.
pub fn load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(doc) => Ok(Some(doc)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("the keychain did not answer: {e}")),
    }
}

pub fn store(doc: &str) -> Result<(), String> {
    entry()?
        .set_password(doc)
        .map_err(|e| format!("the keychain refused the sign-in: {e}"))
}

pub fn forget() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("the keychain did not forget the sign-in: {e}")),
    }
}

/// `folder-sync-desktop --account-process`: print the sign-in for the engine (exit 0), or exit 3 when there is none
/// (folder-sync's "not signed in"), or 1 when the keychain cannot be read. Nothing but the document goes to stdout.
pub fn account_process() -> i32 {
    match load() {
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
