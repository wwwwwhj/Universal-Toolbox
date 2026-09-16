import { useSyncExternalStore } from "react";
import { modules, type ToolboxModule } from "./modules";

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function resolveModule(hash: string, list: readonly ToolboxModule[] = modules) {
  const route = hash.replace(/^#/, "");
  // 空入口显示排序后的第一个工具；未知地址保留，以便提示而不是静默跳转。
  return route === "" || route === "/"
    ? list[0]
    : list.find((module) => module.route === route);
}

export function useHash() {
  // Hash 不依赖服务器路径回退，开发与 Tauri 打包后的入口都能直接刷新。
  return useSyncExternalStore(subscribe, () => window.location.hash, () => "");
}
