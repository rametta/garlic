/** Resolves persisted theme preference to a DaisyUI `data-theme` name. */
export function resolveThemePreference(pref: string | null): string {
  const p = pref ?? "light";
  if (p === "auto") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return p;
}
