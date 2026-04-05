//! Tracks the folder the UI last successfully inspected with `get_repo_metadata`, so native menus
//! can act without a round-trip through the webview.

use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Default)]
pub struct ActiveRepoPath(pub std::sync::Mutex<Option<PathBuf>>);

pub fn set_path(app: &AppHandle, path: Option<PathBuf>) {
    if let Some(s) = app.try_state::<ActiveRepoPath>() {
        if let Ok(mut g) = s.0.lock() {
            *g = path;
        }
    }
}

pub fn get_path(app: &AppHandle) -> Option<PathBuf> {
    app.try_state::<ActiveRepoPath>()
        .and_then(|state| state.0.lock().ok().and_then(|g| (*g).clone()))
}
