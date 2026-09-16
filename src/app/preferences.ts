export type ThemePreference = "system" | "light" | "dark";
export type FontPreference = "system" | "serif" | "mono";
export type FontSizePreference = "small" | "medium" | "large";

export interface Preferences {
  theme: ThemePreference;
  font: FontPreference;
  fontSize: FontSizePreference;
  // 工具在侧栏中的自定义顺序（模块 id 列表）；空数组表示注册表顺序。
  moduleOrder: string[];
}

export const defaultPreferences: Preferences = {
  theme: "system",
  font: "system",
  fontSize: "medium",
  moduleOrder: [],
};

const STORAGE_KEY = "ui-preferences";

export function readPreferences(): Preferences {
  if (typeof localStorage === "undefined") return defaultPreferences;
  try {
    const raw: Record<string, unknown> = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system",
      font: raw.font === "serif" || raw.font === "mono" ? raw.font : "system",
      fontSize: raw.fontSize === "small" || raw.fontSize === "large" ? raw.fontSize : "medium",
      moduleOrder: Array.isArray(raw.moduleOrder)
        ? raw.moduleOrder.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return defaultPreferences;
  }
}

export function applyPreferences(preferences: Preferences) {
  const root = document.documentElement;
  if (preferences.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = preferences.theme;
  if (preferences.font === "system") delete root.dataset.font;
  else root.dataset.font = preferences.font;
  if (preferences.fontSize === "medium") delete root.dataset.fontSize;
  else root.dataset.fontSize = preferences.fontSize;
  localStorage.removeItem("ui-theme");
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
