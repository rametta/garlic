//! Main window title — keep in sync with `tauri.conf.json` default and the UI.

use crate::active_repo;
use tauri::AppHandle;
use tauri::Manager;

pub const DEFAULT_WINDOW_TITLE: &str = "Garlic";

pub fn set_main_window_title(app: &AppHandle, title: &str) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let _ = w.set_title(title);
}

/// Native title: repository folder name plus the current branch (or detached HEAD short hash).
pub fn set_main_window_title_for_repo_head(
    app: &AppHandle,
    repo_name: &str,
    detached: bool,
    branch: Option<&str>,
    head_short: Option<&str>,
) {
    let branch_label = if detached {
        match head_short {
            Some(h) => format!("detached ({h})"),
            None => "detached".to_string(),
        }
    } else {
        branch.unwrap_or("—").to_string()
    };
    let title = format!("{repo_name} — {branch_label}");
    set_main_window_title(app, &title);
}

#[tauri::command]
pub fn reset_main_window_title(app: AppHandle) -> Result<(), String> {
    active_repo::set_path(&app, None);
    set_main_window_title(&app, DEFAULT_WINDOW_TITLE);
    Ok(())
}
