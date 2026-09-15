export type ThemePreference = "system" | "light" | "dark";

export function readThemePreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const value = localStorage.getItem("ui-theme");
  return value === "light" || value === "dark" ? value : "system";
}

export function applyThemePreference(theme: ThemePreference) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  localStorage.setItem("ui-theme", theme);
}
