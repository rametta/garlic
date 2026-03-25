use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;
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
    /// Parent commit hashes (first parent is mainline; merge commits have 2+).
    pub parent_hashes: Vec<String>,
}

/// Result of `git log -1 --format=%G?` for one commit (on-demand; not used in bulk log).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSignatureStatus {
    /// `Some(true)` when Git reports a good signature (`G`). `Some(false)` when Git answers and the commit is not good-signed (including `N` = no signature). `None` on timeout or failure.
    pub verified: Option<bool>,
}

/// Remote-tracking branch (`refs/remotes/...`) with tip OID.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranchEntry {
    pub name: String,
    pub tip_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranchEntry {
    pub name: String,
    /// Tip commit OID for this branch (`refs/heads/<name>`).
    pub tip_hash: String,
    /// Remote-tracking ref for this branch's upstream (e.g. `origin/main`), if configured.
    pub upstream_name: Option<String>,
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

/// `git diff` / `git diff --no-index` use exit status 1 when there are differences (POSIX).
fn git_diff_output(workdir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(workdir)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    let code = output.status.code().unwrap_or(-1);
    if code == 0 || code == 1 {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let msg = if stderr.is_empty() {
        format!("git {} failed (exit {code})", args.join(" "))
    } else {
        stderr
    };
    Err(msg)
}

/// True if `path` is known to the index (tracked or staged).
fn git_path_known_to_git(workdir: &Path, rel: &str) -> bool {
    git_output(workdir, &["ls-files", "--error-unmatch", "--", rel]).is_ok()
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
        crate::active_repo::set_path(&app, None);
        crate::window_title::set_main_window_title(&app, crate::window_title::DEFAULT_WINDOW_TITLE);
        return Err("That path does not exist.".to_string());
    }
    if !path_buf.is_dir() {
        crate::active_repo::set_path(&app, None);
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
        crate::active_repo::set_path(&app, Some(path.clone()));
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

    let (ahead, behind) = head_upstream_ahead_behind(&path_buf)
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
    crate::active_repo::set_path(&app, Some(path.clone()));
    crate::window_title::set_main_window_title(&app, &meta.name);
    Ok(meta)
}

fn format_head_date_display(iso: &str) -> String {
    use chrono::DateTime;
    let trimmed = iso.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    match DateTime::parse_from_rfc3339(trimmed) {
        Ok(dt) => dt.format("%b %d, %Y, %I:%M %p %:z").to_string(),
        Err(_) => trimmed.to_string(),
    }
}

pub(crate) fn format_repo_metadata_plain_text(m: &RepoMetadata) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(ref err) = m.error {
        lines.push(format!("Error: {err}"));
        lines.push(String::new());
    }
    lines.push(format!("Path: {}", m.path));
    if let Some(ref gr) = m.git_root {
        if gr != &m.path {
            lines.push(format!("Git root: {gr}"));
        }
    }
    let branch_line = if m.detached {
        format!(
            "Branch: Detached at {}",
            m.head_short.as_deref().unwrap_or("—")
        )
    } else {
        format!("Branch: {}", m.branch.as_deref().unwrap_or("—"))
    };
    lines.push(branch_line);
    if let Some(ref hs) = m.head_short {
        let head_part = match &m.head_subject {
            Some(sub) => format!("{hs} {sub}"),
            None => hs.clone(),
        };
        lines.push(format!("HEAD: {head_part}"));
    }
    if let Some(ref ha) = m.head_author {
        lines.push(format!("Last commit author: {ha}"));
    }
    if let Some(ref hd) = m.head_date {
        if !hd.is_empty() {
            lines.push(format!("Last commit: {}", format_head_date_display(hd)));
        }
    }
    if let Some(wtc) = m.working_tree_clean {
        lines.push(format!(
            "Working tree: {}",
            if wtc { "Clean" } else { "Has local changes" }
        ));
    }
    if let (Some(a), Some(b)) = (m.ahead, m.behind) {
        lines.push(format!("Upstream: {a} ahead, {b} behind"));
    }
    if !m.remotes.is_empty() {
        lines.push("Remotes:".to_string());
        for r in &m.remotes {
            lines.push(format!("  • {}: {}", r.name, r.fetch_url));
        }
    } else {
        lines.push("Remotes: None configured".to_string());
    }
    lines.join("\n")
}

/// Ahead/behind vs `@{upstream}` using two-dot ranges (same idea as `git status -sb`).
fn head_upstream_ahead_behind(workdir: &Path) -> Option<(u32, u32)> {
    git_output_allow_fail(workdir, &["rev-parse", "--verify", "@{upstream}"])?;
    let ahead_s = git_output_allow_fail(workdir, &["rev-list", "--count", "@{upstream}..HEAD"])?;
    let behind_s = git_output_allow_fail(workdir, &["rev-list", "--count", "HEAD..@{upstream}"])?;
    let ahead = ahead_s.trim().parse().ok()?;
    let behind = behind_s.trim().parse().ok()?;
    Some((ahead, behind))
}

fn branch_upstream_abbrev(workdir: &Path, branch: &str) -> Option<String> {
    let s = git_output_allow_fail(
        workdir,
        &[
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ],
    )?;
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    Some(s.to_string())
}

/// Ahead/behind for a local branch vs its configured upstream (two-dot ranges).
fn branch_upstream_ahead_behind(workdir: &Path, branch: &str) -> Option<(u32, u32)> {
    let up = format!("{branch}@{{upstream}}");
    git_output_allow_fail(workdir, &["rev-parse", "--verify", &up])?;
    let ahead_range = format!("{branch}@{{upstream}}..{branch}");
    let behind_range = format!("{branch}..{branch}@{{upstream}}");
    let ahead_s = git_output_allow_fail(workdir, &["rev-list", "--count", &ahead_range])?;
    let behind_s = git_output_allow_fail(workdir, &["rev-list", "--count", &behind_range])?;
    let ahead = ahead_s.trim().parse().ok()?;
    let behind = behind_s.trim().parse().ok()?;
    Some((ahead, behind))
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

/// Local branches with ahead/behind counts vs configured upstream (if any).
#[tauri::command]
pub fn list_local_branches(path: String) -> Result<Vec<LocalBranchEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    // `for-each-ref` does not expand `%x1f` (it prints the literal); use a real tab.
    let out = git_output(
        &path_buf,
        &[
            "for-each-ref",
            "--format=%(objectname)\t%(refname:short)",
            "refs/heads/",
        ],
    )?;
    let mut pairs: Vec<(String, String)> = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (tip_hash, name) = if let Some((a, b)) = line.split_once('\t') {
            (a.trim().to_string(), b.trim().to_string())
        } else {
            // Fallback: first token is object id, rest is ref short name.
            let mut it = line.split_whitespace();
            let Some(oid) = it.next() else {
                continue;
            };
            let rest: String = it.collect::<Vec<_>>().join(" ");
            if rest.is_empty() {
                continue;
            }
            (oid.to_string(), rest)
        };
        if !name.is_empty() && !tip_hash.is_empty() {
            pairs.push((name, tip_hash));
        }
    }
    pairs.sort_by(|a, b| a.0.cmp(&b.0));

    let mut entries = Vec::with_capacity(pairs.len());
    for (name, tip_hash) in pairs {
        let upstream_name = branch_upstream_abbrev(&path_buf, &name);
        let (ahead, behind) = match branch_upstream_ahead_behind(&path_buf, &name) {
            Some((a, b)) => (Some(a), Some(b)),
            None => (None, None),
        };
        entries.push(LocalBranchEntry {
            name,
            tip_hash,
            upstream_name,
            ahead,
            behind,
        });
    }
    Ok(entries)
}

