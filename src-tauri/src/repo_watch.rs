//! Debounced filesystem watch for the open repo; emits `repository-mutated` when files change.

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

pub struct RepoWatchState(pub Mutex<Option<RepoWatchGuard>>);

pub struct RepoWatchGuard {
    _watcher: RecommendedWatcher,
}

impl Default for RepoWatchState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn path_is_internal_git_artifact(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|relative| relative.components().next())
        .is_some_and(|component| component.as_os_str() == ".git")
}

/// Stop any previous watch and watch `path` recursively (debounced).
#[tauri::command]
pub fn start_repo_watch(app: AppHandle, path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("Path is empty.".to_string());
    }
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err("Not a directory.".to_string());
    }

    let state = app.state::<RepoWatchState>();
    let mut g = state
        .0
        .lock()
        .map_err(|e: std::sync::PoisonError<_>| e.to_string())?;
    *g = None;

    let (tx, rx) = mpsc::channel();
    let watch_root = root.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Access(_)) {
                    return;
                }
                if !ev.paths.is_empty()
                    && ev
                        .paths
                        .iter()
                        .all(|path| path_is_internal_git_artifact(&watch_root, path))
                {
                    return;
                }
                let _ = tx.send(());
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Could not start file watcher: {e}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("Could not watch repository: {e}"))?;

    *g = Some(RepoWatchGuard { _watcher: watcher });

    let app_emit = app.clone();
    std::thread::spawn(move || {
        const DEBOUNCE: Duration = Duration::from_millis(450);
        loop {
            match rx.recv() {
                Ok(()) => {}
                Err(_) => break,
            }
            while rx.try_recv().is_ok() {}
            std::thread::sleep(DEBOUNCE);
            while rx.try_recv().is_ok() {}
            let _ = app_emit.emit("repository-mutated", ());
        }
    });

    Ok(())
}
