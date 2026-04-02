use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_repr::Deserialize_repr;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub fetch_url: String,
}

/// `git log` line format for graph / commit list (`%P` = parents, `%aI` = ISO date).
const COMMIT_LOG_FORMAT: &str = "%H%x1f%P%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub author_email: String,
    pub date: String,
    /// Parent commit hashes (first parent is mainline; merge commits have 2+).
    pub parent_hashes: Vec<String>,
    /// When this commit is a stash WIP (`stash@{n}`), set for UI labels.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stash_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCoAuthor {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub author_email: String,
    pub author_date: String,
    pub committer: String,
    pub committer_email: String,
    pub committer_date: String,
    pub parent_hashes: Vec<String>,
    pub co_authors: Vec<CommitCoAuthor>,
}

/// One page from `list_graph_commits` / `list_branch_commits`. `has_more` is true when Git returned a full page (there may be older commits).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommitsPage {
    pub commits: Vec<CommitEntry>,
    pub has_more: bool,
}

/// `git log -n` cap per request. We fetch one extra row to know whether another page exists.
const GRAPH_COMMITS_PAGE_SIZE: usize = 500;

static CLONE_SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

fn next_clone_session_id() -> u64 {
    CLONE_SESSION_SEQ.fetch_add(1, Ordering::SeqCst) + 1
}

static GIT_STREAM_SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

fn next_git_stream_session_id() -> u64 {
    GIT_STREAM_SESSION_SEQ.fetch_add(1, Ordering::SeqCst) + 1
}

/// Emitted when a hook-heavy `git` invocation begins (`git-command-stream-started`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandStreamStartedEvent {
    pub session_id: u64,
    pub repo_path: String,
    pub operation: String,
    pub command_line: String,
}

/// One line from stdout or stderr (`git-command-stream-line`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandStreamLineEvent {
    pub session_id: u64,
    pub repo_path: String,
    pub operation: String,
    pub stream: String,
    pub line: String,
}

/// Emitted after the child exits (`git-command-stream-finished`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandStreamFinishedEvent {
    pub session_id: u64,
    pub repo_path: String,
    pub operation: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Runs `git` with piped stdout/stderr, optionally writes stdin, streams lines to the webview,
/// writes the audit log, and returns `Err` with stderr (or a generic message) on failure.
fn run_git_streaming_with_input(
    app: &AppHandle,
    repo_path_str: &str,
    workdir: &Path,
    args: &[&str],
    operation: &str,
    stdin_text: Option<&str>,
) -> Result<(), String> {
    let session_id = next_git_stream_session_id();
    let repo_owned = repo_path_str.to_string();
    let op_owned = operation.to_string();
    let command_line = format!("git {}", args.join(" "));
    let _ = app.emit(
        "git-command-stream-started",
        GitCommandStreamStartedEvent {
            session_id,
            repo_path: repo_owned.clone(),
            operation: op_owned.clone(),
            command_line,
        },
    );

    let mut cmd = git_cmd(workdir);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin_text.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not run git: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git: no stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "git: no stderr".to_string())?;

    let stderr_acc = Arc::new(Mutex::new(String::new()));

    let app_out = app.clone();
    let rp_out = repo_owned.clone();
    let op_out = op_owned.clone();
    let h_out = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let trimmed = line.trim_end().to_string();
            if trimmed.is_empty() {
                continue;
            }
            let _ = app_out.emit(
                "git-command-stream-line",
                GitCommandStreamLineEvent {
                    session_id,
                    repo_path: rp_out.clone(),
                    operation: op_out.clone(),
                    stream: "stdout".into(),
                    line: trimmed,
                },
            );
        }
    });

    let app_err = app.clone();
    let stderr_acc_clone = stderr_acc.clone();
    let rp_err = repo_owned.clone();
    let op_err = op_owned.clone();
    let h_err = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let trimmed = line.trim_end().to_string();
            if trimmed.is_empty() {
                continue;
            }
            let _ = app_err.emit(
                "git-command-stream-line",
                GitCommandStreamLineEvent {
                    session_id,
                    repo_path: rp_err.clone(),
                    operation: op_err.clone(),
                    stream: "stderr".into(),
                    line: trimmed.clone(),
                },
            );
            if let Ok(mut g) = stderr_acc_clone.lock() {
                if !g.is_empty() {
                    g.push('\n');
                }
                g.push_str(&trimmed);
            }
        }
    });

    if let Some(input) = stdin_text {
        let stdin_error = {
            let mut stdin = child.stdin.take();
            if let Some(stdin) = stdin.as_mut() {
                if let Err(e) = stdin.write_all(input.as_bytes()) {
                    Some(format!("Could not write command input to git: {e}"))
                } else if !input.ends_with('\n') {
                    match stdin.write_all(b"\n") {
                        Ok(_) => None,
                        Err(e) => Some(format!("Could not finalize command input for git: {e}")),
                    }
                } else {
                    None
                }
            } else {
                Some("git: no stdin".to_string())
            }
        };
        if let Some(msg) = stdin_error {
            let _ = child.kill();
            let _ = child.wait();
            let _ = h_out.join();
            let _ = h_err.join();
            write_git_audit_line(workdir, args, false, &msg);
            let _ = app.emit(
                "git-command-stream-finished",
                GitCommandStreamFinishedEvent {
                    session_id,
                    repo_path: repo_owned.clone(),
                    operation: op_owned.clone(),
                    success: false,
                    error: Some(msg.clone()),
                },
            );
            return Err(msg);
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Could not wait for git: {e}"))?;
    let _ = h_out.join();
    let _ = h_err.join();

    let ok = status.success();
    let stderr_text = stderr_acc
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_default();
    write_git_audit_line(workdir, args, ok, if ok { "" } else { &stderr_text });

    let err_msg = if ok {
        None
    } else if stderr_text.is_empty() {
        Some(format!("git {} failed", args.join(" ")))
    } else {
        Some(stderr_text.clone())
    };

    let _ = app.emit(
        "git-command-stream-finished",
        GitCommandStreamFinishedEvent {
            session_id,
            repo_path: repo_owned.clone(),
            operation: op_owned.clone(),
            success: ok,
            error: err_msg.clone(),
        },
    );

    if ok {
        Ok(())
    } else {
        Err(err_msg.unwrap_or_else(|| format!("git {} failed", args.join(" "))))
    }
}

/// Runs `git` with piped stdout/stderr, streams lines to the webview, writes the audit log, and
/// returns `Err` with stderr (or a generic message) on failure.
fn run_git_streaming(
    app: &AppHandle,
    repo_path_str: &str,
    workdir: &Path,
    args: &[&str],
    operation: &str,
) -> Result<(), String> {
    run_git_streaming_with_input(app, repo_path_str, workdir, args, operation, None)
}

async fn run_blocking_git_command<F>(task: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("Git command task failed: {e}"))?
}

/// Payload for [`start_clone_repository`] → `clone-progress` (stderr lines from `git clone --progress`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgressEvent {
    pub session_id: u64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
}

/// Final result for one clone session (`clone-complete`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneCompleteEvent {
    pub session_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Payload for [`start_commit_signature_check`] → `commit-signature-result` (webview listens).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSignatureResultEvent {
    pub path: String,
    pub commit_hash: String,
    pub request_id: u32,
    pub verified: Option<bool>,
}

/// Remote-tracking branch (`refs/remotes/...`) with tip OID.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranchEntry {
    pub name: String,
    pub tip_hash: String,
}

/// Tag (`refs/tags/...`) pointing at a commit (peeled OID for annotated tags).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagEntry {
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
pub struct LineStat {
    pub additions: u32,
    pub deletions: u32,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeFile {
    /// Path used for git commands (index / worktree); for renames, the new path.
    pub path: String,
    /// When set, the file is a rename from this path (UI may show `from → to`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rename_from: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged_stats: Option<LineStat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unstaged_stats: Option<LineStat>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
    pub head_hash: Option<String>,
    pub head_short: Option<String>,
    pub detached: bool,
    pub is_current: bool,
    pub changed_file_count: u32,
    pub staged_file_count: u32,
    pub unstaged_file_count: u32,
    pub untracked_file_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prunable_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardPathTarget {
    pub file_path: String,
    pub rename_from: Option<String>,
}

/// One entry from `git stash list` (`stash@{n}: message`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub ref_name: String,
    pub message: String,
    /// Tip commit OID for this stash (W commit).
    pub commit_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMetadata {
    pub path: String,
    pub name: String,
    pub git_root: Option<String>,
    pub error: Option<String>,
    pub branch: Option<String>,
    /// Full `HEAD` OID (`git rev-parse HEAD`); used to scope exports to the checked-out branch.
    pub head_hash: Option<String>,
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

static GIT_AUDIT_LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
static GIT_HOOK_ENV_OVERRIDES: Mutex<Option<Vec<(String, String)>>> = Mutex::new(None);

/// Rotate before the log exceeds this size (append of one line can push slightly over until next write).
const GIT_AUDIT_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// After rotation, keep this many bytes from the end of the file (recent entries only).
const GIT_AUDIT_LOG_KEEP_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// Set once from Tauri setup (app config dir). When set, every `git` invocation is appended as a line.
pub fn set_git_audit_log_path(p: Option<PathBuf>) {
    if let Ok(mut g) = GIT_AUDIT_LOG_PATH.lock() {
        *g = p;
    }
}

fn augmented_path_for_git_hooks() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let mut prefixes: Vec<String> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        prefixes.push("/opt/homebrew/bin".into());
        prefixes.push("/usr/local/bin".into());
    }
    #[cfg(target_os = "linux")]
    {
        prefixes.push("/usr/local/bin".into());
    }
    #[cfg(target_os = "windows")]
    {
        prefixes.push(r"C:\Program Files\Git\cmd".into());
    }
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        prefixes.push(format!("{home}/.local/share/pnpm"));
        prefixes.push(format!("{home}/.local/bin"));
        prefixes.push(format!("{home}/.cargo/bin"));
    }
    prefixes.push(base);
    prefixes.join(":")
}

fn is_shell_env_var_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c == '_' || c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn should_forward_shell_env_var(name: &str) -> bool {
    !matches!(
        name,
        "_" | "OLDPWD" | "PROMPT" | "PROMPT_COMMAND" | "PS1" | "PWD" | "RPS1" | "RPROMPT" | "SHLVL"
    )
}

#[cfg(not(target_os = "windows"))]
fn shell_env_command_attempts() -> Vec<Vec<String>> {
    vec![
        vec!["-i".into(), "-l".into(), "-c".into(), "env".into()],
        vec!["-l".into(), "-c".into(), "env".into()],
        vec!["-c".into(), "env".into()],
    ]
}

#[cfg(not(target_os = "windows"))]
fn resolve_shell_env_for_git_hooks() -> Option<Vec<(String, String)>> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            #[cfg(target_os = "macos")]
            {
                "/bin/zsh".to_string()
            }
            #[cfg(not(target_os = "macos"))]
            {
                "/bin/sh".to_string()
            }
        });

    for args in shell_env_command_attempts() {
        let output = match Command::new(&shell)
            .args(&args)
            .stdin(Stdio::null())
            .output()
        {
            Ok(output) => output,
            Err(_) => continue,
        };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut resolved: Vec<(String, String)> = stdout
            .lines()
            .filter_map(|line| {
                let (name, value) = line.split_once('=')?;
                let name = name.trim();
                if !is_shell_env_var_name(name) || !should_forward_shell_env_var(name) {
                    return None;
                }
                Some((name.to_string(), value.to_string()))
            })
            .collect();
        if resolved.iter().all(|(name, _)| name != "PATH") {
            resolved.push(("PATH".into(), augmented_path_for_git_hooks()));
        }
        if !resolved.is_empty() {
            return Some(resolved);
        }
    }
    None
}

