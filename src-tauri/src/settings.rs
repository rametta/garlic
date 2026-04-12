//! Persistence for app-level settings stored under the Tauri app config directory.
//! Search tags: settings.json, theme preference, recent repos, OpenAI key, graph preferences, bootstrap.

use crate::git;
use crate::window_title;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_opener::reveal_item_in_dir;

/// DaisyUI theme names (excluding `auto`, handled in the frontend).
pub const DAISY_THEMES: &[&str] = &[
    "light",
    "dark",
    "cupcake",
    "bumblebee",
    "corporate",
    "synthwave",
    "retro",
    "cyberpunk",
    "valentine",
    "garden",
    "forest",
    "dracula",
    "night",
    "nord",
    "sunset",
];

fn is_valid_theme_preference(t: &str) -> bool {
    t == "auto" || DAISY_THEMES.contains(&t)
}

fn default_true() -> bool {
    true
}

fn default_false() -> bool {
    false
}

/// Collapsible branch-sidebar sections (persisted in `settings.json`).
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchSidebarSections {
    #[serde(default = "default_true")]
    pub local_open: bool,
    #[serde(default = "default_true")]
    pub remote_open: bool,
    #[serde(default = "default_false")]
    pub worktrees_open: bool,
    #[serde(default = "default_true")]
    pub tags_open: bool,
    #[serde(default = "default_false")]
    pub stash_open: bool,
}

impl Default for BranchSidebarSections {
    fn default() -> Self {
        Self {
            local_open: true,
            remote_open: true,
            worktrees_open: false,
            tags_open: true,
            stash_open: false,
        }
    }
}

type GraphBranchVisibility = BTreeMap<String, bool>;

fn resolve_persisted_theme_preference(theme: &Option<String>) -> String {
    const DEFAULT: &str = "light";
    match theme {
        Some(t) if is_valid_theme_preference(t) => t.clone(),
        _ => DEFAULT.to_string(),
    }
}

/// Stored theme preference for native menus (`auto` or a DaisyUI theme name).
pub fn persisted_theme_preference(app: &AppHandle) -> String {
    let s = load_settings(app).unwrap_or_default();
    resolve_persisted_theme_preference(&s.theme)
}

/// Most recently opened repo paths (newest first), shown at the top level of the File menu.
pub const MAX_RECENT_REPO_PATHS: usize = 5;

fn default_graph_commits_page_size() -> u32 {
    git::DEFAULT_GRAPH_COMMITS_PAGE_SIZE
}

fn default_graph_commit_title_font_size_px() -> u32 {
    11
}

/// Clamp persisted commit-title font size for the main graph (px).
pub fn clamp_graph_commit_title_font_size_px(px: u32) -> u32 {
    px.clamp(9, 20)
}

#[derive(Debug, Serialize, Deserialize)]
struct AppSettings {
    #[serde(default)]
    last_repo_path: Option<String>,
    #[serde(default)]
    recent_repo_paths: Vec<String>,
    #[serde(default)]
    theme: Option<String>,
    /// User-supplied OpenAI API key for AI commit messages (stored locally).
    #[serde(default)]
    openai_api_key: Option<String>,
    /// OpenAI model id for commit messages (`None` → default in bootstrap).
    #[serde(default)]
    openai_model: Option<String>,
    #[serde(default)]
    branch_sidebar_sections: BranchSidebarSections,
    #[serde(default)]
    graph_branch_visibility_by_repo: BTreeMap<String, GraphBranchVisibility>,
    #[serde(default = "default_false")]
    highlight_active_branch_rows: bool,
    /// `git log -n` page size for the main commit graph (each fetch and "load more" chunk).
    #[serde(default = "default_graph_commits_page_size")]
    graph_commits_page_size: u32,
    /// Pixel font size for commit subject lines in the main graph (default 11).
    #[serde(default = "default_graph_commit_title_font_size_px")]
    graph_commit_title_font_size_px: u32,
    /// Desktop notification when a long-running push or commit completes (hooks included).
    #[serde(default = "default_true")]
    notify_git_completion: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            last_repo_path: None,
            recent_repo_paths: Vec::new(),
            theme: None,
            openai_api_key: None,
            openai_model: None,
            branch_sidebar_sections: BranchSidebarSections::default(),
            graph_branch_visibility_by_repo: BTreeMap::new(),
            highlight_active_branch_rows: false,
            graph_commits_page_size: git::DEFAULT_GRAPH_COMMITS_PAGE_SIZE,
            graph_commit_title_font_size_px: default_graph_commit_title_font_size_px(),
            notify_git_completion: true,
        }
    }
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
    let mut s: AppSettings = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    // Clamp persisted UI settings on read so older or hand-edited config files cannot push the
    // frontend outside the supported graph ranges.
    s.graph_commits_page_size = git::clamp_graph_commits_page_size(s.graph_commits_page_size);
    s.graph_commit_title_font_size_px =
        clamp_graph_commit_title_font_size_px(s.graph_commit_title_font_size_px);
    if s.recent_repo_paths.is_empty() {
        if let Some(ref p) = s.last_repo_path {
            s.recent_repo_paths.push(p.clone());
        }
    }
    Ok(s)
}

fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Opens the system file manager with `settings.json` selected (writes default settings if the file does not exist yet).
pub fn reveal_settings_file_in_explorer(app: &AppHandle) -> Result<(), String> {
    let path = settings_path(app)?;
    if !path.exists() {
        let s = load_settings(app)?;
        save_settings(app, &s)?;
    }
    reveal_item_in_dir(&path).map_err(|e| e.to_string())
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
    pub local_branches: Vec<git::LocalBranchEntry>,
    pub remote_branches: Vec<git::RemoteBranchEntry>,
    pub worktrees: Vec<git::WorktreeEntry>,
    pub tags: Vec<git::TagEntry>,
    pub stashes: Vec<git::StashEntry>,
    pub commits: Vec<git::CommitEntry>,
    /// True when the graph log has more commits than returned in `commits` (first page only).
    pub graph_commits_has_more: bool,
    pub working_tree_files: Vec<git::WorkingTreeFile>,
    pub lists_error: Option<String>,
}

impl RestoreLastRepo {
    fn empty() -> Self {
        Self {
            load_error: None,
            metadata: None,
            local_branches: Vec::new(),
            remote_branches: Vec::new(),
            worktrees: Vec::new(),
            tags: Vec::new(),
            stashes: Vec::new(),
            commits: Vec::new(),
            graph_commits_has_more: false,
            working_tree_files: Vec::new(),
            lists_error: None,
        }
    }
}

