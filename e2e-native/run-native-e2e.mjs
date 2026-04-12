import { spawnSync } from "node:child_process";

if (process.platform === "darwin") {
  console.error(
    [
      "Native Tauri WebDriver E2E is not available on macOS.",
      "Tauri's official desktop WebDriver support currently only works on Linux and Windows because macOS does not provide a WKWebView driver.",
      "Run `bun run test:bridge` locally for the fast bridge-contract suite, and run the native suite in Linux CI.",
    ].join(" "),
  );
  process.exit(1);
}

if (process.platform !== "linux") {
  console.error(
    "This repo currently wires native Tauri WebDriver E2E only for Linux. Use Linux CI or extend the launcher/config for your platform.",
  );
  process.exit(1);
}

const result = spawnSync("wdio", ["run", "e2e-native/wdio.conf.mjs"], {
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 1);
