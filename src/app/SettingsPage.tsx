import type { ThemePreference } from "./theme";

interface SettingsPageProps {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}

export default function SettingsPage({ theme, onThemeChange }: SettingsPageProps) {
  return (
    <section className="settings-page">
      <h1>设置</h1>
      <p>应用级偏好，保存在本机。</p>
      <div className="ui-field">
        <label htmlFor="theme-select">主题</label>
        <select
          className="ui-input"
          id="theme-select"
          value={theme}
          onChange={(event) => onThemeChange(event.target.value as ThemePreference)}
        >
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>
    </section>
  );
}
