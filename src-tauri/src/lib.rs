mod active_repo;
mod git;
mod settings;
mod window_title;

use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, Submenu};
use tauri::Emitter;
use tauri::Manager;
use tauri::WindowEvent;
use tauri::Wry;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[derive(Clone)]
struct ThemeMenuState {
    checks: Vec<CheckMenuItem<Wry>>,
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
            git::checkout_local_branch,
            git::create_local_branch,
            git::create_branch_from_remote,
            git::list_working_tree_files,
            git::stage_paths,
            git::unstage_paths,
            git::commit_staged,
            git::push_to_origin,
            settings::restore_app_bootstrap,
            settings::set_last_repo_path,
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
            let file_menu = Submenu::with_items(app, "File", true, &[&open_repo])?;

            let repo_metadata = MenuItem::with_id(app, "repo_metadata", "Repo Metadata", true, None::<&str>)?;
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

            let menu = Menu::with_items(app, &[&file_menu, &repo_menu, &theme_submenu])?;
            menu.set_as_app_menu()?;
            Ok(())
        })
        .on_menu_event(|app, event| {
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
