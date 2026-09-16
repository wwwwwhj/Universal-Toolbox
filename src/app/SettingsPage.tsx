import { Monitor, Moon, Sun } from "lucide-react";
import { defaultPreferences, type Preferences } from "./preferences";
import { applyModuleOrder } from "./modules";
import { SegmentedField } from "../shared/SegmentedField";

interface SettingsPageProps {
  preferences: Preferences;
  onChange: (preferences: Preferences) => void;
}

export default function SettingsPage({ preferences, onChange }: SettingsPageProps) {
  const orderedModules = applyModuleOrder(preferences.moduleOrder);
  // 声明了 settingsComponent 的模块在设置页获得一个独立分区，配置内容由模块自己实现。
  const settingsModules = orderedModules.filter((module) => module.settingsComponent);

  function moveModule(index: number, delta: number) {
    const order = orderedModules.map((module) => module.id);
    const target = index + delta;
    [order[index], order[target]] = [order[target], order[index]];
    onChange({ ...preferences, moduleOrder: order });
  }

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
      <div className="ui-field">
        <span id="module-order-label">工具排序</span>
        <ul className="settings-order" aria-labelledby="module-order-label">
          {orderedModules.map((module, index) => (
            <li key={module.id}>
              <span className="settings-order-name">
                <module.icon size={16} aria-hidden="true" />
                {module.name}
                <small>{module.category ?? "工具"}</small>
              </span>
              <span className="ui-actions">
                <button
                  className="ui-button"
                  type="button"
                  disabled={index === 0}
                  aria-label={`上移 ${module.name}`}
                  onClick={() => moveModule(index, -1)}
                >
                  上移
                </button>
                <button
                  className="ui-button"
                  type="button"
                  disabled={index === orderedModules.length - 1}
                  aria-label={`下移 ${module.name}`}
                  onClick={() => moveModule(index, 1)}
                >
                  下移
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
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