/// Remote-tracking branches as `remote/branch` (e.g. `origin/main`), excluding `*/HEAD`.
#[tauri::command]
pub fn list_remote_branches(path: String) -> Result<Vec<RemoteBranchEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let out = git_output(
        &path_buf,
        &[
            "for-each-ref",
            "--format=%(objectname)\t%(refname:short)",
            "refs/remotes/",
        ],
    )?;
    let mut entries: Vec<RemoteBranchEntry> = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (tip_hash, name) = if let Some((a, b)) = line.split_once('\t') {
            (a.trim().to_string(), b.trim().to_string())
        } else {
            let mut it = line.split_whitespace();
            let Some(oid) = it.next() else {
                continue;
            };
            let rest: String = it.collect::<Vec<_>>().join(" ");
            if rest.is_empty() {
                continue;
            }
            (oid.to_string(), rest)
        };
        if name.is_empty() || name.ends_with("/HEAD") || tip_hash.is_empty() {
            continue;
        }
        entries.push(RemoteBranchEntry { name, tip_hash });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

fn parse_commit_log_lines(out: &str) -> Vec<CommitEntry> {
    let mut commits = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(6, '\x1f');
        let hash = parts.next().map(String::from);
        let parents_raw = parts.next().map(String::from);
        let short_hash = parts.next().map(String::from);
        let author = parts.next().map(String::from);
        let date = parts.next().map(String::from);
        let subject = parts.next().map(String::from);
        if let (Some(h), Some(pr), Some(sh), Some(auth), Some(dt), Some(sub)) =
            (hash, parents_raw, short_hash, author, date, subject)
        {
            let parent_hashes: Vec<String> = pr
                .split_whitespace()
                .map(String::from)
                .filter(|s| !s.is_empty())
                .collect();
            commits.push(CommitEntry {
                hash: h,
                short_hash: sh,
                subject: sub,
                author: auth,
                date: dt,
                parent_hashes,
            });
        }
    }
    commits
}

