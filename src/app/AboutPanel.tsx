import { useEffect, useState, useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { updater } from "./updater";

function formatSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(raw: string | undefined) {
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString();
}

export default function AboutPanel() {
  const [version, setVersion] = useState("");
  const status = useSyncExternalStore(updater.subscribe, updater.getStatus);
  const busy = status.kind === "checking" || status.kind === "downloading";

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(""));
  }, []);

  return (
    <>
      <p>应用版本与更新。更新包来自 GitHub Releases，下载后自动安装，重启应用生效。</p>
      <div className="ui-field">
        <span>当前版本</span>
        <span>{version || "未知"}</span>
      </div>
      <div className="ui-actions">
        <button
          className="ui-button"
          type="button"
          disabled={busy || status.kind === "ready"}
          onClick={() => updater.check()}
        >
          {status.kind === "checking" ? "正在检查…" : "检查更新"}
        </button>
        {status.kind === "available" && (
          <button
            className="ui-button ui-button--primary"
            type="button"
            onClick={() => updater.install(status.update)}
          >
            下载并安装
          </button>
        )}
        {status.kind === "ready" && (
          <button
            className="ui-button ui-button--primary"
            type="button"
            onClick={() => updater.relaunch()}
          >
            重启应用
          </button>
        )}
      </div>
      {status.kind === "checking" && (
        <p className="ui-feedback" role="status">正在检查更新…</p>
      )}
      {status.kind === "latest" && (
        <p className="ui-feedback ui-feedback--success" role="status">当前已是最新版本。</p>
      )}
      {status.kind === "available" && (
        <div className="ui-feedback" role="status">
          <p>
            发现新版本 {status.update.version}
            {status.update.date ? `（${formatDate(status.update.date)}）` : ""}
          </p>
          <p>
            开始安装后：Windows 上应用会自动退出并由安装程序完成更新和重启；
            macOS / Linux 安装完成后需手动重启应用。
          </p>
          {status.update.body && (
            <details className="ui-help">
              <summary>更新说明</summary>
              <p>{status.update.body}</p>
            </details>
          )}
        </div>
      )}
      {status.kind === "downloading" && (
        <div className="ui-feedback" role="status">
          <p>
            正在下载更新…
            {status.total
              ? ` ${formatSize(status.received)} / ${formatSize(status.total)}`
              : ` 已下载 ${formatSize(status.received)}`}
          </p>
          {status.total ? (
            <progress max={status.total} value={status.received} />
          ) : (
            <progress />
          )}
        </div>
      )}
      {status.kind === "ready" && (
        <p className="ui-feedback ui-feedback--success" role="status">
          更新安装完成，重启应用后生效。
        </p>
      )}
      {status.kind === "error" && (
        <p className="ui-feedback ui-feedback--error" role="alert">
          更新失败：{status.message}
        </p>
      )}
    </>
  );
}