fn git_hook_env_overrides() -> Vec<(String, String)> {
    if let Ok(guard) = GIT_HOOK_ENV_OVERRIDES.lock() {
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
    }

    #[cfg(not(target_os = "windows"))]
    let resolved = resolve_shell_env_for_git_hooks()
        .unwrap_or_else(|| vec![("PATH".into(), augmented_path_for_git_hooks())]);

    #[cfg(target_os = "windows")]
    let resolved = vec![("PATH".into(), augmented_path_for_git_hooks())];

    if let Ok(mut guard) = GIT_HOOK_ENV_OVERRIDES.lock() {
        if guard.is_none() {
            *guard = Some(resolved.clone());
        }
    }

    resolved
}

fn git_cmd(workdir: &Path) -> Command {
    let mut c = Command::new("git");
    c.current_dir(workdir);
    c.envs(git_hook_env_overrides());
    c
}

/// Drops older log lines from the start of the file so size stays bounded. Uses seek+read on the
/// tail only so an accidentally huge file is not read fully into memory.
fn trim_audit_log_if_needed(path: &Path, incoming_len: usize) -> std::io::Result<()> {
    let len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return Ok(()),
    };
    if len + incoming_len as u64 <= GIT_AUDIT_LOG_MAX_BYTES {
        return Ok(());
    }
    let mut f = std::fs::File::open(path)?;
    if len <= GIT_AUDIT_LOG_KEEP_TAIL_BYTES {
        return Ok(());
    }
    let start = len.saturating_sub(GIT_AUDIT_LOG_KEEP_TAIL_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut tail = Vec::new();
    f.read_to_end(&mut tail)?;
    if let Some(i) = tail.iter().position(|&b| b == b'\n') {
        tail.drain(..=i);
    }
    let header = format!(
        "# --- audit log truncated at {} (kept last ~{} MiB) ---\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        GIT_AUDIT_LOG_KEEP_TAIL_BYTES / (1024 * 1024)
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(&tail);
    std::fs::write(path, out)?;
    Ok(())
}

fn write_git_audit_line(cwd: &Path, args: &[&str], ok: bool, err: &str) {
    let path = match GIT_AUDIT_LOG_PATH.lock().ok().and_then(|g| g.clone()) {
        Some(p) => p,
        None => return,
    };
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let status = if ok { "ok" } else { "err" };
    let line = format!(
        "{ts}\t{}\tgit {}\t{}\t{}\n",
        cwd.display(),
        args.join(" "),
        status,
        err.replace('\n', " ")
    );
    let line_bytes = line.as_bytes();
    if let Err(e) = trim_audit_log_if_needed(&path, line_bytes.len()) {
        let _ = std::fs::write(
            &path,
            format!("# --- audit log reset (rotation failed: {e}) ---\n{}", line),
        );
        return;
    }
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(line_bytes));
}

fn git_output(workdir: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_cmd(workdir)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr.clone()
        };
        write_git_audit_line(workdir, args, false, &msg);
        return Err(msg);
    }
    let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
    write_git_audit_line(workdir, args, true, "");
    Ok(out)
}

fn git_output_raw(workdir: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_cmd(workdir)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr.clone()
        };
        write_git_audit_line(workdir, args, false, &msg);
        return Err(msg);
    }
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    write_git_audit_line(workdir, args, true, "");
    Ok(out)
}

fn git_config_bool(workdir: &Path, key: &str) -> bool {
    git_output(workdir, &["config", "--bool", "--get", key])
        .map(|value| matches!(value.trim(), "true" | "yes" | "on" | "1"))
        .unwrap_or(false)
}

fn commit_has_signature(workdir: &Path, hash: &str) -> bool {
    let Ok(flag) = git_output(workdir, &["log", "-1", "--format=%G?", hash]) else {
        return false;
    };
    let marker = flag.chars().next().unwrap_or(' ');
    !flag.is_empty() && marker != 'N'
}

fn git_output_with_input_and_env(
    workdir: &Path,
    args: &[&str],
    stdin_text: Option<&str>,
    extra_envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut cmd = git_cmd(workdir);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin_text.is_some() {
        cmd.stdin(Stdio::piped());
    }
    if !extra_envs.is_empty() {
        cmd.envs(extra_envs.iter().copied());
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not run git: {e}"))?;
    if let Some(input) = stdin_text {
        let stdin_error = {
            let mut stdin = child.stdin.take();
            if let Some(stdin) = stdin.as_mut() {
                if let Err(e) = stdin.write_all(input.as_bytes()) {
                    Some(format!("Could not write command input to git: {e}"))
                } else if !input.ends_with('\n') {
                    match stdin.write_all(b"\n") {
                        Ok(_) => None,
                        Err(e) => Some(format!("Could not finalize command input for git: {e}")),
                    }
                } else {
                    None
                }
            } else {
                Some("git: no stdin".to_string())
            }
        };
        if let Some(msg) = stdin_error {
            let _ = child.kill();
            let _ = child.wait();
            write_git_audit_line(workdir, args, false, &msg);
            return Err(msg);
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Could not wait for git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr.clone()
        };
        write_git_audit_line(workdir, args, false, &msg);
        return Err(msg);
    }
    let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
    write_git_audit_line(workdir, args, true, "");
    Ok(out)
}

fn run_git_apply_patch_streaming(
    app: &AppHandle,
    repo_path_str: &str,
    workdir: &Path,
    args: &[&str],
    operation: &str,
    patch: &str,
) -> Result<(), String> {
    let trimmed = patch.trim();
    if trimmed.is_empty() {
        return Err("Patch cannot be empty.".to_string());
    }
    run_git_streaming_with_input(app, repo_path_str, workdir, args, operation, Some(trimmed))
}

/// `git diff` / `git diff --no-index` use exit status 1 when there are differences (POSIX).
fn git_diff_output(workdir: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_cmd(workdir)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    let code = output.status.code().unwrap_or(-1);
    if code == 0 || code == 1 {
        write_git_audit_line(workdir, args, true, "");
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let msg = if stderr.is_empty() {
        format!("git {} failed (exit {code})", args.join(" "))
    } else {
        stderr.clone()
    };
    write_git_audit_line(workdir, args, false, &msg);
    Err(msg)
}

/// True if `path` is known to the index (tracked or staged).
fn git_path_known_to_git(workdir: &Path, rel: &str) -> bool {
    git_output(workdir, &["ls-files", "--error-unmatch", "--", rel]).is_ok()
}

fn git_output_allow_fail(workdir: &Path, args: &[&str]) -> Option<String> {
    git_cmd(workdir)
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

/// Default directory name `git clone <url>` uses when run with `current_dir` set to the parent folder.
fn clone_dir_name_from_url(url: &str) -> String {
    let mut s = url.trim();
    if let Some(rest) = s.strip_prefix("git@") {
        if let Some(idx) = rest.find(':') {
            s = &rest[idx + 1..];
        }
    }
    s = s.trim_end_matches(['/', '\\']);
    if let Some(stripped) = s.strip_suffix(".git") {
        s = stripped.trim_end_matches(['/', '\\']);
    }
    if let Some(idx) = s.rfind('/') {
        s = &s[idx + 1..];
    } else if let Some(idx) = s.rfind('\\') {
        s = &s[idx + 1..];
    }
    let name = s.trim();
    if name.is_empty() {
        return "repo".to_string();
    }
    name.to_string()
}

/// Prefer the largest `NN%` on the line (some `remote:` lines include multiple percentages).
fn parse_git_clone_progress_percent(line: &str) -> Option<u32> {
    let mut best: Option<u32> = None;
    for token in line.split_whitespace() {
        let t = token.trim_end_matches([',', ';', ')', '.']);
        if let Some(num) = t.strip_suffix('%') {
            if let Ok(n) = num.parse::<u32>() {
                let n = n.min(100);
                best = Some(best.map(|b| b.max(n)).unwrap_or(n));
            }
        }
    }
    best
}

/// Clone `remote_url` into a new subdirectory of `parent_path` (same default folder name as `git clone`).
///
/// Returns a session id **immediately** and runs `git clone` on a background thread so the IPC handler
/// does not block the webview. Progress is emitted on `clone-progress`; the final path or error on
/// `clone-complete`.
#[tauri::command]
pub fn start_clone_repository(
    app: AppHandle,
    parent_path: String,
    remote_url: String,
) -> Result<u64, String> {
    let parent = PathBuf::from(parent_path.trim());
    if !parent.is_dir() {
        return Err("That folder does not exist.".to_string());
    }
    let url = remote_url.trim();
    if url.is_empty() {
        return Err("Remote URL is empty.".to_string());
    }
    let dir_name = clone_dir_name_from_url(url);
    let dest = parent.join(&dir_name);
    if dest.exists() {
        return Err(format!(
            "A folder named \"{dir_name}\" already exists in that location."
        ));
    }

    let session_id = next_clone_session_id();
    let url_owned = url.to_string();
    let app_clone = app.clone();

    let _ = app.emit(
        "clone-progress",
        CloneProgressEvent {
            session_id,
            message: "Starting clone…".to_string(),
            percent: None,
        },
    );

    std::thread::spawn(move || {
        let result =
            run_git_clone_with_progress(app_clone.clone(), session_id, parent, url_owned, dest);
        let event = match result {
            Ok(path) => CloneCompleteEvent {
                session_id,
                path: Some(path),
                error: None,
            },
            Err(e) => CloneCompleteEvent {
                session_id,
                path: None,
                error: Some(e),
            },
        };
        let _ = app_clone.emit("clone-complete", event);
    });

    Ok(session_id)
}

fn run_git_clone_with_progress(
    app: AppHandle,
    session_id: u64,
    parent: PathBuf,
    url: String,
    dest: PathBuf,
) -> Result<String, String> {
    let mut child = git_cmd(&parent)
        .args(["clone", "--progress", &url])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run git: {e}"))?;

    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "git clone: no stderr pipe.".to_string())?;
    let mut stderr_acc = String::new();

    // `BufRead::lines()` waits for `\n`; git progress uses `\r` without newlines for long stretches,
    // which blocked the reader and froze the UI. Split on `\r` and `\n` as data arrives.
    fn next_delimiter(buf: &[u8]) -> Option<usize> {
        let n = buf.iter().position(|&b| b == b'\n');
        let r = buf.iter().position(|&b| b == b'\r');
        match (n, r) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        }
    }

    // Throttle to ~20 emits/s so large clones do not flood the IPC thread.
    const EMIT_MIN_INTERVAL: Duration = Duration::from_millis(50);
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut latest_msg = String::new();
    let mut latest_percent: Option<u32> = None;

    let mut process_segment = |trimmed: &str| {
        if trimmed.is_empty() {
            return;
        }
        stderr_acc.push_str(trimmed);
        stderr_acc.push('\n');
        let p = parse_git_clone_progress_percent(trimmed);
        latest_msg = trimmed.to_string();
        latest_percent = match (latest_percent, p) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };

        let now = Instant::now();
        if now.duration_since(last_emit) >= EMIT_MIN_INTERVAL && !latest_msg.is_empty() {
            let _ = app.emit(
                "clone-progress",
                CloneProgressEvent {
                    session_id,
                    message: latest_msg.clone(),
                    percent: latest_percent,
                },
            );
            last_emit = now;
        }
    };

    let mut buf: Vec<u8> = Vec::new();
    let mut read_chunk = [0u8; 16384];
    loop {
        let n = stderr
            .read(&mut read_chunk)
            .map_err(|e| format!("Could not read git clone output: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&read_chunk[..n]);
        while let Some(pos) = next_delimiter(&buf) {
            let piece = buf[..pos].to_vec();
            buf.drain(..pos + 1);
            let s = String::from_utf8_lossy(&piece);
            for segment in s.split('\r') {
                let trimmed = segment.trim();
                process_segment(trimmed);
            }
        }
    }

    if !buf.is_empty() {
        let s = String::from_utf8_lossy(&buf);
        for segment in s.split('\r') {
            let trimmed = segment.trim();
            process_segment(trimmed);
        }
    }

    if !latest_msg.is_empty() {
        let _ = app.emit(
            "clone-progress",
            CloneProgressEvent {
                session_id,
                message: latest_msg,
                percent: latest_percent,
            },
        );
    }

    let status = child
        .wait()
        .map_err(|e| format!("Could not wait for git clone: {e}"))?;
    if !status.success() {
        let tail = stderr_acc.trim();
        return Err(if tail.is_empty() {
            "git clone failed.".to_string()
        } else {
            tail.to_string()
        });
    }
    if !dest.is_dir() {
        return Err(
            "Clone finished but the expected folder was not created. Check the remote URL."
                .to_string(),
        );
    }
    Ok(dest.to_string_lossy().to_string())
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
        head_hash: None,
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

    let head_hash = git_output(&path_buf, &["rev-parse", "HEAD"]).ok();
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
        head_hash,
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

/// Parses `%(upstream:track)` from `git for-each-ref` (`[ahead N]`, `[behind N]`, both, empty = in sync, `[gone]`).
fn parse_upstream_track(s: &str) -> Option<(u32, u32)> {
    let s = s.trim();
    if s.is_empty() {
        return Some((0, 0));
    }
    if s.contains("gone") {
        return None;
    }
    fn num_after(s: &str, key: &str) -> Option<u32> {
        let i = s.find(key)?;
        let rest = s[i + key.len()..].trim_start();
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok()
    }
    let ahead = num_after(s, "ahead").unwrap_or(0);
    let behind = num_after(s, "behind").unwrap_or(0);
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
/// One `git for-each-ref` call (upstream + track via `%(upstream:track)`); no per-branch subprocesses.
#[tauri::command]
pub fn list_local_branches(path: String) -> Result<Vec<LocalBranchEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let out = git_output(
        &path_buf,
        &[
            "for-each-ref",
            "--format=%(objectname)\t%(refname:short)\t%(upstream:short)\t%(upstream:track)",
            "refs/heads/",
        ],
    )?;
    let mut entries = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(4, '\t');
        let Some(tip_hash) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(name) = parts.next().map(str::trim) else {
            continue;
        };
        let upstream_raw = parts.next().unwrap_or("").trim();
        let track_raw = parts.next().unwrap_or("").trim();
        if name.is_empty() || tip_hash.is_empty() {
            continue;
        }
        let tip_hash = tip_hash.to_string();
        let name = name.to_string();
        let (upstream_name, ahead, behind) = if upstream_raw.is_empty() {
            (None, None, None)
        } else {
            let upstream_name = Some(upstream_raw.to_string());
            match parse_upstream_track(track_raw) {
                None => (upstream_name, None, None),
                Some((a, b)) => (upstream_name, Some(a), Some(b)),
            }
        };
        entries.push(LocalBranchEntry {
            name,
            tip_hash,
            upstream_name,
            ahead,
            behind,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
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

/// All tags with the commit each tag points at (lightweight or peeled annotated).
#[tauri::command]
pub fn list_tags(path: String) -> Result<Vec<TagEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let out = git_output(
        &path_buf,
        &[
            "for-each-ref",
            "--sort=refname",
            "--sort=-creatordate",
            "refs/tags",
            "--format=%(refname:short)\t%(*objectname)\t%(objectname)",
        ],
    )?;
    let mut entries = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let Some(name) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(peeled) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(object) = parts.next().map(str::trim) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let tip_hash = if !peeled.is_empty() {
            peeled.to_string()
        } else {
            object.to_string()
        };
        if tip_hash.is_empty() {
            continue;
        }
        entries.push(TagEntry {
            name: name.to_string(),
            tip_hash,
        });
    }
    Ok(entries)
}

fn parse_commit_log_lines(out: &str) -> Vec<CommitEntry> {
    let mut commits = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(7, '\x1f');
        let hash = parts.next().map(String::from);
        let parents_raw = parts.next().map(String::from);
        let short_hash = parts.next().map(String::from);
        let author = parts.next().map(String::from);
        let author_email = parts.next().map(String::from);
        let date = parts.next().map(String::from);
        let subject = parts.next().map(String::from);
        if let (Some(h), Some(pr), Some(sh), Some(auth), Some(ae), Some(dt), Some(sub)) = (
            hash,
            parents_raw,
            short_hash,
            author,
            author_email,
            date,
            subject,
        ) {
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
                author_email: ae,
                date: dt,
                parent_hashes,
                stash_ref: None,
            });
        }
    }
    commits
}

fn parse_co_author_trailers(body: &str) -> Vec<CommitCoAuthor> {
    let mut out = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("Co-authored-by:") else {
            continue;
        };
        let value = rest.trim();
        if value.is_empty() {
            continue;
        }
        let (name, email) = if let Some(lt) = value.rfind('<') {
            let gt = value[lt..].find('>').map(|i| lt + i);
            if let Some(gt_idx) = gt {
                (
                    value[..lt].trim().to_string(),
                    value[lt + 1..gt_idx].trim().to_string(),
                )
            } else {
                (value.to_string(), String::new())
            }
        } else {
            (value.to_string(), String::new())
        };
        if name.is_empty() && email.is_empty() {
            continue;
        }
        if out
            .iter()
            .any(|entry: &CommitCoAuthor| entry.name == name && entry.email == email)
        {
            continue;
        }
        out.push(CommitCoAuthor { name, email });
    }
    out
}

