mod active_repo;
mod git;
mod settings;
mod window_title;

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, Submenu};
use tauri::Emitter;
use tauri::Manager;
use tauri::WindowEvent;
use tauri::Wry;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const RECENT_MENU_SLOTS: usize = settings::MAX_RECENT_REPO_PATHS;

#[derive(Clone)]
struct RecentMenuState {
    items: Vec<MenuItem<Wry>>,
}

#[derive(Clone)]
struct ThemeMenuState {
    checks: Vec<CheckMenuItem<Wry>>,
}

fn format_recent_menu_label(path: &str) -> String {
    const MAX: usize = 72;
    let path = path.trim();
    if path.chars().count() <= MAX {
        return path.to_string();
    }
    const HEAD: usize = 34;
    const TAIL: usize = 34;
    let chars: Vec<char> = path.chars().collect();
    let n = chars.len();
    let start: String = chars.iter().take(HEAD).collect();
    let end: String = chars.iter().skip(n.saturating_sub(TAIL)).collect();
    format!("{start} … {end}")
}

fn sync_recent_menu(app: &tauri::AppHandle) {
    let paths = settings::recent_repo_paths(app);
    let Some(state) = app.try_state::<RecentMenuState>() else {
        return;
    };
    for (i, item) in state.items.iter().enumerate() {
        if let Some(p) = paths.get(i) {
            let _ = item.set_text(format_recent_menu_label(p));
            let _ = item.set_enabled(true);
        } else {
            let _ = item.set_text(" ");
            let _ = item.set_enabled(false);
        }
    }
}

#[tauri::command]
fn set_last_repo_path(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    settings::persist_last_repo_path(&app, path)?;
    sync_recent_menu(&app);
    Ok(())
}

fn format_theme_label(name: &str) -> String {
    let mut c = name.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().chain(c).collect(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            window_title::reset_main_window_title,
            git::get_repo_metadata,
            git::list_local_branches,
            git::list_remote_branches,
            git::list_branch_commits,
            git::list_graph_commits,
            git::checkout_local_branch,
            git::create_local_branch,
            git::create_branch_from_remote,
            git::delete_local_branch,
            git::rebase_current_branch_onto,
            git::list_working_tree_files,
            git::stage_paths,
            git::unstage_paths,
            git::commit_staged,
            git::get_staged_diff,
            git::get_unstaged_diff,
            git::list_commit_files,
            git::get_commit_signature_status,
            git::get_commit_file_diff,
            git::push_to_origin,
            git::list_stashes,
            git::stash_push,
            git::stash_pop,
            git::stash_drop,
            settings::restore_app_bootstrap,
            set_last_repo_path,
            settings::set_theme,
        ])
        .setup(|app| {
            app.manage(active_repo::ActiveRepoPath::default());

            let open_repo = MenuItem::with_id(
                app,
                "open_repo",
                "Open Repository…",
                true,
                Some("CmdOrCtrl+O"),
            )?;

            let mut recent_items: Vec<MenuItem<Wry>> = Vec::new();
            for i in 0..RECENT_MENU_SLOTS {
                let id = format!("recent_repo_{i}");
                let item = MenuItem::with_id(app, id, " ", false, None::<&str>)?;
                recent_items.push(item);
            }
            let recent_submenu = Submenu::with_items(
                app,
                "Open Recent",
                true,
                &[
                    &recent_items[0] as &dyn IsMenuItem<Wry>,
                    &recent_items[1] as &dyn IsMenuItem<Wry>,
                    &recent_items[2] as &dyn IsMenuItem<Wry>,
                    &recent_items[3] as &dyn IsMenuItem<Wry>,
                    &recent_items[4] as &dyn IsMenuItem<Wry>,
                ],
            )?;

            let file_menu = Submenu::with_items(app, "File", true, &[&open_repo, &recent_submenu])?;

            let repo_metadata =
                MenuItem::with_id(app, "repo_metadata", "Repo Metadata", true, None::<&str>)?;
            let repo_menu = Submenu::with_items(app, "Repository", true, &[&repo_metadata])?;

            let current = settings::persisted_theme_preference(&app.handle());
            let mut checks = Vec::new();
            let auto_item = CheckMenuItem::with_id(
                app,
                "theme_auto",
                "Auto",
                true,
                current == "auto",
                None::<&str>,
            )?;
            checks.push(auto_item);
            for name in settings::DAISY_THEMES {
                let id = format!("theme_{name}");
                let checked = *name == current.as_str();
                let item = CheckMenuItem::with_id(
                    app,
                    &id,
                    format_theme_label(name),
                    true,
                    checked,
                    None::<&str>,
                )?;
                checks.push(item);
            }
            let theme_submenu = Submenu::new(app, "Theme", true)?;
            for item in &checks {
                theme_submenu.append(item)?;
            }
            app.manage(ThemeMenuState { checks });
            app.manage(RecentMenuState {
                items: recent_items,
            });
            sync_recent_menu(app.handle());

            let menu = Menu::with_items(app, &[&file_menu, &repo_menu, &theme_submenu])?;
            menu.set_as_app_menu()?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(idx_str) = id.strip_prefix("recent_repo_") {
                if let Ok(i) = idx_str.parse::<usize>() {
                    if i < RECENT_MENU_SLOTS {
                        let paths = settings::recent_repo_paths(app);
                        if let Some(path) = paths.get(i) {
                            let _ = app.emit("open-recent-repo", path.as_str());
                        }
                    }
                }
                return;
            }
            if menu_id_is(&event, "open_repo") {
                let _ = app.emit("open-repo-request", ());
                return;
            }
            if menu_id_is(&event, "repo_metadata") {
                let handle = app.clone();
                let path_opt = handle
                    .try_state::<active_repo::ActiveRepoPath>()
                    .and_then(|state| state.0.lock().ok().map(|g| (*g).clone()).flatten());
                let Some(path) = path_opt else {
                    handle
                        .dialog()
                        .message("No repository is open.")
                        .title("Repo Metadata")
                        .kind(MessageDialogKind::Info)
                        .show(|_| {});
                    return;
                };
                match git::get_repo_metadata(handle.clone(), path.clone()) {
                    Ok(meta) => {
                        let text = git::format_repo_metadata_plain_text(&meta);
                        handle
                            .dialog()
                            .message(text)
                            .title("Repo Metadata")
                            .kind(MessageDialogKind::Info)
                            .show(|_| {});
                    }
                    Err(e) => {
                        handle
                            .dialog()
                            .message(e)
                            .title("Repo Metadata")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                }
                return;
            }
            let id = event.id().as_ref();
            let Some(theme) = id.strip_prefix("theme_") else {
                return;
            };
            if settings::set_theme(app.clone(), theme.to_string()).is_err() {
                return;
            }
            if let Some(state) = app.try_state::<ThemeMenuState>() {
                if let Some(auto_check) = state.checks.first() {
                    let _ = auto_check.set_checked(theme == "auto");
                }
                for (i, name) in settings::DAISY_THEMES.iter().enumerate() {
                    if let Some(check) = state.checks.get(i + 1) {
                        let _ = check.set_checked(*name == theme);
                    }
                }
            }
            let _ = app.emit("theme-changed", serde_json::json!({ "theme": theme }));
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                let _ = window.app_handle().emit("window-focused", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn menu_id_is(event: &MenuEvent, id: &str) -> bool {
    event.id().as_ref() == id
}
