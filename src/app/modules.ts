import type { ComponentType } from "react";
import GitPage from "../modules/git/GitPage";
import ImagePage from "../modules/image/ImagePage";
import InventoryPage from "../modules/inventory/InventoryPage";
import SnakePage from "../modules/snake/SnakePage";
import PortsPage from "../modules/ports/PortsPage";

interface ToolboxModule {
  id: string;
  name: string;
  route: `/${string}`;
  component: ComponentType;
}

// 导航与路由共用静态清单，新增工具无需修改 Shell 或其他模块。
export const modules: readonly ToolboxModule[] = [
  { id: "git", name: "Git 管理", route: "/git", component: GitPage },
  { id: "image", name: "图片处理", route: "/image", component: ImagePage },
  { id: "inventory", name: "库存管理", route: "/inventory", component: InventoryPage },
  { id: "snake", name: "Snake", route: "/snake", component: SnakePage },
  { id: "ports", name: "端口管理", route: "/ports", component: PortsPage },
];