fn trim_graph_commits_page(mut commits: Vec<CommitEntry>) -> GraphCommitsPage {
    let has_more = commits.len() > GRAPH_COMMITS_PAGE_SIZE;
    if has_more {
        commits.truncate(GRAPH_COMMITS_PAGE_SIZE);
    }
    GraphCommitsPage { commits, has_more }
}

/// `stash@{0}`, `stash@{1}`, … from `git stash list` (for `git log` starting points).
fn stash_ref_list(path: &Path) -> Result<Vec<String>, String> {
    ensure_git_repo(path)?;
    let text = git_output(path, &["stash", "list"])?;
    let mut refs = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("stash@{") else {
            continue;
        };
        let Some(end) = rest.find('}') else {
            continue;
        };
        let idx_str = &rest[..end];
        if idx_str.is_empty() || !idx_str.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        refs.push(format!("stash@{{{idx_str}}}"));
    }
    Ok(refs)
}

fn merge_stash_refs_into_log_refs(path: &Path, clean: &mut Vec<String>) {
    let Ok(stash_refs) = stash_ref_list(path) else {
        return;
    };
    for r in stash_refs {
        if !clean.contains(&r) {
            clean.push(r);
        }
    }
    clean.sort();
    clean.dedup();
}

fn annotate_stash_refs(path: &Path, commits: &mut [CommitEntry]) -> Result<(), String> {
    let stash_refs = stash_ref_list(path)?;
    if stash_refs.is_empty() {
        return Ok(());
    }
    let mut hash_to_ref: HashMap<String, String> = HashMap::new();
    for r in stash_refs {
        let h = git_output(path, &["rev-parse", "--verify", &r])?;
        let h = h.trim().to_string();
        if !h.is_empty() {
            hash_to_ref.insert(h, r);
        }
    }
    for c in commits.iter_mut() {
        if let Some(sr) = hash_to_ref.get(&c.hash) {
            c.stash_ref = Some(sr.clone());
        }
    }
    Ok(())
}

/// Commits reachable from any local branch (`--branches`), commit-date order, newest first.
#[tauri::command]
pub fn list_branch_commits(path: String) -> Result<GraphCommitsPage, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let fetch_n = (GRAPH_COMMITS_PAGE_SIZE + 1).to_string();
    let mut cmd_args: Vec<String> = vec![
        "log".into(),
        "--branches".into(),
        "--date-order".into(),
        "--skip".into(),
        "0".into(),
        "-n".into(),
        fetch_n,
        format!("--format={COMMIT_LOG_FORMAT}"),
    ];
    if let Ok(stash_refs) = stash_ref_list(&path_buf) {
        cmd_args.extend(stash_refs);
    }
    let args_ref: Vec<&str> = cmd_args.iter().map(|s| s.as_str()).collect();
    let out = git_output(&path_buf, &args_ref)?;
    let mut commits = parse_commit_log_lines(&out);
    annotate_stash_refs(&path_buf, &mut commits)?;
    Ok(trim_graph_commits_page(commits))
}

/// Commits reachable from the given refs (branch names like `main` or `origin/main`), commit-date order, newest first.
/// Stash entries (`stash@{n}`) are merged into the log so stashes appear by commit date with branch history.
/// Use `skip` 0 for the first page, then `skip` = loaded count for "load more".
#[tauri::command]
pub fn list_graph_commits(
    path: String,
    refs: Vec<String>,
    skip: u32,
) -> Result<GraphCommitsPage, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let mut clean: Vec<String> = refs
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    clean.sort();
    clean.dedup();
    merge_stash_refs_into_log_refs(&path_buf, &mut clean);
    if clean.is_empty() {
        return Ok(GraphCommitsPage {
            commits: Vec::new(),
            has_more: false,
        });
    }
    let fetch_n = (GRAPH_COMMITS_PAGE_SIZE + 1).to_string();
    let skip_s = skip.to_string();
    let mut cmd_args: Vec<String> = vec![
        "log".into(),
        "--date-order".into(),
        "--skip".into(),
        skip_s,
        "-n".into(),
        fetch_n,
        format!("--format={COMMIT_LOG_FORMAT}"),
    ];
    cmd_args.extend(clean);
    let args_ref: Vec<&str> = cmd_args.iter().map(|s| s.as_str()).collect();
    let out = git_output(&path_buf, &args_ref)?;
    let mut commits = parse_commit_log_lines(&out);
    annotate_stash_refs(&path_buf, &mut commits)?;
    Ok(trim_graph_commits_page(commits))
}

#[tauri::command]
pub fn get_commit_details(path: String, commit_hash: String) -> Result<CommitDetails, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let hash = commit_hash.trim();
    if hash.is_empty() {
        return Err("Commit hash cannot be empty.".to_string());
    }
    let spec = format!("{hash}^{{commit}}");
    git_output(&path_buf, &["rev-parse", "--verify", &spec])?;
    const DETAILS_FORMAT: &str =
        "%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%P";
    let format_arg = format!("--format={DETAILS_FORMAT}");
    let out = git_output(&path_buf, &["show", "-s", &format_arg, "--no-patch", hash])?;
    let trimmed = out.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.split('\0');
    let hash = parts.next().unwrap_or_default().to_string();
    let short_hash = parts.next().unwrap_or_default().to_string();
    let subject = parts.next().unwrap_or_default().to_string();
    let body = parts.next().unwrap_or_default().to_string();
    let author = parts.next().unwrap_or_default().to_string();
    let author_email = parts.next().unwrap_or_default().to_string();
    let author_date = parts.next().unwrap_or_default().to_string();
    let committer = parts.next().unwrap_or_default().to_string();
    let committer_email = parts.next().unwrap_or_default().to_string();
    let committer_date = parts.next().unwrap_or_default().to_string();
    let parent_hashes = parts
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if hash.is_empty() || short_hash.is_empty() {
        return Err("Failed to parse commit details.".to_string());
    }
    let co_authors = parse_co_author_trailers(&body);
    Ok(CommitDetails {
        hash,
        short_hash,
        subject,
        body,
        author,
        author_email,
        author_date,
        committer,
        committer_email,
        committer_date,
        parent_hashes,
        co_authors,
    })
}

#[tauri::command]
pub fn checkout_local_branch(app: AppHandle, path: String, branch: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    run_git_streaming(&app, &path, &path_buf, &["switch", &branch], "checkout")?;
    Ok(())
}

/// Create a new local branch at the current `HEAD` and switch to it.
#[tauri::command]
pub fn create_local_branch(app: AppHandle, path: String, branch: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let name = branch.trim();
    if name.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }
    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["switch", "-c", name],
        "create branch",
    )?;
    Ok(())
}

