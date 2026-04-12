import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLinuxLauncherScript, createNativeRepoFixture } from "./nativeRepoHarness.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appBinaryPath = path.resolve(
  repoRoot,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "garlic.exe" : "garlic",
);

let tauriDriver;
let tauriDriverExpectedExit = false;
let nativeFixture = null;

export const config = {
  host: "127.0.0.1",
  port: 4444,
  specs: ["./e2e-native/specs/**/*.mjs"],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": {
        application: "",
      },
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
  onPrepare: () => {
    if (process.platform !== "linux") {
      throw new Error("Native Tauri WebDriver E2E is configured only for Linux in this repo.");
    }

    nativeFixture = createNativeRepoFixture();
    const launcherPath = createLinuxLauncherScript({
      rootDir: nativeFixture.rootDir,
      repoPath: nativeFixture.repoPath,
      fakeHome: nativeFixture.fakeHome,
      appBinaryPath,
    });

    process.env.GARLIC_NATIVE_E2E_REPO_PATH = nativeFixture.repoPath;
    process.env.GARLIC_NATIVE_E2E_ROOT = nativeFixture.rootDir;
    config.capabilities[0]["tauri:options"].application = launcherPath;

    const build = spawnSync("bun", ["run", "tauri", "build", "--debug", "--no-bundle"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        VITE_GARLIC_E2E: "true",
      },
      stdio: "inherit",
    });

    if (build.status !== 0) {
      throw new Error(`Native Tauri E2E build failed with exit code ${build.status ?? "unknown"}.`);
    }
  },
  beforeSession: () => {
    tauriDriverExpectedExit = false;
    tauriDriver = spawn(path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver"), [], {
      stdio: [null, process.stdout, process.stderr],
    });

    tauriDriver.on("error", (error) => {
      console.error("tauri-driver error:", error);
      process.exit(1);
    });
    tauriDriver.on("exit", (code) => {
      if (!tauriDriverExpectedExit) {
        console.error("tauri-driver exited unexpectedly with code:", code);
        process.exit(1);
      }
    });
  },
  afterSession: () => {
    closeTauriDriver();
  },
  onComplete: () => {
    closeTauriDriver();
    nativeFixture?.cleanup();
    nativeFixture = null;
  },
};

function closeTauriDriver() {
  tauriDriverExpectedExit = true;
  tauriDriver?.kill();
  tauriDriver = null;
}
