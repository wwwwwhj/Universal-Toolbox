import type { ComponentType } from "react";
import { Gamepad2, HardDrive, Keyboard, Network, type LucideIcon } from "lucide-react";
import SnakePage from "../modules/snake/SnakePage";
import TypingPage from "../modules/typing/TypingPage";
import TypingSettings from "../modules/typing/TypingSettings";
import PortsPage from "../modules/ports/PortsPage";
import PortsSettings from "../modules/ports/PortsSettings";
import CachePage from "../modules/cache/CachePage";
import CacheSettings from "../modules/cache/CacheSettings";

export interface ToolboxModule {
  id: string;
  name: string;
  route: `/${string}`;
  component: ComponentType;
  icon: LucideIcon;
  // 侧栏导航的分组名；未声明的模块归入默认组。
  category?: string;
  // 模块可选地向设置页提供一个配置分区；Shell 只负责装配，不关心内部字段。
  settingsComponent?: ComponentType;
}

// 导航与路由共用静态清单，新增工具无需修改 Shell 或其他模块。
export const modules: readonly ToolboxModule[] = [
  { id: "snake", name: "Snake", route: "/snake", component: SnakePage, icon: Gamepad2, category: "休闲" },
  { id: "typing", name: "英文打字", route: "/typing", component: TypingPage, icon: Keyboard, category: "休闲", settingsComponent: TypingSettings },
  { id: "ports", name: "端口管理", route: "/ports", component: PortsPage, icon: Network, settingsComponent: PortsSettings },
  { id: "cache", name: "开发缓存管理", route: "/cache", component: CachePage, icon: HardDrive, settingsComponent: CacheSettings },
];

// 应用自定义排序：不在列表中的模块（如之后新增的工具）排在已排序模块之后。
export function applyModuleOrder(order: readonly string[]): ToolboxModule[] {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const sorted = order.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  for (const module of modules) {
    if (!order.includes(module.id)) sorted.push(module);
  }
  return sorted;
}