/// Create a new local branch at `commit` and switch to it (`git switch -c <branch> <start-point>`).
#[tauri::command]
pub fn create_branch_at_commit(
    app: AppHandle,
    path: String,
    branch: String,
    commit: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let name = branch.trim();
    if name.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }
    let commit = commit.trim();
    if commit.is_empty() {
        return Err("Commit cannot be empty.".to_string());
    }
    let verify_spec = format!("{commit}^{{commit}}");
    git_output(&path_buf, &["rev-parse", "--verify", &verify_spec])?;
    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["switch", "-c", name, commit],
        "create branch",
    )?;
    Ok(())
}

/// Create a tag at `commit`. With a non-empty `message`, creates an annotated tag (`git tag -a`).
#[tauri::command]
pub fn create_tag(
    app: AppHandle,
    path: String,
    tag: String,
    commit: String,
    message: Option<String>,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let tag = tag.trim();
    if tag.is_empty() {
        return Err("Tag name cannot be empty.".to_string());
    }
    let commit = commit.trim();
    if commit.is_empty() {
        return Err("Commit cannot be empty.".to_string());
    }
    let verify_spec = format!("{commit}^{{commit}}");
    git_output(&path_buf, &["rev-parse", "--verify", &verify_spec])?;
    let msg = message.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty());
    if let Some(m) = msg {
        run_git_streaming(
            &app,
            &path,
            &path_buf,
            &["tag", "-a", tag, "-m", m, commit],
            "create tag",
        )?;
    } else {
        run_git_streaming(&app, &path, &path_buf, &["tag", tag, commit], "create tag")?;
    }
    Ok(())
}

/// Delete a local tag (`git tag -d`).
#[tauri::command]
pub fn delete_tag(app: AppHandle, path: String, tag: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let tag = tag.trim();
    if tag.is_empty() {
        return Err("Tag name cannot be empty.".to_string());
    }
    run_git_streaming(&app, &path, &path_buf, &["tag", "-d", tag], "delete tag")?;
    Ok(())
}

/// Create a local branch from `remote_ref` (e.g. `origin/feature/foo`) and switch to it.
#[tauri::command]
pub fn create_branch_from_remote(
    app: AppHandle,
    path: String,
    remote_ref: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let Some(slash) = remote_ref.find('/') else {
        return Err("Invalid remote branch ref.".to_string());
    };
    let local_name = remote_ref[slash + 1..].trim();
    if local_name.is_empty() {
        return Err("Invalid remote branch ref.".to_string());
    }
    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["switch", "-c", local_name, remote_ref.as_str()],
        "create branch",
    )?;
    Ok(())
}

/// Delete a local branch (`git branch -d` or `-D` when `force`).
#[tauri::command]
pub fn delete_local_branch(
    app: AppHandle,
    path: String,
    branch: String,
    force: bool,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let name = branch.trim();
    if name.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }
    let flag = if force { "-D" } else { "-d" };
    match run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["branch", flag, "--", name],
        "delete branch",
    ) {
        Ok(_) => Ok(()),
        Err(e) => {
            if !force && e.contains("not fully merged") {
                Err(format!(
                    "{e}\n\nGit refuses to delete this branch because it still has commits that are not merged into your current branch (for example the branch you branched from, or main). Deleting it would make those commits harder to find. If you are sure you want to discard that work, use force delete (\"git branch -D …\"), which tells Git you accept losing those unmerged commits.",
                ))
            } else {
                Err(e)
            }
        }
    }
}

/// Delete a branch on the remote (`git push <remote> --delete <branch>`). `remote_ref` is e.g. `origin/feature/foo`.
fn delete_remote_branch_blocking(
    app: AppHandle,
    path: String,
    remote_ref: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let remote_ref = remote_ref.trim();
    let Some(slash) = remote_ref.find('/') else {
        return Err("Invalid remote branch ref.".to_string());
    };
    let remote = remote_ref[..slash].trim();
    let branch_on_remote = remote_ref[slash + 1..].trim();
    if remote.is_empty() || branch_on_remote.is_empty() {
        return Err("Invalid remote branch ref.".to_string());
    }
    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["push", remote, "--delete", branch_on_remote],
        "push",
    )?;
    Ok(())
}

#[tauri::command]
pub async fn delete_remote_branch(
    app: AppHandle,
    path: String,
    remote_ref: String,
) -> Result<(), String> {
    run_blocking_git_command(move || delete_remote_branch_blocking(app, path, remote_ref)).await
}

/// Fetch URL for a named remote (`git remote get-url <name>`).
#[tauri::command]
pub fn get_remote_url(path: String, remote_name: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let name = remote_name.trim();
    if name.is_empty() {
        return Err("Remote name cannot be empty.".to_string());
    }
    git_output(&path_buf, &["remote", "get-url", name])
}

/// Set URL for a named remote (`git remote set-url <name> <newurl>`).
#[tauri::command]
pub fn set_remote_url(
    app: AppHandle,
    path: String,
    remote_name: String,
    url: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let name = remote_name.trim();
    let url = url.trim();
    if name.is_empty() {
        return Err("Remote name cannot be empty.".to_string());
    }
    if url.is_empty() {
        return Err("Remote URL cannot be empty.".to_string());
    }
    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["remote", "set-url", "--", name, url],
        "set remote url",
    )?;
    Ok(())
}

/// Rebase the current branch onto `onto` (local branch name or remote ref such as `origin/main`).
/// With `interactive`, runs `git rebase -i` using the user's configured sequence/core editor.
#[tauri::command]
pub fn rebase_current_branch_onto(
    app: AppHandle,
    path: String,
    onto: String,
    interactive: bool,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let onto = onto.trim();
    if onto.is_empty() {
        return Err("Branch or ref is empty.".to_string());
    }
    let verify_spec = format!("{onto}^{{commit}}");
    git_output(&path_buf, &["rev-parse", "--verify", &verify_spec])?;
    if interactive {
        run_git_streaming(&app, &path, &path_buf, &["rebase", "-i", onto], "rebase")?;
    } else {
        run_git_streaming(&app, &path, &path_buf, &["rebase", onto], "rebase")?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize_repr)]
#[repr(u8)]
pub enum ResetMode {
    Soft = 0,
    Hard = 1,
}

/// Reset the checked-out branch to `commit_hash` using `git reset --soft` or `git reset --hard`.
#[tauri::command]
pub fn reset_current_branch_to_commit(
    app: AppHandle,
    path: String,
    commit_hash: String,
    mode: ResetMode,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let hash = commit_hash.trim();
    if hash.is_empty() {
        return Err("Commit hash cannot be empty.".to_string());
    }
    let flag = match mode {
        ResetMode::Soft => "--soft",
        ResetMode::Hard => "--hard",
    };

    git_output(&path_buf, &["symbolic-ref", "--quiet", "--short", "HEAD"]).map_err(|_| {
        "Reset to commit requires the current branch to be checked out.".to_string()
    })?;

    let verify_spec = format!("{hash}^{{commit}}");
    let resolved_hash = git_output(&path_buf, &["rev-parse", "--verify", &verify_spec])?;
    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["reset", flag, &resolved_hash],
        "reset",
    )?;
    Ok(())
}

/// Drop a single commit from the current branch by rebasing its descendants onto the commit's
/// parent (`git rebase --onto <parent> <commit>`). Limited to non-merge commits on HEAD's
/// first-parent history.
#[tauri::command]
pub fn drop_commit(app: AppHandle, path: String, commit_hash: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let hash = commit_hash.trim();
    if hash.is_empty() {
        return Err("Commit hash cannot be empty.".to_string());
    }

    git_output(&path_buf, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|_| "Drop commit requires the current branch to be checked out.".to_string())?;

    let verify_spec = format!("{hash}^{{commit}}");
    let resolved_hash = git_output(&path_buf, &["rev-parse", "--verify", &verify_spec])?;

    let parents_line = git_output(
        &path_buf,
        &["rev-list", "--parents", "-n", "1", &resolved_hash],
    )?;
    let mut parts = parents_line.split_whitespace();
    let _ = parts.next();
    let parents: Vec<&str> = parts.collect();
    if parents.is_empty() {
        return Err("Dropping the root commit is not supported.".to_string());
    }
    if parents.len() > 1 {
        return Err("Dropping merge commits is not supported yet.".to_string());
    }
    let parent_hash = parents[0];

    let merge_base_args = ["merge-base", "--is-ancestor", &resolved_hash, "HEAD"];
    let ancestor_status = git_cmd(&path_buf)
        .args(merge_base_args)
        .status()
        .map_err(|e| format!("Could not run git: {e}"))?;
    write_git_audit_line(
        &path_buf,
        &merge_base_args,
        ancestor_status.success(),
        if ancestor_status.success() {
            ""
        } else {
            "Commit is not on the current branch."
        },
    );
    match ancestor_status.code() {
        Some(0) => {}
        Some(1) => {
            return Err("Only commits on the current branch can be dropped.".to_string());
        }
        _ => {
            return Err(
                "Could not verify whether the commit is on the current branch.".to_string(),
            );
        }
    }

    let first_parent_history = git_output(&path_buf, &["rev-list", "--first-parent", "HEAD"])?;
    if !first_parent_history
        .lines()
        .any(|line| line.trim() == resolved_hash)
    {
        return Err(
            "Only commits on the current branch's primary history can be dropped.".to_string(),
        );
    }

    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["rebase", "--onto", parent_hash, &resolved_hash],
        "drop commit",
    )?;
    Ok(())
}

/// Squash a contiguous selection of non-merge commits on the current branch's first-parent
/// history into one commit, then replay any newer descendants on top of the squashed commit.
#[tauri::command]
pub fn squash_commits(
    app: AppHandle,
    path: String,
    commit_hashes: Vec<String>,
    message: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let trimmed_message = message.trim();
    if trimmed_message.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }

    git_output(&path_buf, &["symbolic-ref", "--quiet", "--short", "HEAD"]).map_err(|_| {
        "Squashing commits requires the current branch to be checked out.".to_string()
    })?;

    let tracked_status = git_output(
        &path_buf,
        &["status", "--porcelain", "--untracked-files=no"],
    )?;
    if !tracked_status.is_empty() {
        return Err("Squashing commits requires a clean index and working tree.".to_string());
    }

    let mut resolved_hashes: Vec<String> = Vec::new();
    for raw_hash in commit_hashes {
        let trimmed_hash = raw_hash.trim();
        if trimmed_hash.is_empty() {
            continue;
        }
        let verify_spec = format!("{trimmed_hash}^{{commit}}");
        let resolved_hash = git_output(&path_buf, &["rev-parse", "--verify", &verify_spec])?;
        if !resolved_hashes
            .iter()
            .any(|existing| existing == &resolved_hash)
        {
            resolved_hashes.push(resolved_hash);
        }
    }
    if resolved_hashes.len() < 2 {
        return Err("Select at least two commits to squash.".to_string());
    }

    let first_parent_history = git_output(&path_buf, &["rev-list", "--first-parent", "HEAD"])?;
    let first_parent_hashes: Vec<&str> = first_parent_history
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let Some(head_hash) = first_parent_hashes.first().map(|line| (*line).to_string()) else {
        return Err("Could not read the current branch history.".to_string());
    };
    let mut first_parent_index_by_hash: HashMap<&str, usize> = HashMap::new();
    for (index, hash) in first_parent_hashes.iter().enumerate() {
        first_parent_index_by_hash.insert(*hash, index);
    }

    let mut selected_in_history: Vec<(usize, String)> = Vec::new();
    for resolved_hash in resolved_hashes {
        let Some(index) = first_parent_index_by_hash.get(resolved_hash.as_str()) else {
            return Err(
                "Only commits on the current branch's primary history can be squashed.".to_string(),
            );
        };
        selected_in_history.push((*index, resolved_hash));
    }
    selected_in_history.sort_by_key(|(index, _)| *index);

    for window in selected_in_history.windows(2) {
        if window[1].0 != window[0].0 + 1 {
            return Err(
                "Selected commits must be consecutive on the current branch's primary history."
                    .to_string(),
            );
        }
    }

    for (_, hash) in &selected_in_history {
        let parents_line = git_output(&path_buf, &["rev-list", "--parents", "-n", "1", hash])?;
        let mut parts = parents_line.split_whitespace();
        let _ = parts.next();
        let parents: Vec<&str> = parts.collect();
        if parents.is_empty() {
            return Err("Squashing the root commit is not supported yet.".to_string());
        }
        if parents.len() > 1 {
            return Err("Squashing merge commits is not supported yet.".to_string());
        }
    }

    let newest_hash = selected_in_history
        .first()
        .map(|(_, hash)| hash.clone())
        .ok_or_else(|| "Select at least two commits to squash.".to_string())?;
    let oldest_hash = selected_in_history
        .last()
        .map(|(_, hash)| hash.clone())
        .ok_or_else(|| "Select at least two commits to squash.".to_string())?;
    let base_parent_hash = git_output(
        &path_buf,
        &["rev-parse", "--verify", &format!("{oldest_hash}^")],
    )?;
    let squashed_tree_hash = git_output(
        &path_buf,
        &["rev-parse", "--verify", &format!("{newest_hash}^{{tree}}")],
    )?;

    let author_line = git_output(
        &path_buf,
        &["show", "-s", "--format=%an%x00%ae%x00%aI", &oldest_hash],
    )?;
    let mut author_parts = author_line.split('\0');
    let author_name = author_parts.next().unwrap_or_default().trim().to_string();
    let author_email = author_parts.next().unwrap_or_default().trim().to_string();
    let author_date = author_parts.next().unwrap_or_default().trim().to_string();
    if author_name.is_empty() || author_email.is_empty() || author_date.is_empty() {
        return Err("Failed to determine the squashed commit author.".to_string());
    }

    let author_env = [
        ("GIT_AUTHOR_NAME", author_name.as_str()),
        ("GIT_AUTHOR_EMAIL", author_email.as_str()),
        ("GIT_AUTHOR_DATE", author_date.as_str()),
    ];
    let squashed_hash = git_output_with_input_and_env(
        &path_buf,
        &["commit-tree", &squashed_tree_hash, "-p", &base_parent_hash],
        Some(trimmed_message),
        &author_env,
    )?;

    if newest_hash == head_hash {
        run_git_streaming(
            &app,
            &path,
            &path_buf,
            &["reset", "--soft", &squashed_hash],
            "squash commits",
        )?;
        return Ok(());
    }

    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["rebase", "--onto", &squashed_hash, &newest_hash],
        "squash commits",
    )?;
    Ok(())
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

