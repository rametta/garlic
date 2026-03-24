import { invoke } from "@tauri-apps/api/core";
import React from "react";
import ReactDOM from "react-dom/client";
import App, { emptyAppBootstrap, resolveDaisyTheme, type AppBootstrap } from "./App";
import "./index.css";

async function bootstrap() {
  let data: AppBootstrap = emptyAppBootstrap;
  try {
    data = await invoke<AppBootstrap>("restore_app_bootstrap");
  } catch {
    // Plain Vite or missing Tauri backend — open empty shell.
  }

  const resolvedTheme = resolveDaisyTheme(data.theme);
  document.documentElement.setAttribute("data-theme", resolvedTheme);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App startup={data.repo} initialTheme={resolvedTheme} />
    </React.StrictMode>,
  );
}

void bootstrap();