fn restore_repo_snapshot(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<RestoreLastRepo, String> {
    let Some(path) = settings.last_repo_path.clone() else {
        return Ok(RestoreLastRepo::empty());
    };

    match git::get_repo_metadata(app.clone(), path.clone()) {
        Ok(meta) => {
            if meta.error.is_some() {
                clear_last_repo_path(app)?;
                return Ok(RestoreLastRepo {
                    metadata: Some(meta),
                    ..RestoreLastRepo::empty()
                });
            }

            let page_size = git::clamp_graph_commits_page_size(settings.graph_commits_page_size);
            let (locals, remotes, commits_page, worktrees, working_tree, stashes, tags) =
                std::thread::scope(|s| {
                    let h1 = s.spawn({
                        let p = path.clone();
                        move || git::list_local_branches(p)
                    });
                    let h2 = s.spawn({
                        let p = path.clone();
                        move || git::list_remote_branches(p)
                    });
                    let h3 = s.spawn({
                        let p = path.clone();
                        move || git::list_worktrees(p)
                    });
                    let h4 = s.spawn({
                        let p = path.clone();
                        move || git::list_working_tree_files_blocking(p)
                    });
                    let h5 = s.spawn({
                        let p = path.clone();
                        move || git::list_stashes(p)
                    });
                    let h6 = s.spawn({
                        let p = path.clone();
                        move || git::list_tags(p)
                    });

                    let locals = h1.join().unwrap();
                    let remotes = h2.join().unwrap();

                    let commits_handle = s.spawn({
                        let p = path.clone();
                        let locals_ok = locals.clone();
                        let remotes_ok = remotes.clone();
                        move || match (&locals_ok, &remotes_ok) {
                            (Ok(loc), Ok(rem)) => {
                                let visibility = persisted_graph_branch_visibility(settings, &p);
                                let hidden_refs =
                                    hidden_graph_refs_from_visibility(&visibility, loc, rem);
                                git::list_graph_commits_blocking(p, hidden_refs, 0, page_size)
                            }
                            _ => git::list_branch_commits(p, page_size),
                        }
                    });

                    (
                        locals,
                        remotes,
                        commits_handle.join().unwrap(),
                        h3.join().unwrap(),
                        h4.join().unwrap(),
                        h5.join().unwrap(),
                        h6.join().unwrap(),
                    )
                });

            let lists_error = locals
                .as_ref()
                .err()
                .cloned()
                .or(remotes.as_ref().err().cloned())
                .or(commits_page.as_ref().err().cloned())
                .or(worktrees.as_ref().err().cloned())
                .or(working_tree.as_ref().err().cloned())
                .or(stashes.as_ref().err().cloned())
                .or(tags.as_ref().err().cloned());

            let (commits, graph_commits_has_more) = match commits_page {
                Ok(p) => (p.commits, p.has_more),
                Err(_) => (Vec::new(), false),
            };

            Ok(RestoreLastRepo {
                load_error: None,
                metadata: Some(meta),
                local_branches: locals.unwrap_or_default(),
                remote_branches: remotes.unwrap_or_default(),
                worktrees: worktrees.unwrap_or_default(),
                tags: tags.unwrap_or_default(),
                stashes: stashes.unwrap_or_default(),
                commits,
                graph_commits_has_more,
                working_tree_files: working_tree.unwrap_or_default(),
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
    pub openai_api_key: Option<String>,
    /// Resolved model id (defaults to `gpt-5.4-mini` when unset).
    pub openai_model: String,
    pub branch_sidebar_sections: BranchSidebarSections,
    pub graph_branch_visible: GraphBranchVisibility,
    pub highlight_active_branch_rows: bool,
    /// `git log -n` page size for the commit graph (default 500).
    pub graph_commits_page_size: u32,
    /// Commit subject font size in the main graph (px, default 11).
    pub graph_commit_title_font_size_px: u32,
    /// When true, show a system notification after a long-running push or commit completes.
    pub notify_git_completion: bool,
}

/// Loads persisted settings: DaisyUI theme name and last-repo snapshot (same rules as `restore_repo_snapshot`).
#[tauri::command]
pub fn restore_app_bootstrap(app: AppHandle) -> Result<AppBootstrap, String> {
    let settings = load_settings(&app)?;
    let theme = settings.theme.clone();
    let openai_api_key = settings.openai_api_key.clone();
    let openai_model = resolve_openai_model(&settings);
    // Repo-scoped visibility is keyed off the last opened repo so the graph can remember which
    // branches were hidden without mixing preferences across repositories.
    let graph_branch_visible = settings
        .last_repo_path
        .as_deref()
        .map(|path| persisted_graph_branch_visibility(&settings, path))
        .unwrap_or_default();
    let repo = restore_repo_snapshot(&app, &settings)?;
    if repo.metadata.is_none() {
        window_title::set_main_window_title(&app, window_title::DEFAULT_WINDOW_TITLE);
    }
    Ok(AppBootstrap {
        repo,
        theme,
        openai_api_key,
        openai_model,
        branch_sidebar_sections: settings.branch_sidebar_sections.clone(),
        graph_branch_visible,
        highlight_active_branch_rows: settings.highlight_active_branch_rows,
        graph_commits_page_size: git::clamp_graph_commits_page_size(
            settings.graph_commits_page_size,
        ),
        graph_commit_title_font_size_px: clamp_graph_commit_title_font_size_px(
            settings.graph_commit_title_font_size_px,
        ),
        notify_git_completion: settings.notify_git_completion,
    })
}

fn resolve_openai_model(settings: &AppSettings) -> String {
    const DEFAULT: &str = "gpt-5.4-mini";
    settings
        .openai_model
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| DEFAULT.to_string())
}

fn persisted_graph_branch_visibility(settings: &AppSettings, path: &str) -> GraphBranchVisibility {
    settings
        .graph_branch_visibility_by_repo
        .get(path)
        .cloned()
        .map(normalize_graph_branch_visibility)
        .unwrap_or_default()
}

fn normalize_graph_branch_visibility(visibility: GraphBranchVisibility) -> GraphBranchVisibility {
    visibility
        .into_iter()
        .filter_map(|(key, value)| {
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            if value {
                return None;
            }
            Some((key.to_string(), false))
        })
        .collect()
}

fn hidden_graph_refs_from_visibility(
    visibility: &GraphBranchVisibility,
    local_branches: &[git::LocalBranchEntry],
    remote_branches: &[git::RemoteBranchEntry],
) -> Vec<String> {
    let mut refs: Vec<String> = local_branches
        .iter()
        .filter(|branch| visibility.get(&format!("local:{}", branch.name)) == Some(&false))
        .map(|branch| branch.name.clone())
        .collect();
    refs.extend(
        remote_branches
            .iter()
            .filter(|branch| visibility.get(&format!("remote:{}", branch.name)) == Some(&false))
            .map(|branch| branch.name.clone()),
    );
    refs.sort();
    refs.dedup();
    refs
}

/// Persists OpenAI API key and model for AI-generated commit messages.
#[tauri::command]
pub fn set_openai_settings(
    app: AppHandle,
    key: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let mut s = load_settings(&app)?;
    s.openai_api_key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    s.openai_model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    save_settings(&app, &s)
}

/// Persists the last opened repository path and updates the recent list (`None` clears last only).
pub fn persist_last_repo_path(app: &AppHandle, path: Option<String>) -> Result<(), String> {
    let mut s = load_settings(app)?;
    s.last_repo_path = path.clone();
    if let Some(p) = path {
        s.recent_repo_paths.retain(|x| x != &p);
        s.recent_repo_paths.insert(0, p);
        s.recent_repo_paths.truncate(MAX_RECENT_REPO_PATHS);
    }
    save_settings(app, &s)
}

/// Paths for the File menu recent-repo section (newest first, at most [`MAX_RECENT_REPO_PATHS`]).
pub fn recent_repo_paths(app: &AppHandle) -> Vec<String> {
    load_settings(app)
        .map(|s| s.recent_repo_paths)
        .unwrap_or_default()
}

/// Persisted graph-row highlight preference for the native View menu.
pub fn persisted_highlight_active_branch_rows(app: &AppHandle) -> bool {
    load_settings(app)
        .map(|s| s.highlight_active_branch_rows)
        .unwrap_or(false)
}

/// Persists which branch-sidebar sections are expanded.
#[tauri::command]
pub fn set_branch_sidebar_sections(
    app: AppHandle,
    sections: BranchSidebarSections,
) -> Result<(), String> {
    let mut s = load_settings(&app)?;
    s.branch_sidebar_sections = sections;
    save_settings(&app, &s)
}

/// Loads per-repo commit-graph branch visibility overrides.
#[tauri::command]
pub fn get_graph_branch_visibility(
    app: AppHandle,
    path: String,
) -> Result<GraphBranchVisibility, String> {
    let path = path.trim();
    if path.is_empty() {
        return Ok(GraphBranchVisibility::default());
    }
    let s = load_settings(&app)?;
    Ok(persisted_graph_branch_visibility(&s, path))
}

/// Persists per-repo commit-graph branch visibility overrides.
#[tauri::command]
pub fn set_graph_branch_visibility(
    app: AppHandle,
    path: String,
    visibility: GraphBranchVisibility,
) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Ok(());
    }
    let mut s = load_settings(&app)?;
    let normalized = normalize_graph_branch_visibility(visibility);
    if normalized.is_empty() {
        s.graph_branch_visibility_by_repo.remove(path);
    } else {
        s.graph_branch_visibility_by_repo
            .insert(path.to_string(), normalized);
    }
    save_settings(&app, &s)
}

/// Persists whether the commit graph should tint rows on the checked-out branch path.
pub fn set_highlight_active_branch_rows(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = load_settings(app)?;
    s.highlight_active_branch_rows = enabled;
    save_settings(app, &s)
}

/// Persists how many commits each graph log fetch loads (`git log -n`, default 500).
#[tauri::command]
pub fn set_graph_commits_page_size(app: AppHandle, page_size: u32) -> Result<(), String> {
    let mut s = load_settings(&app)?;
    s.graph_commits_page_size = git::clamp_graph_commits_page_size(page_size);
    save_settings(&app, &s)
}

/// Persists commit subject font size (px) for the main graph.
#[tauri::command]
pub fn set_graph_commit_title_font_size(app: AppHandle, font_size_px: u32) -> Result<(), String> {
    let mut s = load_settings(&app)?;
    s.graph_commit_title_font_size_px = clamp_graph_commit_title_font_size_px(font_size_px);
    save_settings(&app, &s)
}

/// Whether completion notifications for long push/commit runs are enabled (stored in `settings.json`).
pub fn notify_git_completion_enabled(app: &AppHandle) -> bool {
    load_settings(app)
        .map(|s| s.notify_git_completion)
        .unwrap_or(true)
}

/// Persists whether to show a system notification after a long-running push or commit completes.
#[tauri::command]
pub fn set_notify_git_completion(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = load_settings(&app)?;
    s.notify_git_completion = enabled;
    save_settings(&app, &s)
}

/// Persists theme preference: `auto` (follow OS light/dark) or a DaisyUI `data-theme` name.
#[tauri::command]
pub fn set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    if !is_valid_theme_preference(&theme) {
        return Err(format!("Invalid theme: {theme}"));
    }
    let mut s = load_settings(&app)?;
    s.theme = Some(theme);
    save_settings(&app, &s)
}
