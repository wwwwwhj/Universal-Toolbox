import type { ComponentType } from "react";
import { Boxes, Gamepad2, GitBranch, HardDrive, Image as ImageIcon, Network, type LucideIcon } from "lucide-react";
import GitPage from "../modules/git/GitPage";
import ImagePage from "../modules/image/ImagePage";
import InventoryPage from "../modules/inventory/InventoryPage";
import SnakePage from "../modules/snake/SnakePage";
import PortsPage from "../modules/ports/PortsPage";
import PortsSettings from "../modules/ports/PortsSettings";
import CachePage from "../modules/cache/CachePage";

interface ToolboxModule {
  id: string;
  name: string;
  route: `/${string}`;
  component: ComponentType;
  icon: LucideIcon;
  // 模块可选地向设置页提供一个配置分区；Shell 只负责装配，不关心内部字段。
  settingsComponent?: ComponentType;
}

// 导航与路由共用静态清单，新增工具无需修改 Shell 或其他模块。
export const modules: readonly ToolboxModule[] = [
  { id: "git", name: "Git 管理", route: "/git", component: GitPage, icon: GitBranch },
  { id: "image", name: "图片处理", route: "/image", component: ImagePage, icon: ImageIcon },
  { id: "inventory", name: "库存管理", route: "/inventory", component: InventoryPage, icon: Boxes },
  { id: "snake", name: "Snake", route: "/snake", component: SnakePage, icon: Gamepad2 },
  { id: "ports", name: "端口管理", route: "/ports", component: PortsPage, icon: Network, settingsComponent: PortsSettings },
  { id: "cache", name: "开发缓存管理", route: "/cache", component: CachePage, icon: HardDrive },
];
