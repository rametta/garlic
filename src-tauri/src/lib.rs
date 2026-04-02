mod active_repo;
mod git;
mod open_in_cursor;
mod repo_watch;
mod settings;
mod window_title;

use tauri::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::Emitter;
use tauri::Manager;
use tauri::Wry;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const RECENT_MENU_SLOTS: usize = settings::MAX_RECENT_REPO_PATHS;

#[derive(Clone)]
struct RecentMenuState {
    items: Vec<MenuItem<Wry>>,
}

#[derive(Clone)]
struct ThemeMenuState {
    checks: Vec<CheckMenuItem<Wry>>,
}

#[derive(Clone)]
struct ViewMenuState {
    highlight_active_branch_rows: CheckMenuItem<Wry>,
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

/// Writes the given UTF-8 text to a path chosen by the user (e.g. export list).
#[tauri::command]
fn write_export_text_file(path: String, contents: String) -> Result<(), String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("Path is empty".to_string());
    }
    std::fs::write(p, contents.as_bytes()).map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            window_title::reset_main_window_title,
            git::get_repo_metadata,
            git::start_clone_repository,
            git::list_local_branches,
            git::list_remote_branches,
            git::list_tags,
            git::list_branch_commits,
            git::list_graph_commits,
            git::checkout_local_branch,
            git::create_local_branch,
            git::create_branch_at_commit,
            git::create_tag,
            git::delete_tag,
            git::create_branch_from_remote,
            git::delete_local_branch,
            git::delete_remote_branch,
            git::get_remote_url,
            git::set_remote_url,
            git::rebase_current_branch_onto,
            git::drop_commit,
            git::squash_commits,
            git::list_working_tree_files,
            git::list_worktrees,
            git::remove_worktree,
            git::stage_paths,
            git::stage_patch,
            git::unstage_paths,
            git::unstage_patch,
            git::discard_patch,
            git::discard_path_changes,
            git::commit_staged,
            git::amend_last_commit,
            git::reword_commit,
            git::merge_branch,
            git::cherry_pick_commit,
            git::list_file_history,
            git::get_file_blame,
            git::get_staged_diff,
            git::get_staged_diff_all,
            git::get_unstaged_diff,
            git::get_commit_details,
            git::list_commit_files,
            git::start_commit_signature_check,
            git::get_commit_file_diff,
            git::get_commit_file_blob_pair,
            git::get_staged_file_blob_pair,
            git::get_unstaged_file_blob_pair,
            git::pull_local_branch,
            git::push_to_origin,
            git::push_tag_to_origin,
            git::tag_origin_status,
            git::delete_remote_tag,
            git::force_push_to_origin,
            git::list_stashes,
            git::stash_push,
            git::stash_pop,
            git::stash_drop,
            settings::restore_app_bootstrap,
            set_last_repo_path,
            settings::set_theme,
            settings::set_branch_sidebar_sections,
            settings::get_graph_branch_visibility,
            settings::set_graph_branch_visibility,
            settings::set_openai_settings,
            write_export_text_file,
            open_in_cursor::open_in_cursor,
            repo_watch::start_repo_watch,
        ])
        .setup(|app| {
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            app.manage(active_repo::ActiveRepoPath::default());
            app.manage(repo_watch::RepoWatchState::default());
            if let Ok(dir) = app.path().app_config_dir() {
                let _ = std::fs::create_dir_all(&dir);
                git::set_git_audit_log_path(Some(dir.join("git-audit.log")));
            }

            let open_repo = MenuItem::with_id(
                app,
                "open_repo",
                "Open Repository…",
                true,
                Some("CmdOrCtrl+O"),
            )?;
            let clone_repo = MenuItem::with_id(
                app,
                "clone_repo",
                "Clone Repository…",
                true,
                None::<&str>,
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

            let configure_openai_key = MenuItem::with_id(
                app,
                "configure_openai_key",
                "Configure OpenAI API Key…",
                true,
                None::<&str>,
            )?;
            let check_for_updates = MenuItem::with_id(
                app,
                "check_for_updates",
                "Check for Updates…",
                true,
                None::<&str>,
            )?;
            let reveal_settings_file = MenuItem::with_id(
                app,
                "reveal_settings_file",
                "Show Settings File…",
                true,
                None::<&str>,
            )?;
            let about_app = PredefinedMenuItem::about(app, None, None)?;
            let quit_app = PredefinedMenuItem::quit(app, None)?;
            let garlic_menu = Submenu::with_items(
                app,
                "Garlic",
                true,
                &[
                    &about_app,
                    &PredefinedMenuItem::separator(app)?,
                    &check_for_updates,
                    &PredefinedMenuItem::separator(app)?,
                    &configure_openai_key,
                    &reveal_settings_file,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_app,
                ],
            )?;

            let file_menu =
                Submenu::with_items(app, "File", true, &[&open_repo, &clone_repo, &recent_submenu])?;

            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;

            let repo_metadata =
                MenuItem::with_id(app, "repo_metadata", "Repo Metadata", true, None::<&str>)?;
            let new_branch = MenuItem::with_id(
                app,
                "new_branch",
                "New Branch…",
                true,
                None::<&str>,
            )?;
            let stash_push_menu = MenuItem::with_id(app, "stash_push_menu", "Stash", true, None::<&str>)?;
            let force_push = MenuItem::with_id(
                app,
                "force_push",
                "Force Push…",
                true,
                None::<&str>,
            )?;
            let repo_menu = Submenu::with_items(
                app,
                "Repository",
                true,
                &[&repo_metadata, &new_branch, &stash_push_menu, &force_push],
            )?;

            let highlight_active_branch_rows = CheckMenuItem::with_id(
                app,
                "view_highlight_active_branch_rows",
                "Highlight Active Branch Rows",
                true,
                settings::persisted_highlight_active_branch_rows(&app.handle()),
                None::<&str>,
            )?;
            let view_menu =
                Submenu::with_items(app, "View", true, &[&highlight_active_branch_rows])?;

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
            app.manage(ViewMenuState {
                highlight_active_branch_rows,
            });
            app.manage(RecentMenuState {
                items: recent_items,
            });
            sync_recent_menu(app.handle());

            let menu = Menu::with_items(
                app,
                &[&garlic_menu, &file_menu, &edit_menu, &repo_menu, &view_menu, &theme_submenu],
            )?;
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
            if menu_id_is(&event, "configure_openai_key") {
                // Defer emit so the native menu handler returns before the webview runs JS
                // (`showModal` + focus); synchronous emit from the menu callback can deadlock on macOS.
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle.emit("open-openai-settings", ());
                });
                return;
            }
            if menu_id_is(&event, "check_for_updates") {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle.emit("check-for-updates-request", ());
                });
                return;
            }
            if menu_id_is(&event, "reveal_settings_file") {
                if let Err(e) = settings::reveal_settings_file_in_explorer(&app) {
                    let handle = app.clone();
                    handle
                        .dialog()
                        .message(e)
                        .title("Garlic")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
                return;
            }
            if menu_id_is(&event, "open_repo") {
                let _ = app.emit("open-repo-request", ());
                return;
            }
            if menu_id_is(&event, "clone_repo") {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle.emit("clone-repo-request", ());
                });
                return;
            }
            if menu_id_is(&event, "new_branch") {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle.emit("new-branch-request", ());
                });
                return;
            }
            if menu_id_is(&event, "stash_push_menu") {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle.emit("stash-push-request", ());
                });
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
            if menu_id_is(&event, "force_push") {
                let handle = app.clone();
                let path_opt = handle
                    .try_state::<active_repo::ActiveRepoPath>()
                    .and_then(|state| state.0.lock().ok().map(|g| (*g).clone()).flatten());
                let Some(path) = path_opt else {
                    handle
                        .dialog()
                        .message("No repository is open.")
                        .title("Force Push")
                        .kind(MessageDialogKind::Info)
                        .show(|_| {});
                    return;
                };
                let branch_name = match git::current_branch_name(&path) {
                    Ok(n) => n,
                    Err(e) => {
                        handle
                            .dialog()
                            .message(e)
                            .title("Force Push")
                            .kind(MessageDialogKind::Warning)
                            .show(|_| {});
                        return;
                    }
                };
                let msg = format!(
                    r#"Force push "{branch_name}" to origin? This runs git push --force-with-lease: the remote branch will be updated to match your local tip, but only if the remote has not received new commits (otherwise the push is rejected)."#
                );
                let handle_confirm = handle.clone();
                let path_for_push = path.clone();
                handle
                    .dialog()
                    .message(msg)
                    .title("Garlic")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::YesNo)
                    .show(move |confirmed| {
                        if !confirmed {
                            return;
                        }
                        let h = handle_confirm.clone();
                        tauri::async_runtime::spawn(async move {
                            match git::force_push_to_origin(h.clone(), path_for_push, false).await {
                                Ok(()) => {
                                    let _ = h.emit("repository-mutated", ());
                                }
                                Err(e) => {
                                    h.dialog()
                                        .message(e)
                                        .title("Force Push")
                                        .kind(MessageDialogKind::Error)
                                        .show(|_| {});
                                }
                            }
                        });
                    });
                return;
            }
            if menu_id_is(&event, "view_highlight_active_branch_rows") {
                let next = !settings::persisted_highlight_active_branch_rows(app);
                if settings::set_highlight_active_branch_rows(app, next).is_err() {
                    return;
                }
                if let Some(state) = app.try_state::<ViewMenuState>() {
                    let _ = state.highlight_active_branch_rows.set_checked(next);
                }
                let _ = app.emit(
                    "graph-active-branch-row-background-changed",
                    serde_json::json!({ "enabled": next }),
                );
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn menu_id_is(event: &MenuEvent, id: &str) -> bool {
    event.id().as_ref() == id
}
