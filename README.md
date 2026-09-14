# 万能工具箱

基于 React 19、TypeScript、Vite 和 Tauri 2 的模块化单体桌面应用。

## 结构

```text
src/
  main.tsx                  # React 入口
  App.tsx                   # 挂载 Shell
  App.css                   # 应用布局与基础样式
  app/
    AppShell.tsx            # 左侧导航、主内容和未知地址提示
    modules.ts              # 静态 Module Registry
    router.ts               # 原生 Hash 路由
  modules/
    git/GitPage.tsx
    image/ImagePage.tsx
    inventory/InventoryPage.tsx
    snake/SnakePage.tsx
    ports/                  # 端口查询和进程停止界面
src-tauri/src/modules/ports/ # Windows 端口查询与安全停止
scripts/check-architecture.mjs
```

Git、Image、Inventory、Snake 为独立占位页面；端口管理为 Windows 原生工具。模块不互相引用；Shell 只依赖注册表中的描述和页面组件。

## 注册与路由

`src/app/modules.ts` 的静态数组记录工具的 `id`、`name`、`route` 和 `component`。数组顺序即导航顺序，Shell 从同一清单生成导航并选择页面。

路由使用 `#/git`、`#/image`、`#/inventory`、`#/snake`、`#/ports`，原生链接和 `hashchange` 支持前进、后退与刷新，不需要服务器配置路径回退。空 Hash 或 `#/` 显示首个模块；未知地址显示提示与返回入口。

目前只匹配完整模块路径，不解析查询参数或嵌套路由。切换工具会卸载旧页面，不保存模块状态。出现真实的子页面或工作区需求时再扩展。

## 新增工具

1. 在 `src/modules/<module>/` 中创建默认导出的 React 页面组件。
2. 在 `src/app/modules.ts` 中导入组件，并添加一条注册记录，例如：

```ts
import NotesPage from "../modules/notes/NotesPage";

// 添加到 modules 数组，id 和 route 必须唯一。
{ id: "notes", name: "便签", route: "/notes", component: NotesPage },
```

无需修改 Shell、路由或已有工具。页面、组件、状态与辅助逻辑按需留在模块内部。只有需要原生能力时，才增加 `src-tauri/src/modules/<module>/` 和对应 Tauri 命令。

## 本地运行与检查

```sh
pnpm install
pnpm dev                 # 浏览器开发
pnpm tauri dev           # 桌面开发，需要 Rust 与 Tauri 系统依赖
pnpm build               # TypeScript 检查 + 生产构建
pnpm check:architecture  # 注册唯一性、页面、导航、默认/未知路由
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib modules::ports::tests
```

## 暂不实现

不引入插件系统、动态加载、Event Bus、DI、微前端或通用 Service/Manager；静态导入和注册数组已经满足当前扩展需求。

不增加数据库、持久化、全局状态、Workspace、收藏或主题设置；当前模块没有这些能力的实际使用者。

## 端口管理（Windows）

在 Tauri 桌面应用中打开“端口管理”，输入 1–65535 的端口号查询，或留空查询全部。显示 TCP 监听/连接与 UDP 绑定、本地地址、状态、进程名、PID 和可读取的程序路径；PID 为 0 的 TIME_WAIT 记录不算可停止进程，系统保留端口也不在查询范围内。

点击“停止进程”后确认，强制结束该进程（影响其所有端口），然后自动刷新。不会终止子进程树、禁用 Windows 服务或自动提权；守护程序可能重新启动进程。拒绝停止 PID 0–4 和工具箱自身；权限不足会显示错误，可按需以管理员身份运行。

后端采用系统自带 netstat 与 Windows PowerShell，无新增依赖。停止时校验端口归属和进程启动时间，并持有进程句柄，避免旧列表和 PID 复用导致误操作。原生调用在阻塞线程运行。浏览器预览禁用系统操作，其他操作系统返回暂不支持。

Rust 回归测试会创建自己的随机端口 TCP/UDP 进程，覆盖查询、参数校验、过期身份、端口归属变更、停止及释放；结束时清理测试进程。
