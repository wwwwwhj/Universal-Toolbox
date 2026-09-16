import { createModuleSettings } from "../../shared/module-settings";

export type PortsSortKey = "port" | "name";

// 端口列表的视图行为，业务页与设置分区共享同一份状态：页内的排序、
// 筛选和自动刷新切换会直接写入并记住，设置页修改也对打开的页面即时生效。
export interface PortsSettings {
  sortKey: PortsSortKey;
  sortAsc: boolean;
  listenOnly: boolean;
  autoRefresh: boolean;
  refreshSeconds: number;
}

export const REFRESH_OPTIONS = [3, 5, 10, 30] as const;

export const portsSettings = createModuleSettings<PortsSettings>({
  key: "ports-module-settings",
  defaults: { sortKey: "port", sortAsc: true, listenOnly: false, autoRefresh: false, refreshSeconds: 5 },
  parse(raw) {
    const seconds = Number(raw.refreshSeconds);
    return {
      sortKey: raw.sortKey === "name" ? "name" : "port",
      sortAsc: typeof raw.sortAsc === "boolean" ? raw.sortAsc : true,
      listenOnly: raw.listenOnly === true,
      autoRefresh: raw.autoRefresh === true,
      refreshSeconds: (REFRESH_OPTIONS as readonly number[]).includes(seconds) ? seconds : 5,
    };
  },
});
