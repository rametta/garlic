/**
 * Resolves the persisted theme preference into the concrete DaisyUI theme applied to the document.
 * Search tags: theme preference, auto theme, dark mode, data-theme.
 */
export function resolveThemePreference(pref: string | null): string {
  const p = pref ?? "light";
  if (p === "auto") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return p;
}