/// Commits reachable from any local branch (`--branches`), topological order, newest first.
#[tauri::command]
pub fn list_branch_commits(path: String) -> Result<Vec<CommitEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let out = git_output(
        &path_buf,
        &[
            "log",
            "--branches",
            "--topo-order",
            "-n",
            "500",
            // Avoid `%G?` here: signature verification can block repo loading.
            // %P: space-separated parents; %x1f: subject last so it can contain delimiters.
            "--format=%H%x1f%P%x1f%h%x1f%an%x1f%aI%x1f%s",
        ],
    )?;
    Ok(parse_commit_log_lines(&out))
}

/// Commits reachable from the given refs (branch names like `main` or `origin/main`), topo order, newest first.
#[tauri::command]
pub fn list_graph_commits(path: String, refs: Vec<String>) -> Result<Vec<CommitEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let mut clean: Vec<String> = refs
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    clean.sort();
    clean.dedup();
    if clean.is_empty() {
        return Ok(Vec::new());
    }
    let mut cmd_args: Vec<String> = vec![
        "log".into(),
        "--topo-order".into(),
        "-n".into(),
        "500".into(),
        "--format=%H%x1f%P%x1f%h%x1f%an%x1f%aI%x1f%s".into(),
    ];
    cmd_args.extend(clean);
    let args_ref: Vec<&str> = cmd_args.iter().map(|s| s.as_str()).collect();
    let out = git_output(&path_buf, &args_ref)?;
    Ok(parse_commit_log_lines(&out))
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

/// `git show` prints commit metadata before the patch; `react-diff-view` needs a patch-only string.
fn unified_diff_patch_only(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.iter().position(|line| {
        line.starts_with("diff --git ")
            || line.starts_with("--- ")
            || line.starts_with("diff --cc ")
    });
    match start {
        Some(i) => lines[i..].join("\n"),
        None => text.to_string(),
    }
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
    let out = git_output(workdir, &["ls-files", "--others", "--exclude-standard"])?;
    Ok(non_empty_lines(&out))
}

/// Combined working tree file list for the UI (staged / unstaged flags per path).
#[tauri::command]
pub fn list_working_tree_files(path: String) -> Result<Vec<WorkingTreeFile>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let staged = staged_paths(&path_buf)?.into_iter().collect::<HashSet<_>>();
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

