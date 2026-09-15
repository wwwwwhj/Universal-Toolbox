import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { defaultPreferences, type Preferences } from "./preferences";

interface SettingsPageProps {
  preferences: Preferences;
  onChange: (preferences: Preferences) => void;
}

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  sample?: string;
}

function SegmentedField<T extends string>(props: {
  id: string;
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="ui-field">
      <span id={`${props.id}-label`}>{props.label}</span>
      <div className="ui-segmented" role="radiogroup" aria-labelledby={`${props.id}-label`}>
        {props.options.map((option) => (
          <label key={option.value} data-sample={option.sample}>
            <input
              type="radio"
              name={props.id}
              value={option.value}
              checked={props.value === option.value}
              onChange={() => props.onChange(option.value)}
            />
            {option.icon && <option.icon size={16} aria-hidden="true" />}
            {option.label}
          </label>
        ))}
      </div>
    </div>
  );
}

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
    </section>
  );
}