/// `git diff --numstat` / `diff-tree --numstat` lines: `additions TAB deletions TAB path` (`-` `-` for binary).
/// Renames use `oldname => newname` in the path field; we key stats by **new** path.
fn parse_numstat_output(out: &str) -> HashMap<String, LineStat> {
    let mut m = HashMap::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let add_s = parts.next().unwrap_or("");
        let del_s = parts.next().unwrap_or("");
        let path_raw = parts.next().unwrap_or("").to_string();
        if path_raw.is_empty() {
            continue;
        }
        let path = if path_raw.contains(" => ") {
            path_raw
                .split(" => ")
                .last()
                .unwrap_or(path_raw.as_str())
                .to_string()
        } else {
            path_raw
        };
        let is_binary = add_s == "-" && del_s == "-";
        let stat = if is_binary {
            LineStat {
                additions: 0,
                deletions: 0,
                is_binary: true,
            }
        } else {
            let additions = add_s.parse().unwrap_or(0);
            let deletions = del_s.parse().unwrap_or(0);
            LineStat {
                additions,
                deletions,
                is_binary: false,
            }
        };
        m.insert(path, stat);
    }
    m
}

fn numstat_line_stats(workdir: &Path, args: &[&str]) -> Result<HashMap<String, LineStat>, String> {
    let out = git_output(workdir, args)?;
    Ok(parse_numstat_output(&out))
}

fn line_stat_untracked_file(workdir: &Path, rel: &str) -> LineStat {
    let full = workdir.join(rel);
    let Ok(bytes) = std::fs::read(&full) else {
        return LineStat {
            additions: 0,
            deletions: 0,
            is_binary: false,
        };
    };
    if bytes.contains(&0) {
        return LineStat {
            additions: 0,
            deletions: 0,
            is_binary: true,
        };
    }
    let text = String::from_utf8_lossy(&bytes);
    let additions = text.lines().count() as u32;
    LineStat {
        additions,
        deletions: 0,
        is_binary: false,
    }
}

#[derive(Debug, Clone)]
struct WtAcc {
    path: String,
    rename_from: Option<String>,
    staged: bool,
    unstaged: bool,
    untracked: bool,
}

#[derive(Debug, Default, Clone, Copy)]
struct WorktreeStatusSummary {
    changed_file_count: u32,
    staged_file_count: u32,
    unstaged_file_count: u32,
    untracked_file_count: u32,
}

#[derive(Debug, Default, Clone)]
struct WorktreeListAcc {
    path: String,
    branch: Option<String>,
    head_hash: Option<String>,
    detached: bool,
    locked_reason: Option<String>,
    prunable_reason: Option<String>,
}

fn parse_porcelain_xy(xy: &str) -> Option<(bool, bool, bool)> {
    if xy.len() != 2 {
        return None;
    }
    let mut it = xy.chars();
    let x = it.next()?;
    let y = it.next()?;
    if x == '?' && y == '?' {
        return Some((false, true, true));
    }
    let staged = x != ' ' && x != '?';
    let unstaged = y != ' ';
    Some((staged, unstaged, false))
}

fn parse_porcelain_v1_z(out: &str) -> Vec<WtAcc> {
    let mut entries = Vec::new();
    let mut fields = out.split('\0').filter(|field| !field.is_empty());
    while let Some(entry) = fields.next() {
        if entry.len() < 4 {
            continue;
        }
        let xy = &entry[0..2];
        if entry.as_bytes().get(2) != Some(&b' ') {
            continue;
        }
        let Some((staged, unstaged, untracked)) = parse_porcelain_xy(xy) else {
            continue;
        };
        let path = entry[3..].to_string();
        if path.is_empty() {
            continue;
        }
        let rename_from = if xy.contains('R') || xy.contains('C') {
            fields
                .next()
                .filter(|field| !field.is_empty())
                .map(str::to_string)
        } else {
            None
        };
        entries.push(WtAcc {
            path,
            rename_from,
            staged,
            unstaged,
            untracked,
        });
    }
    entries
}

