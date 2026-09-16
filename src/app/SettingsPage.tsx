import { useState, type KeyboardEvent } from "react";
import { Monitor, Moon, SlidersHorizontal, Sun } from "lucide-react";
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
  // 左侧分类标签：通用偏好 + 各模块设置分区。
  const tabs = [
    { id: "general", name: "通用", icon: SlidersHorizontal },
    ...settingsModules.map((module) => ({ id: module.id, name: module.name, icon: module.icon })),
  ];
  const [tab, setTab] = useState("general");
  const activeTab = tabs.some((item) => item.id === tab) ? tab : tabs[0].id;
  const activeModule = settingsModules.find((module) => module.id === activeTab);
  const ActiveSettings = activeModule?.settingsComponent;

  function moveModule(index: number, delta: number) {
    const order = orderedModules.map((module) => module.id);
    const target = index + delta;
    [order[index], order[target]] = [order[target], order[index]];
    onChange({ ...preferences, moduleOrder: order });
  }

  // 标准 tab 键盘行为：方向键/Home/End 切换并移动焦点（自动激活）。
  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((item) => item.id === activeTab);
    const targets: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowRight: index + 1,
      ArrowUp: index - 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: tabs.length - 1,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = tabs[(target + tabs.length) % tabs.length];
    setTab(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  }

  return (
    <section className="settings-page">
      <h1>设置</h1>
      <p>外观与应用偏好，保存在本机。</p>
      <div className="settings-layout">
        <div
          className="settings-tabs"
          role="tablist"
          aria-orientation="vertical"
          aria-label="设置分类"
          onKeyDown={onTabKeyDown}
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`settings-tab-${item.id}`}
              aria-selected={activeTab === item.id}
              aria-controls={`settings-panel-${item.id}`}
              tabIndex={activeTab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={16} aria-hidden="true" />
              {item.name}
            </button>
          ))}
        </div>
        <div
          className="settings-panel"
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
        >
          {activeTab === "general" ? (
            <>
              <h2>通用</h2>
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
            </>
          ) : (
            activeModule && ActiveSettings && (
              <>
                <h2>{activeModule.name}</h2>
                <ActiveSettings />
              </>
            )
          )}
        </div>
      </div>
    </section>
  );
}
