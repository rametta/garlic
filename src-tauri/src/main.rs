//! Native entry point that forwards to the library crate's Tauri bootstrap.
//! Search tags: tauri main, desktop entry point.

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    garlic_lib::run()
}
