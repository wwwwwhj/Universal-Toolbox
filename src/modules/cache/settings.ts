import { createModuleSettings } from "../../shared/module-settings";

// 用户自定义的缓存目标：工具名 + 获取路径命令 + 修改路径命令 + 固定目录。
// getCommand 输出中最后一个绝对路径行作为缓存目录；setCommand 中 {path} 会被替换为新目录。
export interface CustomCacheTarget {
  id: string;
  name: string;
  getCommand: string;
  setCommand: string;
  dirs: string[];
}

interface CacheSettings {
  customTargets: CustomCacheTarget[];
  // 从扫描和列表中移除的内置目标 id；恢复默认可还原。
  hiddenIds: string[];
}

function parseTargets(raw: unknown): CustomCacheTarget[] {
  if (!Array.isArray(raw)) return [];
  const targets: CustomCacheTarget[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id === "") continue;
    if (typeof entry.name !== "string" || entry.name === "") continue;
    targets.push({
      id: entry.id,
      name: entry.name,
      getCommand: typeof entry.getCommand === "string" ? entry.getCommand : "",
      setCommand: typeof entry.setCommand === "string" ? entry.setCommand : "",
      dirs: Array.isArray(entry.dirs)
        ? entry.dirs.filter((dir): dir is string => typeof dir === "string" && dir !== "")
        : [],
    });
  }
  return targets;
}

export const cacheSettings = createModuleSettings<CacheSettings>({
  key: "cache-module-settings",
  defaults: { customTargets: [], hiddenIds: [] },
  parse(raw) {
    return {
      customTargets: parseTargets(raw.customTargets),
      hiddenIds: Array.isArray(raw.hiddenIds)
        ? raw.hiddenIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  },
});