/// Staged diff for a path (`git diff --cached -- <path>`).
#[tauri::command]
pub fn get_staged_diff(path: String, file_path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let rel = file_path.trim();
    if rel.is_empty() {
        return Err("File path cannot be empty.".to_string());
    }
    git_output(&path_buf, &["diff", "--cached", "-U1", "--", rel])
}

/// Unstaged diff for a path (`git diff -- <path>`), or full file vs empty for untracked paths.
#[tauri::command]
pub fn get_unstaged_diff(path: String, file_path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let rel = file_path.trim();
    if rel.is_empty() {
        return Err("File path cannot be empty.".to_string());
    }
    let out = git_output(&path_buf, &["diff", "-U1", "--", rel]);
    match out {
        Ok(ref s) if !s.trim().is_empty() => out,
        Ok(_) => {
            if git_path_known_to_git(&path_buf, rel) {
                Ok(String::new())
            } else {
                let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
                git_diff_output(
                    &path_buf,
                    &["diff", "-U1", "--no-index", "--", null_path, rel],
                )
            }
        }
        Err(e) => Err(e),
    }
}

/// Paths changed in a single commit (`git diff-tree --name-only`).
#[tauri::command]
pub fn list_commit_files(path: String, commit_hash: String) -> Result<Vec<String>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let hash = commit_hash.trim();
    if hash.is_empty() {
        return Err("Commit hash cannot be empty.".to_string());
    }
    let out = git_output(
        &path_buf,
        &["diff-tree", "--no-commit-id", "--name-only", "-r", hash],
    )?;
    Ok(non_empty_lines(&out))
}

/// Good-signature check for a single commit using Git's `%G?` trust letter. Runs in a thread with a timeout so gpg/key lookup cannot block the app indefinitely.
#[tauri::command]
pub fn get_commit_signature_status(
    path: String,
    commit_hash: String,
) -> Result<CommitSignatureStatus, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let hash = commit_hash.trim();
    if hash.is_empty() {
        return Err("Commit hash cannot be empty.".to_string());
    }

    let workdir = path_buf;
    let hash_owned = hash.to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let out = Command::new("git")
            .current_dir(&workdir)
            .args(["log", "-1", "--format=%G?", &hash_owned])
            .output();
        let _ = tx.send(out);
    });

    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(output)) => {
            if !output.status.success() {
                return Ok(CommitSignatureStatus { verified: None });
            }
            let flag = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if flag.is_empty() {
                return Ok(CommitSignatureStatus { verified: None });
            }
            let ch = flag.chars().next().unwrap_or(' ');
            let verified = if ch == 'G' { Some(true) } else { Some(false) };
            Ok(CommitSignatureStatus { verified })
        }
        Ok(Err(e)) => Err(format!("Could not run git: {e}")),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("Signature check failed.".to_string()),
        Err(mpsc::RecvTimeoutError::Timeout) => Ok(CommitSignatureStatus { verified: None }),
    }
}

/// Unified diff for one file in a given commit (`git show <hash> -- <path>`), patch only (no commit headers).
#[tauri::command]
pub fn get_commit_file_diff(
    path: String,
    commit_hash: String,
    file_path: String,
) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let hash = commit_hash.trim();
    let rel = file_path.trim();
    if hash.is_empty() {
        return Err("Commit hash cannot be empty.".to_string());
    }
    if rel.is_empty() {
        return Err("File path cannot be empty.".to_string());
    }
    let raw = git_output(&path_buf, &["show", "-U1", hash, "--", rel])?;
    Ok(unified_diff_patch_only(&raw))
}

/// Push the current branch to `origin`, setting upstream if needed (`git push -u origin HEAD`).
#[tauri::command]
pub fn push_to_origin(path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let head_ref = git_output(&path_buf, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if head_ref.trim() == "HEAD" {
        return Err("Cannot push while in detached HEAD. Check out a branch first.".to_string());
    }
    git_output(&path_buf, &["remote", "get-url", "origin"]).map_err(|_| {
        "No remote named \"origin\" configured. Add it under Remotes or use git remote add."
            .to_string()
    })?;
    git_output(&path_buf, &["push", "-u", "origin", "HEAD"])?;
    Ok(())
}
