//! Debounced filesystem watch for the open repo; emits `repository-mutated` when files change.
//! Also runs a periodic `git fetch --all` in a background thread while a repo is watched.

use crate::git::{schedule_fetch_all_remotes, AutoFetchInFlight};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

const AUTO_FETCH_INTERVAL: Duration = Duration::from_secs(5 * 60);

pub struct RepoWatchState(pub Mutex<Option<RepoWatchGuard>>);

pub struct RepoWatchGuard {
    _watcher: RecommendedWatcher,
    /// Held so dropping the guard disconnects the auto-fetch thread’s stop channel.
    _auto_fetch_stop: mpsc::Sender<()>,
}

impl Default for RepoWatchState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn path_is_ignored_git_artifact(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut components = relative.components();
    let Some(first) = components.next() else {
        return false;
    };
    if first.as_os_str() != ".git" {
        return false;
    }
    let Some(second) = components.next() else {
        return false;
    };
    match second.as_os_str().to_str() {
        // Object writes are extremely noisy during fetch/commit, and the corresponding ref/index
        // updates we do care about arrive alongside them.
        Some("objects" | "hooks" | "info" | "logs" | "lfs") => true,
        Some(name) if name.ends_with(".lock") => true,
        _ => false,
    }
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
                        .all(|path| path_is_ignored_git_artifact(&watch_root, path))
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

    let (auto_fetch_stop_tx, auto_fetch_stop_rx) = mpsc::channel::<()>();
    let path_for_auto_fetch = root.clone();
    let in_flight = app.state::<AutoFetchInFlight>().inner().clone();
    // Fresh remote refs as soon as a repo is opened or switched (same as periodic auto-fetch).
    let _ = schedule_fetch_all_remotes(root.clone(), &in_flight);
    std::thread::spawn(move || {
        loop {
            match auto_fetch_stop_rx.recv_timeout(AUTO_FETCH_INTERVAL) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let _ = schedule_fetch_all_remotes(path_for_auto_fetch.clone(), &in_flight);
                }
            }
        }
    });

    *g = Some(RepoWatchGuard {
        _watcher: watcher,
        _auto_fetch_stop: auto_fetch_stop_tx,
    });

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
