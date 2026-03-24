use crate::git;
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Debug, Default, Serialize, Deserialize)]
struct AppSettings {
    #[serde(default)]
    last_repo_path: Option<String>,
    #[serde(default)]
    theme: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

fn clear_last_repo_path(app: &AppHandle) -> Result<(), String> {
    let mut s = load_settings(app)?;
    s.last_repo_path = None;
    save_settings(app, &s)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreLastRepo {
    pub load_error: Option<String>,
    pub metadata: Option<git::RepoMetadata>,
    pub local_branches: Vec<String>,
    pub remote_branches: Vec<String>,
    pub commits: Vec<git::CommitEntry>,
    pub lists_error: Option<String>,
}

impl RestoreLastRepo {
    fn empty() -> Self {
        Self {
            load_error: None,
            metadata: None,
            local_branches: Vec::new(),
            remote_branches: Vec::new(),
            commits: Vec::new(),
            lists_error: None,
        }
    }
}

fn restore_repo_snapshot(app: &AppHandle, settings: &AppSettings) -> Result<RestoreLastRepo, String> {
    let Some(path) = settings.last_repo_path.clone() else {
        return Ok(RestoreLastRepo::empty());
    };

    match git::get_repo_metadata(path.clone()) {
        Ok(meta) => {
            if meta.error.is_some() {
                clear_last_repo_path(app)?;
                return Ok(RestoreLastRepo {
                    metadata: Some(meta),
                    ..RestoreLastRepo::empty()
                });
            }

            let locals = git::list_local_branches(path.clone());
            let remotes = git::list_remote_branches(path.clone());
            let commits = git::list_branch_commits(path.clone());

            let lists_error = locals
                .as_ref()
                .err()
                .cloned()
                .or(remotes.as_ref().err().cloned())
                .or(commits.as_ref().err().cloned());

            Ok(RestoreLastRepo {
                load_error: None,
                metadata: Some(meta),
                local_branches: locals.unwrap_or_default(),
                remote_branches: remotes.unwrap_or_default(),
                commits: commits.unwrap_or_default(),
                lists_error,
            })
        }
        Err(e) => {
            clear_last_repo_path(app)?;
            Ok(RestoreLastRepo {
                load_error: Some(e),
                ..RestoreLastRepo::empty()
            })
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBootstrap {
    pub repo: RestoreLastRepo,
    pub theme: Option<String>,
}

/// Loads persisted settings: DaisyUI theme name and last-repo snapshot (same rules as `restore_repo_snapshot`).
#[tauri::command]
pub fn restore_app_bootstrap(app: AppHandle) -> Result<AppBootstrap, String> {
    let settings = load_settings(&app)?;
    let theme = settings.theme.clone();
    let repo = restore_repo_snapshot(&app, &settings)?;
    Ok(AppBootstrap { repo, theme })
}

/// Persists the last successfully opened repository path (`None` clears).
#[tauri::command]
pub fn set_last_repo_path(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let mut s = load_settings(&app)?;
    s.last_repo_path = path;
    save_settings(&app, &s)
}

/// Persists the DaisyUI `data-theme` name (e.g. `light`, `dark`).
#[tauri::command]
pub fn set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let mut s = load_settings(&app)?;
    s.theme = Some(theme);
    save_settings(&app, &s)
}
