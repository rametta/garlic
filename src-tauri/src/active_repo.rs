//! Tracks the folder the UI last successfully inspected with `get_repo_metadata`, so native menus
//! can act without a round-trip through the webview.

use tauri::AppHandle;
use tauri::Manager;

#[derive(Default)]
pub struct ActiveRepoPath(pub std::sync::Mutex<Option<String>>);

pub fn set_path(app: &AppHandle, path: Option<String>) {
    if let Some(s) = app.try_state::<ActiveRepoPath>() {
        if let Ok(mut g) = s.0.lock() {
            *g = path;
        }
    }
}
