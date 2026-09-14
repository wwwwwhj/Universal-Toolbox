import { modules } from "./modules";
import { useActiveModule } from "./router";

export default function AppShell() {
  const activeModule = useActiveModule();
  const Page = activeModule?.component;

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
        <div className="brand">万能工具箱</div>
        <p className="sidebar-label">工具</p>
        <nav aria-label="工具导航">
          {modules.map((module) => (
            <a
              key={module.id}
              href={`#${module.route}`}
              aria-current={activeModule?.id === module.id ? "page" : undefined}
            >
              {module.name}
            </a>
          ))}
        </nav>
      </aside>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {Page ? <Page key={activeModule.id} /> : (
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
