import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import {
  clearTauriBridgeLogs,
  clearTauriEventLogs,
  setTauriBridgeLoggingPaused,
} from "../tauriBridgeDebug";
import { resetTauriTestRuntime } from "./tauriTestRuntime";

vi.mock("@tauri-apps/api/core", async () => {
  const runtime = await import("./tauriTestRuntime");
  return {
    invoke: runtime.invokeForTests,
  };
});

vi.mock("@tauri-apps/api/event", async () => {
  const runtime = await import("./tauriTestRuntime");
  return {
    listen: runtime.listenForTests,
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(async () => false),
  message: vi.fn(async () => {}),
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(async () => null),
}));

beforeAll(() => {
  function inferRect(target: Element) {
    const element = target as HTMLElement;
    const styleHeight = Number.parseFloat(element.style.height || "");
    const styleWidth = Number.parseFloat(element.style.width || "");
    const height = Number.isFinite(styleHeight)
      ? styleHeight
      : element.tagName === "BUTTON" ||
          element.tagName === "INPUT" ||
          element.tagName === "TEXTAREA"
        ? 36
        : 400;
    const width = Number.isFinite(styleWidth) ? styleWidth : 1024;
    return { width, height };
  }

  class TestResizeObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}

    disconnect(): void {}

    observe(target: Element): void {
      const { width, height } = inferRect(target);
      this.callback(
        [
          {
            target,
            contentRect: DOMRectReadOnly.fromRect({
              x: 0,
              y: 0,
              width,
              height,
            }),
          } as ResizeObserverEntry,
        ],
        this,
      );
    }

    unobserve(): void {}
  }

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    value: TestResizeObserver,
  });

  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    writable: true,
    value: vi.fn(),
  });

  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    writable: true,
    value: vi.fn(),
  });

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      const { height } = inferRect(this as HTMLElement);
      return height;
    },
  });

  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      const { width } = inferRect(this as HTMLElement);
      return width;
    },
  });

  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      const { height } = inferRect(this as HTMLElement);
      return height;
    },
  });

  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      const { width } = inferRect(this as HTMLElement);
      return width;
    },
  });

  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      const { width, height } = inferRect(this as HTMLElement);
      return DOMRect.fromRect({ x: 0, y: 0, width, height });
    },
  });
});

beforeEach(() => {
  setTauriBridgeLoggingPaused(false);
  clearTauriBridgeLogs();
  clearTauriEventLogs();
});

afterEach(() => {
  cleanup();
  setTauriBridgeLoggingPaused(false);
  clearTauriBridgeLogs();
  clearTauriEventLogs();
  resetTauriTestRuntime();
});
