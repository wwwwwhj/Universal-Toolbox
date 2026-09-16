import { Monitor, Moon, Sun } from "lucide-react";
import { defaultPreferences, type Preferences } from "./preferences";
import { modules } from "./modules";
import { SegmentedField } from "../shared/SegmentedField";

interface SettingsPageProps {
  preferences: Preferences;
  onChange: (preferences: Preferences) => void;
}

// 声明了 settingsComponent 的模块在设置页获得一个独立分区，配置内容由模块自己实现。
const settingsModules = modules.filter((module) => module.settingsComponent);

export default function SettingsPage({ preferences, onChange }: SettingsPageProps) {
  return (
    <section className="settings-page">
      <h1>设置</h1>
      <p>外观与应用偏好，保存在本机。</p>
      <SegmentedField
        id="theme"
        label="主题"
        value={preferences.theme}
        options={[
          { value: "system", label: "跟随系统", icon: Monitor },
          { value: "light", label: "浅色", icon: Sun },
          { value: "dark", label: "深色", icon: Moon },
        ]}
        onChange={(theme) => onChange({ ...preferences, theme })}
      />
      <SegmentedField
        id="font"
        label="字体"
        value={preferences.font}
        options={[
          { value: "system", label: "系统默认" },
          { value: "serif", label: "衬线 Serif", sample: "serif" },
          { value: "mono", label: "等宽 Mono", sample: "mono" },
        ]}
        onChange={(font) => onChange({ ...preferences, font })}
      />
      <SegmentedField
        id="font-size"
        label="字号"
        value={preferences.fontSize}
        options={[
          { value: "small", label: "小", sample: "small" },
          { value: "medium", label: "标准", sample: "medium" },
          { value: "large", label: "大", sample: "large" },
        ]}
        onChange={(fontSize) => onChange({ ...preferences, fontSize })}
      />
      <div className="ui-actions">
        <button className="ui-button" type="button" onClick={() => onChange(defaultPreferences)}>
          恢复默认
        </button>
      </div>
      {settingsModules.map((module) => {
        const ModuleSettings = module.settingsComponent!;
        return (
          <section key={module.id} className="settings-module" aria-label={`${module.name}设置`}>
            <h2>{module.name}</h2>
            <ModuleSettings />
          </section>
        );
      })}
    </section>
  );
}