fn normalize_worktree_branch_name(branch: Option<String>) -> Option<String> {
    branch.and_then(|name| {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            None
        } else if let Some(short) = trimmed.strip_prefix("refs/heads/") {
            Some(short.to_string())
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn short_oid(oid: &str) -> String {
    let trimmed = oid.trim();
    if trimmed.chars().count() <= 7 {
        trimmed.to_string()
    } else {
        trimmed.chars().take(7).collect()
    }
}

fn normalize_existing_path(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn summarize_worktree_status(workdir: &Path) -> Result<WorktreeStatusSummary, String> {
    ensure_git_repo(workdir)?;
    let porcelain = git_output_raw(
        workdir,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--find-renames",
            "-z",
        ],
    )?;
    let mut map: HashMap<String, WtAcc> = HashMap::new();
    for acc in parse_porcelain_v1_z(&porcelain) {
        let path_key = acc.path.clone();
        map.entry(path_key.clone())
            .and_modify(|e| {
                e.staged |= acc.staged;
                e.unstaged |= acc.unstaged;
                e.untracked |= acc.untracked;
                if acc.rename_from.is_some() {
                    e.rename_from = acc.rename_from.clone();
                }
            })
            .or_insert(acc);
    }
    let mut summary = WorktreeStatusSummary::default();
    summary.changed_file_count = map.len() as u32;
    for entry in map.values() {
        if entry.staged {
            summary.staged_file_count += 1;
        }
        if entry.unstaged || entry.untracked {
            summary.unstaged_file_count += 1;
        }
        if entry.untracked {
            summary.untracked_file_count += 1;
        }
    }
    Ok(summary)
}

fn parse_worktree_list_porcelain(out: &str) -> Vec<WorktreeListAcc> {
    let mut entries = Vec::new();
    let mut current = WorktreeListAcc::default();
    for line in out.lines() {
        if line.trim().is_empty() {
            if !current.path.is_empty() {
                entries.push(current);
            }
            current = WorktreeListAcc::default();
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            current.path = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            let hash = rest.trim();
            current.head_hash = if hash.is_empty() {
                None
            } else {
                Some(hash.to_string())
            };
        } else if let Some(rest) = line.strip_prefix("branch ") {
            current.branch = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("locked") {
            let reason = rest.trim();
            current.locked_reason = (!reason.is_empty()).then(|| reason.to_string());
        } else if let Some(rest) = line.strip_prefix("prunable") {
            let reason = rest.trim();
            current.prunable_reason = (!reason.is_empty()).then(|| reason.to_string());
        } else if line.trim() == "detached" {
            current.detached = true;
        }
    }
    if !current.path.is_empty() {
        entries.push(current);
    }
    entries
}

/// Combined working tree file list for the UI (staged / unstaged flags per path).
/// Uses `git status --porcelain -z --untracked-files=all` so renames appear as a single row
/// and untracked files inside untracked directories are listed as full paths.
#[tauri::command]
pub fn list_working_tree_files(path: String) -> Result<Vec<WorkingTreeFile>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let porcelain = git_output_raw(
        &path_buf,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--find-renames",
            "-z",
        ],
    )?;
    let mut map: HashMap<String, WtAcc> = HashMap::new();
    for acc in parse_porcelain_v1_z(&porcelain) {
        let path_key = acc.path.clone();
        map.entry(path_key.clone())
            .and_modify(|e| {
                e.staged |= acc.staged;
                e.unstaged |= acc.unstaged;
                e.untracked |= acc.untracked;
                if acc.rename_from.is_some() {
                    e.rename_from = acc.rename_from.clone();
                }
            })
            .or_insert(acc);
    }

    let (staged_map, unstaged_map) = std::thread::scope(|s| {
        let p = &path_buf;
        let h4 =
            s.spawn(|| numstat_line_stats(p, &["diff", "--cached", "--find-renames", "--numstat"]));
        let h5 = s.spawn(|| numstat_line_stats(p, &["diff", "--find-renames", "--numstat"]));
        let staged_map = h4.join().unwrap()?;
        let unstaged_map = h5.join().unwrap()?;
        Ok::<_, String>((staged_map, unstaged_map))
    })?;

    let mut paths: Vec<String> = map.keys().cloned().collect();
    paths.sort();
    Ok(paths
        .into_iter()
        .filter_map(|p| map.get(&p).cloned())
        .map(|acc| {
            let staged = acc.staged;
            let unstaged = acc.unstaged || acc.untracked;
            let staged_stats = if staged && !acc.untracked {
                Some(staged_map.get(&acc.path).cloned().unwrap_or(LineStat {
                    additions: 0,
                    deletions: 0,
                    is_binary: false,
                }))
            } else {
                None
            };
            let unstaged_stats = if unstaged {
                Some(if acc.untracked {
                    line_stat_untracked_file(&path_buf, &acc.path)
                } else if let Some(s) = unstaged_map.get(&acc.path) {
                    s.clone()
                } else {
                    LineStat {
                        additions: 0,
                        deletions: 0,
                        is_binary: false,
                    }
                })
            } else {
                None
            };
            WorkingTreeFile {
                path: acc.path,
                rename_from: acc.rename_from,
                staged,
                unstaged,
                staged_stats,
                unstaged_stats,
            }
        })
        .collect())
}

/// All worktrees known to this repository, including the currently open checkout.
#[tauri::command]
pub fn list_worktrees(path: String) -> Result<Vec<WorktreeEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let current_norm = normalize_existing_path(&path_buf);
    let out = git_output_raw(&path_buf, &["worktree", "list", "--porcelain"])?;
    let mut entries = parse_worktree_list_porcelain(&out)
        .into_iter()
        .map(|acc| {
            let worktree_path = PathBuf::from(&acc.path);
            let summary = if worktree_path.is_dir() {
                summarize_worktree_status(&worktree_path).unwrap_or_default()
            } else {
                WorktreeStatusSummary::default()
            };
            let is_current = if worktree_path.exists() {
                normalize_existing_path(&worktree_path) == current_norm
            } else {
                acc.path == path
            };
            WorktreeEntry {
                path: acc.path,
                branch: normalize_worktree_branch_name(acc.branch),
                head_hash: acc.head_hash.clone(),
                head_short: acc.head_hash.as_deref().map(short_oid),
                detached: acc.detached,
                is_current,
                changed_file_count: summary.changed_file_count,
                staged_file_count: summary.staged_file_count,
                unstaged_file_count: summary.unstaged_file_count,
                untracked_file_count: summary.untracked_file_count,
                locked_reason: acc.locked_reason,
                prunable_reason: acc.prunable_reason,
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
    Ok(entries)
}

/// Remove a linked worktree (`git worktree remove`).
#[tauri::command]
pub fn remove_worktree(
    app: AppHandle,
    path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let target = worktree_path.trim();
    if target.is_empty() {
        return Err("Worktree path is empty.".to_string());
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--");
    args.push(target);
    run_git_streaming(&app, &path, &path_buf, &args, "remove worktree")?;
    Ok(())
}

#[tauri::command]
pub fn stage_paths(app: AppHandle, path: String, paths: Vec<String>) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<String> = vec!["add".into(), "--".into()];
    args.extend(paths);
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git_streaming(&app, &path, &path_buf, &args_ref, "stage")?;
    Ok(())
}

#[tauri::command]
pub fn stage_patch(app: AppHandle, path: String, patch: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    run_git_apply_patch_streaming(
        &app,
        &path,
        &path_buf,
        &[
            "apply",
            "--cached",
            "--unidiff-zero",
            "--recount",
            "--whitespace=nowarn",
        ],
        "stage",
        &patch,
    )?;
    Ok(())
}

#[tauri::command]
pub fn unstage_paths(app: AppHandle, path: String, paths: Vec<String>) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<String> = vec!["restore".into(), "--staged".into(), "--".into()];
    args.extend(paths);
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git_streaming(&app, &path, &path_buf, &args_ref, "unstage")?;
    Ok(())
}

#[tauri::command]
pub fn unstage_patch(app: AppHandle, path: String, patch: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    run_git_apply_patch_streaming(
        &app,
        &path,
        &path_buf,
        &[
            "apply",
            "--cached",
            "--reverse",
            "--unidiff-zero",
            "--recount",
            "--whitespace=nowarn",
        ],
        "unstage",
        &patch,
    )?;
    Ok(())
}

#[tauri::command]
pub fn discard_patch(app: AppHandle, path: String, patch: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    run_git_apply_patch_streaming(
        &app,
        &path,
        &path_buf,
        &[
            "apply",
            "--reverse",
            "--unidiff-zero",
            "--recount",
            "--whitespace=nowarn",
        ],
        "discard changes",
        &patch,
    )?;
    Ok(())
}

fn push_unique_path(paths: &mut Vec<String>, seen: &mut HashSet<String>, rel: &str) {
    if seen.insert(rel.to_string()) {
        paths.push(rel.to_string());
    }
}

fn discard_paths_changes_inner(
    app: &AppHandle,
    path: &str,
    path_buf: &Path,
    files: &[DiscardPathTarget],
    from_unstaged: bool,
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }

    if from_unstaged {
        let mut restore_paths: Vec<String> = Vec::new();
        let mut restore_seen: HashSet<String> = HashSet::new();
        let mut clean_paths: Vec<String> = Vec::new();
        let mut clean_seen: HashSet<String> = HashSet::new();

        for file in files {
            let rel = file.file_path.trim();
            if rel.is_empty() {
                return Err("File path cannot be empty.".to_string());
            }
            let rename_from = file
                .rename_from
                .as_deref()
                .map(str::trim)
                .filter(|from| !from.is_empty() && *from != rel);
            if let Some(from) = rename_from {
                if git_path_known_to_git(path_buf, from) {
                    push_unique_path(&mut restore_paths, &mut restore_seen, from);
                }
            }
            if git_path_known_to_git(path_buf, rel) {
                push_unique_path(&mut restore_paths, &mut restore_seen, rel);
            } else {
                push_unique_path(&mut clean_paths, &mut clean_seen, rel);
            }
        }

        if !restore_paths.is_empty() {
            let mut args: Vec<String> = vec!["restore".into(), "--worktree".into(), "--".into()];
            args.extend(restore_paths);
            let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            run_git_streaming(app, path, path_buf, &args_ref, "discard changes")?;
        }
        if !clean_paths.is_empty() {
            let mut args: Vec<String> = vec!["clean".into(), "-f".into(), "--".into()];
            args.extend(clean_paths);
            let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            run_git_streaming(app, path, path_buf, &args_ref, "discard changes")?;
        }
        return Ok(());
    }

    let mut restore_paths: Vec<String> = Vec::new();
    let mut restore_seen: HashSet<String> = HashSet::new();
    for file in files {
        let rel = file.file_path.trim();
        if rel.is_empty() {
            return Err("File path cannot be empty.".to_string());
        }
        let rename_from = file
            .rename_from
            .as_deref()
            .map(str::trim)
            .filter(|from| !from.is_empty() && *from != rel);
        if let Some(from) = rename_from {
            push_unique_path(&mut restore_paths, &mut restore_seen, from);
        }
        push_unique_path(&mut restore_paths, &mut restore_seen, rel);
    }
    if restore_paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<String> = vec![
        "restore".into(),
        "--source=HEAD".into(),
        "--staged".into(),
        "--worktree".into(),
        "--".into(),
    ];
    args.extend(restore_paths);
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git_streaming(app, path, path_buf, &args_ref, "discard changes")?;
    Ok(())
}

/// Discard local changes for many paths. `from_unstaged` selects the sidebar column:
/// - **Unstaged:** restore the working tree from the index for tracked files (`git restore --worktree`);
///   remove untracked paths (`git clean -f`).
/// - **Staged:** reset index and working tree to `HEAD` for these paths (`git restore --source=HEAD --staged --worktree`).
#[tauri::command]
pub fn discard_paths_changes(
    app: AppHandle,
    path: String,
    files: Vec<DiscardPathTarget>,
    from_unstaged: bool,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    discard_paths_changes_inner(&app, &path, &path_buf, &files, from_unstaged)
}

/// Discard local changes for one path. `from_unstaged` selects the sidebar column:
/// - **Unstaged:** restore the working tree from the index for tracked files (`git restore --worktree`);
///   remove untracked paths (`git clean -f`).
/// - **Staged:** reset index and working tree to `HEAD` for this path (`git restore --source=HEAD --staged --worktree`).
#[tauri::command]
pub fn discard_path_changes(
    app: AppHandle,
    path: String,
    file_path: String,
    from_unstaged: bool,
    rename_from: Option<String>,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    discard_paths_changes_inner(
        &app,
        &path,
        &path_buf,
        &[DiscardPathTarget {
            file_path,
            rename_from,
        }],
        from_unstaged,
    )
}

fn commit_staged_blocking(app: AppHandle, path: String, message: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let msg = message.trim();
    if msg.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    run_git_streaming(&app, &path, &path_buf, &["commit", "-m", msg], "commit")?;
    Ok(())
}

#[tauri::command]
pub async fn commit_staged(app: AppHandle, path: String, message: String) -> Result<(), String> {
    run_blocking_git_command(move || commit_staged_blocking(app, path, message)).await
}

/// Amend `HEAD` with staged changes. With a non-empty `message`, replaces the commit message (`git commit --amend -m`).
/// With `None` or empty message, keeps the previous message (`git commit --amend --no-edit`).
fn amend_last_commit_blocking(
    app: AppHandle,
    path: String,
    message: Option<String>,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let trimmed = message.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty());
    match trimmed {
        Some(m) => {
            run_git_streaming(
                &app,
                &path,
                &path_buf,
                &["commit", "--amend", "-m", m],
                "commit --amend",
            )?;
        }
        None => {
            run_git_streaming(
                &app,
                &path,
                &path_buf,
                &["commit", "--amend", "--no-edit"],
                "commit --amend",
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn amend_last_commit(
    app: AppHandle,
    path: String,
    message: Option<String>,
) -> Result<(), String> {
    run_blocking_git_command(move || amend_last_commit_blocking(app, path, message)).await
}

/// Rewrite a commit message on the current branch without changing file contents.
///
/// - `HEAD`: rewrites the commit object in place and keeps the current index / working tree.
/// - Older commits: limited to non-root, non-merge commits on the current branch's first-parent
///   history, then rebases newer descendants onto the rewritten commit.
#[tauri::command]
pub fn reword_commit(
    app: AppHandle,
    path: String,
    commit_hash: String,
    message: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let trimmed_message = message.trim();
    if trimmed_message.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }

    git_output(&path_buf, &["symbolic-ref", "--quiet", "--short", "HEAD"]).map_err(|_| {
        "Amending a commit message requires the current branch to be checked out.".to_string()
    })?;

    let hash = commit_hash.trim();
    if hash.is_empty() {
        return Err("Commit hash cannot be empty.".to_string());
    }
    let verify_spec = format!("{hash}^{{commit}}");
    let resolved_hash = git_output(&path_buf, &["rev-parse", "--verify", &verify_spec])?;
    let head_hash = git_output(&path_buf, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let is_head = resolved_hash == head_hash;
    let mut sign_rewritten_commits = git_config_bool(&path_buf, "commit.gpgsign")
        || commit_has_signature(&path_buf, &resolved_hash);

    let parents_line = git_output(
        &path_buf,
        &["rev-list", "--parents", "-n", "1", &resolved_hash],
    )?;
    let mut parts = parents_line.split_whitespace();
    let _ = parts.next();
    let parent_hashes = parts.map(str::to_string).collect::<Vec<_>>();

    if !is_head {
        let tracked_status = git_output(
            &path_buf,
            &["status", "--porcelain", "--untracked-files=no"],
        )?;
        if !tracked_status.is_empty() {
            return Err(
                "Amending an older commit message requires a clean index and working tree."
                    .to_string(),
            );
        }
        if parent_hashes.is_empty() {
            return Err("Amending the root commit message is not supported yet.".to_string());
        }
        if parent_hashes.len() > 1 {
            return Err("Amending older merge commit messages is not supported yet.".to_string());
        }

        let first_parent_history = git_output(&path_buf, &["rev-list", "--first-parent", "HEAD"])?;
        if !first_parent_history
            .lines()
            .any(|line| line.trim() == resolved_hash)
        {
            return Err(
                "Only commits on the current branch's primary history can be amended.".to_string(),
            );
        }
        if !sign_rewritten_commits {
            sign_rewritten_commits = first_parent_history
                .lines()
                .map(str::trim)
                .take_while(|line| *line != resolved_hash)
                .any(|line| !line.is_empty() && commit_has_signature(&path_buf, line));
        }
    }

    let author_line = git_output(
        &path_buf,
        &["show", "-s", "--format=%an%x00%ae%x00%aI", &resolved_hash],
    )?;
    let mut author_parts = author_line.split('\0');
    let author_name = author_parts.next().unwrap_or_default().trim().to_string();
    let author_email = author_parts.next().unwrap_or_default().trim().to_string();
    let author_date = author_parts.next().unwrap_or_default().trim().to_string();
    if author_name.is_empty() || author_email.is_empty() || author_date.is_empty() {
        return Err("Failed to determine the commit author.".to_string());
    }

    let tree_hash = git_output(
        &path_buf,
        &[
            "rev-parse",
            "--verify",
            &format!("{resolved_hash}^{{tree}}"),
        ],
    )?;
    let author_env = [
        ("GIT_AUTHOR_NAME", author_name.as_str()),
        ("GIT_AUTHOR_EMAIL", author_email.as_str()),
        ("GIT_AUTHOR_DATE", author_date.as_str()),
    ];
    let mut commit_tree_args = vec!["commit-tree".to_string(), tree_hash];
    if sign_rewritten_commits {
        commit_tree_args.push("-S".to_string());
    }
    for parent_hash in &parent_hashes {
        commit_tree_args.push("-p".to_string());
        commit_tree_args.push(parent_hash.clone());
    }
    let commit_tree_args_ref = commit_tree_args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let rewritten_hash = git_output_with_input_and_env(
        &path_buf,
        &commit_tree_args_ref,
        Some(trimmed_message),
        &author_env,
    )?;

    if is_head {
        run_git_streaming(
            &app,
            &path,
            &path_buf,
            &["reset", "--soft", &rewritten_hash],
            "edit commit message",
        )?;
        return Ok(());
    }

    let rebase_args = if sign_rewritten_commits {
        vec![
            "rebase",
            "--gpg-sign",
            "--onto",
            rewritten_hash.as_str(),
            resolved_hash.as_str(),
        ]
    } else {
        vec![
            "rebase",
            "--onto",
            rewritten_hash.as_str(),
            resolved_hash.as_str(),
        ]
    };
    run_git_streaming(&app, &path, &path_buf, &rebase_args, "edit commit message")?;
    Ok(())
}

/// Merge `branch_or_ref` into the current branch (`git merge`).
#[tauri::command]
pub fn merge_branch(app: AppHandle, path: String, branch_or_ref: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let onto = branch_or_ref.trim();
    if onto.is_empty() {
        return Err("Branch or ref is empty.".to_string());
    }
    let verify_spec = format!("{onto}^{{commit}}");
    git_output(&path_buf, &["rev-parse", "--verify", &verify_spec])?;
    run_git_streaming(&app, &path, &path_buf, &["merge", onto], "merge")?;
    Ok(())
}

/// Cherry-pick a single commit onto the current branch.
#[tauri::command]
pub fn cherry_pick_commit(app: AppHandle, path: String, commit_hash: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let hash = commit_hash.trim();
    if hash.is_empty() {
        return Err("Commit hash cannot be empty.".to_string());
    }
    let verify_spec = format!("{hash}^{{commit}}");
    git_output(&path_buf, &["rev-parse", "--verify", &verify_spec])?;
    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["cherry-pick", hash],
        "cherry-pick",
    )?;
    Ok(())
}

/// History of commits touching `file_path` (`git log --follow`), newest first.
#[tauri::command]
pub fn list_file_history(
    path: String,
    file_path: String,
    limit: u32,
) -> Result<Vec<CommitEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let rel = file_path.trim();
    if rel.is_empty() {
        return Err("File path cannot be empty.".to_string());
    }
    let n = limit.max(1).min(500).to_string();
    let out = git_output(
        &path_buf,
        &[
            "log",
            "--follow",
            "-n",
            &n,
            &format!("--format={COMMIT_LOG_FORMAT}"),
            "--",
            rel,
        ],
    )?;
    Ok(parse_commit_log_lines(&out))
}

/// Porcelain blame output for display (`git blame -w`).
#[tauri::command]
pub fn get_file_blame(path: String, file_path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let rel = file_path.trim();
    if rel.is_empty() {
        return Err("File path cannot be empty.".to_string());
    }
    git_output(&path_buf, &["blame", "-w", "--", rel])
}

/// Staged diff for a path (`git diff --cached -- <path>`).
#[tauri::command]
pub fn get_staged_diff(
    path: String,
    file_path: String,
    rename_from: Option<String>,
) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let rel = file_path.trim();
    if rel.is_empty() {
        return Err("File path cannot be empty.".to_string());
    }
    let rename_from = rename_from
        .as_deref()
        .map(str::trim)
        .filter(|from| !from.is_empty() && *from != rel);
    if let Some(from) = rename_from {
        let out = git_output(
            &path_buf,
            &["diff", "--cached", "--find-renames", "-U1", "--", from, rel],
        );
        if matches!(out, Ok(ref s) if !s.trim().is_empty()) {
            return out;
        }
    }
    git_output(&path_buf, &["diff", "--cached", "-U1", "--", rel])
}

/// Full staged diff for the index (`git diff --cached`).
#[tauri::command]
pub fn get_staged_diff_all(path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    git_output(&path_buf, &["diff", "--cached", "-U3"])
}

/// Unstaged diff for a path (`git diff -- <path>`), or full file vs empty for untracked paths.
#[tauri::command]
pub fn get_unstaged_diff(
    path: String,
    file_path: String,
    rename_from: Option<String>,
) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let rel = file_path.trim();
    if rel.is_empty() {
        return Err("File path cannot be empty.".to_string());
    }
    let rename_from = rename_from
        .as_deref()
        .map(str::trim)
        .filter(|from| !from.is_empty() && *from != rel);
    if let Some(from) = rename_from {
        let rename_out = git_output(
            &path_buf,
            &["diff", "--find-renames", "-U1", "--", from, rel],
        );
        if matches!(rename_out, Ok(ref s) if !s.trim().is_empty()) {
            return rename_out;
        }
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileEntry {
    pub path: String,
    pub stats: LineStat,
}

/// Paths changed in a single commit with line stats (`git show --numstat`).
/// Uses `git show` (not `diff-tree`) so **merge commits** (including stash WIPs) list files like `git show` in the CLI.
#[tauri::command]
pub fn list_commit_files(
    path: String,
    commit_hash: String,
) -> Result<Vec<CommitFileEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let hash = commit_hash.trim();
    if hash.is_empty() {
        return Err("Commit hash cannot be empty.".to_string());
    }
    let out = git_output(&path_buf, &["show", "--numstat", "--format=", hash])?;
    let stat_map = parse_numstat_output(&out);
    let mut paths: Vec<String> = stat_map.keys().cloned().collect();
    paths.sort();
    Ok(paths
        .into_iter()
        .map(|p| CommitFileEntry {
            stats: stat_map.get(&p).cloned().unwrap_or(LineStat {
                additions: 0,
                deletions: 0,
                is_binary: false,
            }),
            path: p,
        })
        .collect())
}

/// `%G?` plus `git verify-commit` so both GPG and SSH signing are recognized when Git’s trust
/// letter alone is ambiguous.
fn commit_signature_verified_flag(workdir: &Path, hash: &str) -> Option<bool> {
    let workdir = workdir.to_path_buf();
    let hash_owned = hash.to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = git_cmd(&workdir);
        cmd.args(["log", "-1", "--format=%G?", &hash_owned])
            .env("GIT_TERMINAL_PROMPT", "0");
        let g_out = cmd.output();
        let verified = match g_out {
            Ok(output) if output.status.success() => {
                let flag = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let ch = flag.chars().next().unwrap_or(' ');
                if ch == 'G' {
                    Some(true)
                } else if ch == 'N' {
                    Some(false)
                } else if flag.is_empty() {
                    verify_commit_quiet(&workdir, &hash_owned)
                } else if ch == 'B' {
                    Some(false)
                } else {
                    verify_commit_quiet(&workdir, &hash_owned)
                }
            }
            _ => verify_commit_quiet(&workdir, &hash_owned),
        };
        let _ = tx.send(verified);
    });

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(v) => v,
        Err(mpsc::RecvTimeoutError::Disconnected) | Err(mpsc::RecvTimeoutError::Timeout) => None,
    }
}

