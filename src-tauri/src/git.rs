use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub fetch_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranchEntry {
    pub name: String,
    /// Commits on this branch not on its upstream (`None` if no upstream is configured).
    pub ahead: Option<u32>,
    /// Commits on upstream not on this branch (`None` if no upstream is configured).
    pub behind: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeFile {
    pub path: String,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMetadata {
    pub path: String,
    pub name: String,
    pub git_root: Option<String>,
    pub error: Option<String>,
    pub branch: Option<String>,
    pub head_short: Option<String>,
    pub head_subject: Option<String>,
    pub head_author: Option<String>,
    pub head_date: Option<String>,
    pub detached: bool,
    pub remotes: Vec<RemoteEntry>,
    pub working_tree_clean: Option<bool>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

fn git_output(workdir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(workdir)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr
        };
        return Err(msg);
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_output_allow_fail(workdir: &Path, args: &[&str]) -> Option<String> {
    Command::new("git")
        .current_dir(workdir)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn repo_name_from_path(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    Path::new(trimmed)
        .file_name()
        .and_then(|s| s.to_str())
        .map(String::from)
        .unwrap_or_else(|| trimmed.to_string())
}

fn parse_remotes(text: &str) -> Vec<RemoteEntry> {
    let mut seen: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(url) = parts.next() else { continue };
        let kind = parts.next().unwrap_or("");
        if kind.starts_with('(') && kind.contains("fetch") {
            if !seen.iter().any(|(n, _)| n == name) {
                seen.push((name.to_string(), url.to_string()));
            }
        }
    }
    seen.into_iter()
        .map(|(name, fetch_url)| RemoteEntry { name, fetch_url })
        .collect()
}

/// Inspect a local folder with `git` and return metadata for the UI.
#[tauri::command]
pub fn get_repo_metadata(app: AppHandle, path: String) -> Result<RepoMetadata, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        crate::window_title::set_main_window_title(&app, crate::window_title::DEFAULT_WINDOW_TITLE);
        return Err("That path does not exist.".to_string());
    }
    if !path_buf.is_dir() {
        crate::window_title::set_main_window_title(&app, crate::window_title::DEFAULT_WINDOW_TITLE);
        return Err("The selected path is not a folder.".to_string());
    }

    let name = repo_name_from_path(&path);

    let base = RepoMetadata {
        path: path.clone(),
        name,
        git_root: None,
        error: None,
        branch: None,
        head_short: None,
        head_subject: None,
        head_author: None,
        head_date: None,
        detached: false,
        remotes: Vec::new(),
        working_tree_clean: None,
        ahead: None,
        behind: None,
    };

    if git_output(&path_buf, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        let meta = RepoMetadata {
            error: Some("Not a Git repository (no .git metadata found).".to_string()),
            ..base
        };
        crate::window_title::set_main_window_title(&app, &meta.name);
        return Ok(meta);
    }

    let git_root = git_output(&path_buf, &["rev-parse", "--show-toplevel"]).ok();

    let abbrev = git_output(&path_buf, &["rev-parse", "--abbrev-ref", "HEAD"]).ok();
    let detached = abbrev.as_deref() == Some("HEAD");

    let branch = if detached { None } else { abbrev.clone() };

    let head_short = git_output(&path_buf, &["rev-parse", "--short", "HEAD"]).ok();

    let log_line = git_output(&path_buf, &["log", "-1", "--format=%s|%an|%aI"]).ok();

    let (head_subject, head_author, head_date) = log_line
        .as_ref()
        .map(|s| {
            let mut parts = s.splitn(3, '|');
            let sub = parts.next().map(String::from);
            let auth = parts.next().map(String::from);
            let date = parts.next().map(String::from);
            (sub, auth, date)
        })
        .unwrap_or((None, None, None));

    let remotes_text = git_output_allow_fail(&path_buf, &["remote", "-v"]).unwrap_or_default();
    let remotes = parse_remotes(&remotes_text);

    let status = git_output_allow_fail(&path_buf, &["status", "--porcelain"]);
    let working_tree_clean = status.as_ref().map(|s| s.is_empty());

    let ab = git_output_allow_fail(
        &path_buf,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    );
    let (ahead, behind) = ab
        .as_ref()
        .and_then(|s| {
            let mut it = s.split_whitespace();
            let a = it.next()?.parse().ok()?;
            let b = it.next()?.parse().ok()?;
            Some((a, b))
        })
        .map(|(a, b)| (Some(a), Some(b)))
        .unwrap_or((None, None));

    let meta = RepoMetadata {
        git_root,
        branch,
        head_short,
        head_subject,
        head_author,
        head_date,
        detached,
        remotes,
        working_tree_clean,
        ahead,
        behind,
        error: None,
        ..base
    };
    crate::window_title::set_main_window_title(&app, &meta.name);
    Ok(meta)
}

fn ensure_git_repo(workdir: &Path) -> Result<(), String> {
    if !workdir.exists() {
        return Err("That path does not exist.".to_string());
    }
    if !workdir.is_dir() {
        return Err("The selected path is not a folder.".to_string());
    }
    if git_output(workdir, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err("Not a Git repository.".to_string());
    }
    Ok(())
}

fn branch_upstream_counts(workdir: &Path, branch: &str) -> Option<(u32, u32)> {
    let range = format!("{branch}...{branch}@{{upstream}}");
    let out = git_output_allow_fail(workdir, &["rev-list", "--left-right", "--count", &range])?;
    let mut it = out.split_whitespace();
    let left = it.next()?.parse().ok()?;
    let right = it.next()?.parse().ok()?;
    Some((left, right))
}

/// Local branches with ahead/behind counts vs configured upstream (if any).
#[tauri::command]
pub fn list_local_branches(path: String) -> Result<Vec<LocalBranchEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let out = git_output(
        &path_buf,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )?;
    let mut branches: Vec<String> = out
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    branches.sort();

    let mut entries = Vec::with_capacity(branches.len());
    for name in branches {
        let (ahead, behind) = match branch_upstream_counts(&path_buf, &name) {
            Some((a, b)) => (Some(a), Some(b)),
            None => (None, None),
        };
        entries.push(LocalBranchEntry {
            name,
            ahead,
            behind,
        });
    }
    Ok(entries)
}

