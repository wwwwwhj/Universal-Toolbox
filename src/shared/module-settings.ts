import { useSyncExternalStore } from "react";

// 模块级设置的通用容器：内存状态 + localStorage 持久化 + 订阅通知。
// 业务页和设置分区读写同一个实例即完成联动，同一窗口内修改立即生效；
// localStorage 只负责持久化，写入时主动通知订阅者而不是依赖 storage 事件。
export interface ModuleSettings<T> {
  get(): T;
  update(patch: Partial<T>): void;
  reset(): void;
  subscribe(listener: () => void): () => void;
  use(): T;
  // 最近一次写入本机存储失败的信息，null 表示正常；设置分区可据此提示用户修改未被记住。
  usePersistError(): string | null;
}

interface ModuleSettingsOptions<T> {
  // 模块自己的 localStorage 键，建议带模块名前缀避免与其他模块冲突。
  key: string;
  defaults: T;
  // 持久化数据逐字段校验，非法或缺失的值回退到 defaults。
  parse(raw: Record<string, unknown>): T;
}

export function createModuleSettings<T extends object>(options: ModuleSettingsOptions<T>): ModuleSettings<T> {
  const listeners = new Set<() => void>();
  let current: T | null = null;
  let persistError: string | null = null;

  function read(): T {
    if (typeof localStorage === "undefined") return options.defaults;
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(options.key) ?? "{}");
      return options.parse(raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
    } catch (error) {
      console.warn(`[module-settings] 读取 ${options.key} 失败，已回退到默认值`, error);
      return options.defaults;
    }
  }

  function get(): T {
    if (current === null) current = read();
    return current;
  }

  function commit(next: T) {
    current = next;
    persistError = null;
    try {
      localStorage.setItem(options.key, JSON.stringify(next));
    } catch (error) {
      // 写入失败（如配额）时内存状态仍然生效，但需保留调试上下文并允许 UI 提示修改不会被记住。
      persistError = String(error);
      console.warn(`[module-settings] 写入 ${options.key} 失败`, error);
    }
    for (const listener of listeners) listener();
  }

  const store: ModuleSettings<T> = {
    get,
    update: (patch) => commit({ ...get(), ...patch }),
    reset: () => commit(options.defaults),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    use: () => useSyncExternalStore(store.subscribe, store.get, () => options.defaults),
    usePersistError: () => useSyncExternalStore(store.subscribe, () => persistError, () => null),
  };
  return store;
}
