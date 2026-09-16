# 万能工具箱

基于 React 19、TypeScript、Vite 和 Tauri 2 的模块化单体桌面应用。

## UI 约定

新增或修改页面须遵循 [UI 设计规范](docs/ui-design.md)。风格参考 Codex 的桌面工作区，使用中性色、紧凑导航与统一控件；视觉变量位于 `src/styles/tokens.css`，公共类位于 `src/styles/ui.css`，原生跟随系统浅色/深色模式。模块只需复用公共类并编写自己的布局，无需增加 UI 库。

## 结构

```text
src/
  main.tsx                  # React 入口
  App.tsx                   # 挂载 Shell
  App.css                   # 应用布局与基础样式
  app/
    AppShell.tsx            # 左侧导航、主内容和未知地址提示
    SettingsPage.tsx        # 全局外观偏好与各模块设置分区
    modules.ts              # 静态 Module Registry
    preferences.ts          # 主题、字体、字号偏好
    router.ts               # 原生 Hash 路由
  shared/
    module-settings.ts      # 模块设置的持久化状态容器
    SegmentedField.tsx      # 设置页共用的分段控件
  modules/
    snake/SnakePage.tsx
    ports/                  # 端口查询、进程停止与模块设置
    cache/                  # 开发缓存目录扫描与位置修改
src-tauri/src/modules/      # ports 端口操作、cache 缓存目录扫描
scripts/check-architecture.mjs
```

Snake 为独立占位页面；端口管理和开发缓存管理使用 Rust 原生能力。模块不互相引用；Shell 只依赖注册表中的描述和页面组件。

## 注册与路由

`src/app/modules.ts` 的静态数组记录工具的 `id`、`name`、`route`、`component` 和 `icon`，可选 `category`（侧栏分组，未声明归入「工具」）与 `settingsComponent`（设置页分区）。数组顺序即导航顺序，Shell 从同一清单生成导航并选择页面。

路由使用 `#/snake`、`#/ports`、`#/cache`，原生链接和 `hashchange` 支持前进、后退与刷新，不需要服务器配置路径回退。空 Hash 或 `#/` 显示首个模块；未知地址显示提示与返回入口。

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

不增加数据库、全局状态框架、Workspace 或收藏等重型基础设施；外观偏好和模块设置用 `localStorage` 持久化已经足够。

## 端口管理（Windows / macOS）

在 Tauri 桌面应用中打开“端口管理”，输入 1–65535 的端口号查询，或留空查询全部。显示 TCP 监听/连接与 UDP 绑定、本地地址、状态、进程名、PID 和可读取的程序路径；PID 为 0 的 TIME_WAIT 记录不算可停止进程，系统保留端口也不在查询范围内。

进程名下方直接显示当前工作目录，帮助区分多个 Node 服务；停止确认区也展示该目录。展开“进程详情”可查看工作目录、完整启动命令、程序路径、本地时间显示的启动时间、父进程名称/PID，以及关联 Windows 服务名称和状态。程序路径是 node.exe 等可执行文件的位置，不代表项目目录。

Windows 工作目录通过只读进程内存获取，当前支持 64 位 Windows 工具箱读取 x64/WOW64 进程；权限不足、进程退出或内部布局不兼容时明确提示，不以可执行文件目录代替。其余详情使用批量 CIM 查询。macOS 使用系统 lsof 查询 TCP/UDP 端口及工作目录、ps 查询启动命令、libproc 查询进程身份和程序路径，Windows 服务字段显示不适用。进程可自行改变工作目录，因此显示的是当前值而非保证不变的启动目录。当前未增加 CPU/内存监控。

点击“停止进程”后确认：Windows 强制结束该进程；macOS 发送 SIGTERM 并等待最多约 5 秒确认退出，超时提示而不自动强杀。操作影响该进程的所有端口。不会终止子进程树、禁用系统服务或自动提权；守护程序可能重新启动进程。拒绝停止 PID 0–4、工具箱自身及 macOS 标记的系统进程；查询可见范围和停止权限受当前账户及系统保护限制。

后端按编译目标选择系统实现，无新增包依赖，原生调用在阻塞线程运行。停止时复核端口归属和启动时间；Windows 持有进程句柄，macOS 使用微秒级启动时间标识并在发信号前再次复核。macOS 的 PID 信号接口无法完全消除最后一次复核与发信号之间的竞态。浏览器预览禁用系统操作，Windows/macOS 之外返回暂不支持。

运行 `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib modules::ports`。Windows 测试及 Mac 实机测试均只创建、停止自己的随机端口 TCP/UDP 子进程；macOS lsof 解析测试可在 Windows 上运行。Mac 实机测试另外检查工作目录、父进程和过期身份，需在 Mac 上执行，不能以 Windows 测试替代。
