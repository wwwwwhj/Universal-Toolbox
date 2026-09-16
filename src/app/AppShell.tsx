import { Fragment, useEffect, useState } from "react";
import { Settings, Wrench } from "lucide-react";
import { applyModuleOrder, type ToolboxModule } from "./modules";
import { resolveModule, useHash } from "./router";
import SettingsPage from "./SettingsPage";
import { applyPreferences, readPreferences, type Preferences } from "./preferences";

const settingsRoute = "/settings";
const defaultCategory = "工具";

export default function AppShell() {
  const hash = useHash();
  const isSettings = hash === `#${settingsRoute}`;
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);
  const orderedModules = applyModuleOrder(preferences.moduleOrder);
  const activeModule = isSettings ? undefined : resolveModule(hash, orderedModules);
  const Page = activeModule?.component;

  // 侧栏按模块声明的分类分组，未声明的归入默认组；组顺序跟随排序后首次出现的顺序。
  const navGroups = new Map<string, ToolboxModule[]>();
  for (const module of orderedModules) {
    const category = module.category ?? defaultCategory;
    const group = navGroups.get(category);
    if (group) group.push(module);
    else navGroups.set(category, [module]);
  }

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
        {[...navGroups].map(([category, items]) => (
          <Fragment key={category}>
            <p className="sidebar-label">{category}</p>
            <nav aria-label={category}>
              {items.map((module) => (
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
          </Fragment>
        ))}
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