/// Remote-tracking branches as `remote/branch` (e.g. `origin/main`), excluding `*/HEAD`.
#[tauri::command]
pub fn list_remote_branches(path: String) -> Result<Vec<String>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let out = git_output(
        &path_buf,
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes/"],
    )?;
    let mut branches: Vec<String> = out
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|s| !s.ends_with("/HEAD"))
        .collect();
    branches.sort();
    Ok(branches)
}

/// Commits reachable from `HEAD` (current branch or detached), newest first.
#[tauri::command]
pub fn list_branch_commits(path: String) -> Result<Vec<CommitEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let out = git_output(
        &path_buf,
        &[
            "log",
            "HEAD",
            "-n",
            "100",
            // %x1f (unit separator): subject last so it can contain delimiters
            "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s",
        ],
    )?;
    let mut commits = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(5, '\x1f');
        let hash = parts.next().map(String::from);
        let short_hash = parts.next().map(String::from);
        let author = parts.next().map(String::from);
        let date = parts.next().map(String::from);
        let subject = parts.next().map(String::from);
        if let (Some(h), Some(sh), Some(auth), Some(dt), Some(sub)) =
            (hash, short_hash, author, date, subject)
        {
            commits.push(CommitEntry {
                hash: h,
                short_hash: sh,
                subject: sub,
                author: auth,
                date: dt,
            });
        }
    }
    Ok(commits)
}

#[tauri::command]
pub fn checkout_local_branch(path: String, branch: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    git_output(&path_buf, &["switch", &branch])?;
    Ok(())
}

/// Create a new local branch at the current `HEAD` and switch to it.
#[tauri::command]
pub fn create_local_branch(path: String, branch: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let name = branch.trim();
    if name.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }
    git_output(&path_buf, &["switch", "-c", name])?;
    Ok(())
}

/// Create a local branch from `remote_ref` (e.g. `origin/feature/foo`) and switch to it.
#[tauri::command]
pub fn create_branch_from_remote(path: String, remote_ref: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let Some(slash) = remote_ref.find('/') else {
        return Err("Invalid remote branch ref.".to_string());
    };
    let local_name = remote_ref[slash + 1..].trim();
    if local_name.is_empty() {
        return Err("Invalid remote branch ref.".to_string());
    }
    git_output(
        &path_buf,
        &["switch", "-c", local_name, remote_ref.as_str()],
    )?;
    Ok(())
}

fn non_empty_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn staged_paths(workdir: &Path) -> Result<Vec<String>, String> {
    let out = git_output(workdir, &["diff", "--cached", "--name-only"])?;
    Ok(non_empty_lines(&out))
}

fn unstaged_paths(workdir: &Path) -> Result<Vec<String>, String> {
    let out = git_output(workdir, &["diff", "--name-only"])?;
    Ok(non_empty_lines(&out))
}

fn untracked_paths(workdir: &Path) -> Result<Vec<String>, String> {
    let out = git_output(
        workdir,
        &["ls-files", "--others", "--exclude-standard"],
    )?;
    Ok(non_empty_lines(&out))
}

/// Combined working tree file list for the UI (staged / unstaged flags per path).
#[tauri::command]
pub fn list_working_tree_files(path: String) -> Result<Vec<WorkingTreeFile>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let staged = staged_paths(&path_buf)?
        .into_iter()
        .collect::<HashSet<_>>();
    let unstaged = unstaged_paths(&path_buf)?
        .into_iter()
        .collect::<HashSet<_>>();
    let untracked = untracked_paths(&path_buf)?
        .into_iter()
        .collect::<HashSet<_>>();
    let mut paths: HashSet<String> = HashSet::new();
    paths.extend(staged.iter().cloned());
    paths.extend(unstaged.iter().cloned());
    paths.extend(untracked.iter().cloned());
    let mut paths: Vec<String> = paths.into_iter().collect();
    paths.sort();
    Ok(paths
        .into_iter()
        .map(|p| WorkingTreeFile {
            path: p.clone(),
            staged: staged.contains(&p),
            unstaged: unstaged.contains(&p) || untracked.contains(&p),
        })
        .collect())
}

#[tauri::command]
pub fn stage_paths(path: String, paths: Vec<String>) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<String> = vec!["add".into(), "--".into()];
    args.extend(paths);
    git_output(
        &path_buf,
        &args.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    )?;
    Ok(())
}

#[tauri::command]
pub fn unstage_paths(path: String, paths: Vec<String>) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<String> = vec!["restore".into(), "--staged".into(), "--".into()];
    args.extend(paths);
    git_output(
        &path_buf,
        &args.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    )?;
    Ok(())
}

#[tauri::command]
pub fn commit_staged(path: String, message: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let msg = message.trim();
    if msg.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    git_output(&path_buf, &["commit", "-m", msg])?;
    Ok(())
}
