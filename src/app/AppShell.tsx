import { useEffect, useState } from "react";
import { Settings, Wrench } from "lucide-react";
import { modules } from "./modules";
import { resolveModule, useHash } from "./router";
import SettingsPage from "./SettingsPage";
import { applyPreferences, readPreferences, type Preferences } from "./preferences";

const settingsRoute = "/settings";

export default function AppShell() {
  const hash = useHash();
  const isSettings = hash === `#${settingsRoute}`;
  const activeModule = isSettings ? undefined : resolveModule(hash);
  const Page = activeModule?.component;
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);

  useEffect(() => applyPreferences(preferences), [preferences]);

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          // 只移动焦点，避免覆盖工具路由所用的 Hash。
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        跳到主内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Wrench size={13} strokeWidth={2.2} /></span>
          万能工具箱
        </div>
        <p className="sidebar-label">工具</p>
        <nav aria-label="工具导航">
          {modules.map((module) => (
            <a
              key={module.id}
              href={`#${module.route}`}
              aria-current={activeModule?.id === module.id ? "page" : undefined}
            >
              <module.icon size={16} aria-hidden="true" />
              {module.name}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <nav aria-label="设置">
            <a href={`#${settingsRoute}`} aria-current={isSettings ? "page" : undefined}>
              <Settings size={16} aria-hidden="true" />
              设置
            </a>
          </nav>
        </div>
      </aside>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {isSettings ? <SettingsPage preferences={preferences} onChange={setPreferences} /> : Page ? <Page key={activeModule.id} /> : (
          <section>
            <h1>工具不存在</h1>
            <p>当前地址没有对应的工具，请从左侧导航选择。</p>
            <a href="#/">返回默认工具</a>
          </section>
        )}
      </main>
    </div>
  );
}
