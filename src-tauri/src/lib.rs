mod git;

use tauri::menu::{Menu, MenuEvent, MenuItem, Submenu};
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            git::get_repo_metadata,
            git::list_local_branches,
            git::list_remote_branches,
            git::list_branch_commits,
            git::checkout_local_branch,
            git::create_branch_from_remote,
        ])
        .setup(|app| {
            let open_repo = MenuItem::with_id(
                app,
                "open_repo",
                "Open Repository…",
                true,
                Some("CmdOrCtrl+O"),
            )?;
            let file_menu = Submenu::with_items(app, "File", true, &[&open_repo])?;
            let menu = Menu::with_items(app, &[&file_menu])?;
            menu.set_as_app_menu()?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if menu_id_is(&event, "open_repo") {
                let _ = app.emit("open-repo-request", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn menu_id_is(event: &MenuEvent, id: &str) -> bool {
    event.id().as_ref() == id
}
