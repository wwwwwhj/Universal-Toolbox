import { relaunch } from "@tauri-apps/plugin-process";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; received: number; total?: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

// 更新任务状态放在模块级：切换页面或设置分类时组件卸载，任务与进度不丢失，
// 也保证同一时间只有一个检查/下载任务在运行。
let status: UpdateStatus = { kind: "idle" };
const listeners = new Set<() => void>();
// 每次任务递增，使上一个任务迟到的事件与结果失效。
let runId = 0;

function emit(next: UpdateStatus) {
  status = next;
  listeners.forEach((listener) => listener());
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Update 是原生资源，不会随 JS 对象回收；被替换前必须显式释放。
function discardAvailable() {
  if (status.kind === "available") void status.update.close().catch(() => {});
}

export const updater = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getStatus: () => status,

  async check() {
    // ready 表示已安装待重启：当前进程仍是旧版本，禁止再次检查以免重复提示同一更新。
    if (status.kind === "checking" || status.kind === "downloading" || status.kind === "ready") return;
    const id = ++runId;
    discardAvailable();
    emit({ kind: "checking" });
    try {
      const update = await checkForUpdate({ timeout: CHECK_TIMEOUT_MS });
      if (id !== runId) {
        void update?.close().catch(() => {});
        return;
      }
      emit(update ? { kind: "available", update } : { kind: "latest" });
    } catch (error) {
      if (id === runId) emit({ kind: "error", message: errorMessage(error) });
    }
  },

  async install(update: Update) {
    if (status.kind !== "available" || status.update !== update) return;
    const id = ++runId;
    emit({ kind: "downloading", received: 0 });
    try {
      await update.downloadAndInstall(
        (event) => {
          if (id !== runId) return;
          if (event.event === "Started") {
            emit({ kind: "downloading", received: 0, total: event.data.contentLength });
          } else if (event.event === "Progress" && status.kind === "downloading") {
            emit({ ...status, received: status.received + event.data.chunkLength });
          }
        },
        { timeout: DOWNLOAD_TIMEOUT_MS },
      );
      if (id === runId) emit({ kind: "ready" });
    } catch (error) {
      if (id === runId) emit({ kind: "error", message: errorMessage(error) });
    } finally {
      void update.close().catch(() => {});
    }
  },

  relaunch,
};
