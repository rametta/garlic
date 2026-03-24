//! Main window title — keep in sync with `tauri.conf.json` default and the UI.

use crate::active_repo;
use tauri::AppHandle;
use tauri::Manager;

pub const DEFAULT_WINDOW_TITLE: &str = "Git GUI";

pub fn set_main_window_title(app: &AppHandle, title: &str) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let _ = w.set_title(title);
}

#[tauri::command]
pub fn reset_main_window_title(app: AppHandle) -> Result<(), String> {
    active_repo::set_path(&app, None);
    set_main_window_title(&app, DEFAULT_WINDOW_TITLE);
    Ok(())
}
