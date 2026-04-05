/**
 * Theme option metadata shared by the settings UI.
 * Search tags: DaisyUI themes, theme select options, auto theme, settings theme picker.
 */

/** DaisyUI theme names (excluding `auto`, handled in the UI). Mirrors `settings::DAISY_THEMES` in Rust. */
export const DAISY_UI_THEME_NAMES = [
  "light",
  "dark",
  "cupcake",
  "bumblebee",
  "corporate",
  "synthwave",
  "retro",
  "cyberpunk",
  "valentine",
  "garden",
  "forest",
  "dracula",
  "night",
  "nord",
  "sunset",
] as const;

function formatThemeLabel(name: string): string {
  if (name.length === 0) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export const THEME_SELECT_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto (match system)" },
  ...DAISY_UI_THEME_NAMES.map((name) => ({
    value: name,
    label: formatThemeLabel(name),
  })),
];
