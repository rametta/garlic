use std::path::Path;
use std::process::Command;

/// Opens a repo-relative file in the Cursor editor (CLI or `open -a` on macOS).
#[tauri::command]
pub fn open_in_cursor(path: String, file_path: String) -> Result<(), String> {
    let repo = Path::new(path.trim());
    if !repo.is_dir() {
        return Err("Repository path is not a directory".to_string());
    }
    let rel = file_path.trim();
    if rel.is_empty() {
        return Err("File path is empty".to_string());
    }
    let full = repo.join(rel);
    let full = full.canonicalize().map_err(|e| e.to_string())?;
    if !full.exists() {
        return Err("File does not exist".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let full_str = full.to_str().ok_or("Invalid path")?;
        if Command::new("cursor")
            .arg(full_str)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Ok(());
        }
        let status = Command::new("open")
            .args(["-a", "Cursor", full_str])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(
                "Could not open Cursor. Install Cursor or run “Shell Command: Install 'cursor' command in PATH” from the Command Palette."
                    .to_string(),
            )
        }
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("cursor")
            .arg(&full)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(
                "Could not open Cursor. Install Cursor and ensure the cursor CLI is on your PATH."
                    .to_string(),
            )
        }
    }

    #[cfg(target_os = "linux")]
    {
        let status = Command::new("cursor")
            .arg(&full)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(
                "Could not open Cursor. Install Cursor and ensure the cursor command is on your PATH."
                    .to_string(),
            )
        }
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    )))]
    {
        let _ = full;
        Err("Unsupported platform".to_string())
    }
}