fn verify_commit_quiet(workdir: &Path, hash: &str) -> Option<bool> {
    let mut cmd = git_cmd(workdir);
    cmd.args(["verify-commit", hash])
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = cmd.output().ok()?;
    Some(output.status.success())
}

/// Starts signature verification in a **detached** thread and returns immediately. When finished,
/// emits [`CommitSignatureResultEvent`] on `commit-signature-result`. Does not block the IPC handler.
#[tauri::command]
pub fn start_commit_signature_check(
    app: AppHandle,
    path: String,
    commit_hash: String,
    request_id: u32,
) -> Result<(), String> {
    let path_buf = PathBuf::from(path.trim());
    ensure_git_repo(&path_buf)?;
    let hash = commit_hash.trim();
    if hash.is_empty() {
        return Err("Commit hash cannot be empty.".to_string());
    }

    let workdir = path_buf;
    let hash_owned = hash.to_string();
    let path_owned = path.trim().to_string();
    let app = app.clone();

    std::thread::spawn(move || {
        let verified = commit_signature_verified_flag(&workdir, &hash_owned);
        let _ = app.emit(
            "commit-signature-result",
            CommitSignatureResultEvent {
                path: path_owned,
                commit_hash: hash_owned,
                request_id,
                verified,
            },
        );
    });

    Ok(())
}

/// True when `rev` has at least two parents (merge commit, including stash WIPs).
fn merge_commit_has_second_parent(workdir: &Path, rev: &str) -> bool {
    git_output(workdir, &["rev-parse", "--verify", &format!("{rev}^2")]).is_ok()
}

/// Unified diff for one file in a given commit, patch only (no commit headers).
///
/// Merge commits (stash WIPs, branch merges) must not use `git show` alone: Git emits **combined**
/// merge diffs (`diff --cc`, `@@@` hunks) which typical unified-diff UIs do not highlight. For merges we
/// use `git diff <rev>^1 <rev>` instead, matching `git stash show -p` and producing normal `@@` hunks.
/// Do not use `git show -m` here: it duplicates the same path once per parent.
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
    let p1 = format!("{hash}^1");
    let raw = if merge_commit_has_second_parent(&path_buf, hash) {
        git_diff_output(&path_buf, &["diff", "-U1", &p1, hash, "--", rel])?
    } else {
        git_output(&path_buf, &["show", "-U1", hash, "--", rel])?
    };
    Ok(unified_diff_patch_only(&raw))
}

/// Old/new file bytes for image preview in the diff viewer (`before` = left/parent, `after` = right/current).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBlobPair {
    pub before_base64: Option<String>,
    pub after_base64: Option<String>,
}

fn opt_bytes_to_b64(opt: Option<Vec<u8>>) -> Option<String> {
    opt.map(|b| B64.encode(b))
}

/// `git show <object>` where `object` is e.g. `HEAD:path`, `rev:path`, or `:path` (index).
fn git_show_blob_bytes(workdir: &Path, object_spec: &str) -> Result<Option<Vec<u8>>, String> {
    let spec = object_spec.trim();
    if spec.is_empty() {
        return Ok(None);
    }
    let out = git_cmd(workdir)
        .args(["show", spec])
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if out.status.success() {
        return Ok(Some(out.stdout));
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("does not exist")
        || stderr.contains("exists on disk, but not in")
        || stderr.contains("fatal: invalid object")
        || stderr.contains("fatal: bad revision")
    {
        return Ok(None);
    }
    if out.status.code() == Some(128) {
        return Ok(None);
    }
    Err(format!("git show failed: {stderr}"))
}

/// Blobs at parent vs commit revision (same parent rule as [`get_commit_file_diff`]).
#[tauri::command]
pub fn get_commit_file_blob_pair(
    path: String,
    commit_hash: String,
    file_path: String,
) -> Result<FileBlobPair, String> {
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
    let before_rev = if merge_commit_has_second_parent(&path_buf, hash) {
        format!("{hash}^1")
    } else {
        format!("{hash}^")
    };
    let before_spec = format!("{before_rev}:{rel}");
    let after_spec = format!("{hash}:{rel}");
    let before = git_show_blob_bytes(&path_buf, &before_spec)?;
    let after = git_show_blob_bytes(&path_buf, &after_spec)?;
    Ok(FileBlobPair {
        before_base64: opt_bytes_to_b64(before),
        after_base64: opt_bytes_to_b64(after),
    })
}

/// Staged diff: `HEAD` vs index (`:`).
#[tauri::command]
pub fn get_staged_file_blob_pair(
    path: String,
    file_path: String,
    rename_from: Option<String>,
) -> Result<FileBlobPair, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let rel = file_path.trim();
    if rel.is_empty() {
        return Err("File path cannot be empty.".to_string());
    }
    let before_rel = rename_from
        .as_deref()
        .map(str::trim)
        .filter(|from| !from.is_empty() && *from != rel)
        .unwrap_or(rel);
    let before = git_show_blob_bytes(&path_buf, &format!("HEAD:{before_rel}"))?;
    let after = git_show_blob_bytes(&path_buf, &format!(":{rel}"))?;
    Ok(FileBlobPair {
        before_base64: opt_bytes_to_b64(before),
        after_base64: opt_bytes_to_b64(after),
    })
}

