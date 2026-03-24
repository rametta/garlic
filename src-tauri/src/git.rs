use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub fetch_url: String,
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
pub fn get_repo_metadata(path: String) -> Result<RepoMetadata, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err("That path does not exist.".to_string());
    }
    if !path_buf.is_dir() {
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
        return Ok(RepoMetadata {
            error: Some("Not a Git repository (no .git metadata found).".to_string()),
            ..base
        });
    }

    let git_root = git_output(&path_buf, &["rev-parse", "--show-toplevel"]).ok();

    let abbrev = git_output(&path_buf, &["rev-parse", "--abbrev-ref", "HEAD"]).ok();
    let detached = abbrev.as_deref() == Some("HEAD");

    let branch = if detached {
        None
    } else {
        abbrev.clone()
    };

    let head_short = git_output(&path_buf, &["rev-parse", "--short", "HEAD"]).ok();

    let log_line = git_output(
        &path_buf,
        &[
            "log",
            "-1",
            "--format=%s|%an|%aI",
        ],
    )
    .ok();

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

    let ab = git_output_allow_fail(&path_buf, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
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

    Ok(RepoMetadata {
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
    })
}