fn read_working_tree_bytes(workdir: &Path, rel: &str) -> Result<Option<Vec<u8>>, String> {
    let full = workdir.join(rel);
    match std::fs::read(&full) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read file: {e}")),
    }
}

/// Unstaged diff: index vs working tree.
#[tauri::command]
pub fn get_unstaged_file_blob_pair(
    path: String,
    file_path: String,
    rename_from: Option<String>,
) -> Result<FileBlobPair, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let rel = file_path.trim();
    if rel.is_empty() {
        return Err("File path cannot be empty.".to_string());
    }
    let before_rel = rename_from
        .as_deref()
        .map(str::trim)
        .filter(|from| !from.is_empty() && *from != rel)
        .unwrap_or(rel);
    let before = git_show_blob_bytes(&path_buf, &format!(":{before_rel}"))?;
    let after = read_working_tree_bytes(&path_buf, rel)?;
    Ok(FileBlobPair {
        before_base64: opt_bytes_to_b64(before),
        after_base64: opt_bytes_to_b64(after),
    })
}

fn is_valid_stash_ref(s: &str) -> bool {
    let s = s.trim();
    let Some(rest) = s.strip_prefix("stash@{") else {
        return false;
    };
    let Some(end) = rest.find('}') else {
        return false;
    };
    let idx = &rest[..end];
    !idx.is_empty() && idx.chars().all(|c| c.is_ascii_digit())
}

/// All stashes in order (top = newest), from `git stash list`.
#[tauri::command]
pub fn list_stashes(path: String) -> Result<Vec<StashEntry>, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let text = git_output(&path_buf, &["stash", "list"])?;
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("stash@{") else {
            continue;
        };
        let Some(end) = rest.find('}') else {
            continue;
        };
        let idx_str = &rest[..end];
        if idx_str.is_empty() || !idx_str.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let after = rest.get(end + 1..).unwrap_or("");
        let message = if let Some(m) = after.strip_prefix(": ") {
            m.to_string()
        } else {
            after.trim_start().to_string()
        };
        let ref_name = format!("stash@{{{idx_str}}}");
        let commit_hash = match git_output(&path_buf, &["rev-parse", &ref_name]) {
            Ok(h) => h,
            Err(_) => continue,
        };
        out.push(StashEntry {
            ref_name,
            message,
            commit_hash,
        });
    }
    Ok(out)
}

/// Stash tracked + untracked changes (`git stash push`).
#[tauri::command]
pub fn stash_push(app: AppHandle, path: String, message: Option<String>) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let mut args: Vec<String> = vec!["stash".into(), "push".into()];
    if let Some(m) = message.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        args.push("-m".into());
        args.push(m.to_string());
    }
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git_streaming(&app, &path, &path_buf, &args_ref, "stash push")?;
    Ok(())
}

/// Apply and remove a stash (`git stash pop stash@{n}`).
#[tauri::command]
pub fn stash_pop(app: AppHandle, path: String, stash_ref: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let s = stash_ref.trim();
    if !is_valid_stash_ref(s) {
        return Err("Invalid stash reference.".to_string());
    }
    run_git_streaming(&app, &path, &path_buf, &["stash", "pop", s], "stash pop")?;
    Ok(())
}

/// Remove a stash without applying (`git stash drop stash@{n}`).
#[tauri::command]
pub fn stash_drop(app: AppHandle, path: String, stash_ref: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let s = stash_ref.trim();
    if !is_valid_stash_ref(s) {
        return Err("Invalid stash reference.".to_string());
    }
    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["stash", "drop", "-q", s],
        "stash drop",
    )?;
    Ok(())
}

/// Pull latest changes for a local branch: `git pull` when it is checked out; otherwise
/// `git fetch` to fast-forward `refs/heads/<branch>` from its configured upstream, or from
/// `origin` when no upstream is set (same convention as [`push_to_origin`]).
#[tauri::command]
pub fn pull_local_branch(app: AppHandle, path: String, branch: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let name = branch.trim();
    if name.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }
    git_output(
        &path_buf,
        &["rev-parse", "--verify", &format!("refs/heads/{name}")],
    )?;
    let head = git_output(&path_buf, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let head = head.trim();
    if head == name {
        run_git_streaming(&app, &path, &path_buf, &["pull"], "pull")?;
        return Ok(());
    }
    if let Some(upstream) = branch_upstream_abbrev(&path_buf, name) {
        let Some((remote, remote_branch)) = upstream.split_once('/') else {
            return Err("Could not parse upstream ref.".to_string());
        };
        let refspec = format!("{remote_branch}:{name}");
        run_git_streaming(
            &app,
            &path,
            &path_buf,
            &["fetch", remote, &refspec],
            "fetch",
        )?;
        return Ok(());
    }
    git_output(&path_buf, &["remote", "get-url", "origin"]).map_err(|_| {
        "No upstream configured for this branch and no remote named \"origin\".".to_string()
    })?;
    let refspec = format!("{name}:{name}");
    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["fetch", "origin", &refspec],
        "fetch",
    )?;
    Ok(())
}

/// Current branch name, or an error if `HEAD` is detached or the path is not a repo.
pub fn current_branch_name(path: impl AsRef<Path>) -> Result<String, String> {
    let path_buf = path.as_ref().to_path_buf();
    ensure_git_repo(&path_buf)?;
    let head_ref = git_output(&path_buf, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let head_ref = head_ref.trim();
    if head_ref == "HEAD" {
        return Err("Cannot push while in detached HEAD. Check out a branch first.".to_string());
    }
    Ok(head_ref.to_string())
}

/// Push the current branch to `origin`, setting upstream if needed (`git push -u origin HEAD`).
/// With `skip_hooks`, passes `--no-verify` so local pre-push hooks are skipped.
fn push_to_origin_blocking(app: AppHandle, path: String, skip_hooks: bool) -> Result<(), String> {
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
    if skip_hooks {
        run_git_streaming(
            &app,
            &path,
            &path_buf,
            &["push", "--no-verify", "-u", "origin", "HEAD"],
            "push",
        )?;
    } else {
        run_git_streaming(
            &app,
            &path,
            &path_buf,
            &["push", "-u", "origin", "HEAD"],
            "push",
        )?;
    }
    Ok(())
}

#[tauri::command]
pub async fn push_to_origin(app: AppHandle, path: String, skip_hooks: bool) -> Result<(), String> {
    run_blocking_git_command(move || push_to_origin_blocking(app, path, skip_hooks)).await
}

/// Force-push the current branch to `origin` with lease (`git push --force-with-lease -u origin HEAD`).
/// Refuses if `HEAD` is detached or `origin` is missing (same rules as [`push_to_origin`]).
fn force_push_to_origin_blocking(
    app: AppHandle,
    path: String,
    skip_hooks: bool,
) -> Result<(), String> {
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
    if skip_hooks {
        run_git_streaming(
            &app,
            &path,
            &path_buf,
            &[
                "push",
                "--no-verify",
                "--force-with-lease",
                "-u",
                "origin",
                "HEAD",
            ],
            "push",
        )?;
    } else {
        run_git_streaming(
            &app,
            &path,
            &path_buf,
            &["push", "--force-with-lease", "-u", "origin", "HEAD"],
            "push",
        )?;
    }
    Ok(())
}

#[tauri::command]
pub async fn force_push_to_origin(
    app: AppHandle,
    path: String,
    skip_hooks: bool,
) -> Result<(), String> {
    run_blocking_git_command(move || force_push_to_origin_blocking(app, path, skip_hooks)).await
}

/// Whether `origin` exists and whether `refs/tags/<tag>` is present on `origin` (`git ls-remote`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagOriginStatus {
    pub has_origin: bool,
    pub on_origin: bool,
}

#[tauri::command]
pub fn tag_origin_status(path: String, tag: String) -> Result<TagOriginStatus, String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let tag = tag.trim();
    if tag.is_empty() {
        return Err("Tag name cannot be empty.".to_string());
    }
    if git_output(&path_buf, &["remote", "get-url", "origin"]).is_err() {
        return Ok(TagOriginStatus {
            has_origin: false,
            on_origin: false,
        });
    }
    let refspec = format!("refs/tags/{tag}");
    let out = git_output(&path_buf, &["ls-remote", "origin", &refspec])?;
    Ok(TagOriginStatus {
        has_origin: true,
        on_origin: !out.trim().is_empty(),
    })
}

/// Delete a tag on `origin` (`git push origin --delete <tag>`).
fn delete_remote_tag_blocking(app: AppHandle, path: String, tag: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let tag = tag.trim();
    if tag.is_empty() {
        return Err("Tag name cannot be empty.".to_string());
    }
    git_output(&path_buf, &["remote", "get-url", "origin"])
        .map_err(|_| "No remote named \"origin\" configured.".to_string())?;
    run_git_streaming(
        &app,
        &path,
        &path_buf,
        &["push", "origin", "--delete", tag],
        "push",
    )?;
    Ok(())
}

#[tauri::command]
pub async fn delete_remote_tag(app: AppHandle, path: String, tag: String) -> Result<(), String> {
    run_blocking_git_command(move || delete_remote_tag_blocking(app, path, tag)).await
}

/// Push a local tag to `origin` (`git push origin <tag>`).
fn push_tag_to_origin_blocking(app: AppHandle, path: String, tag: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_git_repo(&path_buf)?;
    let tag = tag.trim();
    if tag.is_empty() {
        return Err("Tag name cannot be empty.".to_string());
    }
    git_output(&path_buf, &["remote", "get-url", "origin"])
        .map_err(|_| "No remote named \"origin\" configured.".to_string())?;
    let tag_ref = format!("refs/tags/{tag}");
    git_output(&path_buf, &["rev-parse", "--verify", &tag_ref])?;
    run_git_streaming(&app, &path, &path_buf, &["push", "origin", tag], "push")?;
    Ok(())
}

#[tauri::command]
pub async fn push_tag_to_origin(app: AppHandle, path: String, tag: String) -> Result<(), String> {
    run_blocking_git_command(move || push_tag_to_origin_blocking(app, path, tag)).await
}

#[cfg(test)]
mod tests {
    use super::{parse_porcelain_v1_z, parse_porcelain_xy};

    #[test]
    fn porcelain_xy_marks_untracked_as_unstaged() {
        assert_eq!(parse_porcelain_xy("??"), Some((false, true, true)));
    }

    #[test]
    fn porcelain_v1_z_preserves_paths_with_spaces() {
        let entries = parse_porcelain_v1_z(" M a b.txt\0");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "a b.txt");
        assert!(entries[0].unstaged);
        assert!(!entries[0].staged);
        assert_eq!(entries[0].rename_from, None);
    }

    #[test]
    fn porcelain_v1_z_parses_rename_pairs() {
        let entries = parse_porcelain_v1_z("R  new name.txt\0old name.txt\0");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "new name.txt");
        assert_eq!(entries[0].rename_from.as_deref(), Some("old name.txt"));
        assert!(entries[0].staged);
    }

    #[test]
    fn porcelain_v1_z_parses_unstaged_rename_pairs() {
        let entries = parse_porcelain_v1_z(" R new name.txt\0old name.txt\0");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "new name.txt");
        assert_eq!(entries[0].rename_from.as_deref(), Some("old name.txt"));
        assert!(entries[0].unstaged);
        assert!(!entries[0].staged);
    }
}
