import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import "./cache.css";

interface CacheDir {
  path: string;
  source: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  error: string | null;
}

interface CacheTarget {
  id: string;
  name: string;
  category: string;
  dirs: CacheDir[];
  totalBytes: number;
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${SIZE_UNITS[unit]}`;
}

function detected(target: CacheTarget) {
  return target.dirs.some((dir) => dir.exists);
}

// 扫描结果持久化在本模块自己的 localStorage 键下，翻页或重开应用后直接展示上次快照。
const STORAGE_KEY = "cache-module-scan";

interface ScanSnapshot {
  scannedAt: string;
  targets: CacheTarget[];
}

function loadSnapshot(): ScanSnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as ScanSnapshot;
    if (typeof data?.scannedAt !== "string" || !Array.isArray(data?.targets)) return null;
    return data;
  } catch {
    return null;
  }
}

function saveSnapshot(snapshot: ScanSnapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 快照只是缓存，写入失败（如配额）不影响本次结果展示。
  }
}

export default function CachePage() {
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(loadSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showMissing, setShowMissing] = useState(false);
  const started = useRef(false);
  const desktop = isTauri();
  const targets = snapshot?.targets ?? null;

  const visible = (targets ?? [])
    .filter((target) => showMissing || detected(target))
    .sort((a, b) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name, "zh-CN"));
  const detectedTargets = (targets ?? []).filter(detected);
  const dirCount = detectedTargets.flatMap((target) => target.dirs).filter((dir) => dir.exists).length;
  const totalBytes = detectedTargets.reduce((sum, target) => sum + target.totalBytes, 0);

  useEffect(() => {
    // 有快照就不自动扫描；仅首次使用（无快照）时自动扫一次。
    if (started.current || !desktop || snapshot) return;
    started.current = true;
    void scan();
  }, [desktop, snapshot]);

  async function scan() {
    setBusy(true);
    setError("");
    try {
      const next = { scannedAt: new Date().toISOString(), targets: await invoke<CacheTarget[]>("scan_dev_caches") };
      setSnapshot(next);
      saveSnapshot(next);
    } catch (scanError) {
      setError(String(scanError));
    } finally {
      setBusy(false);
    }
  }

  async function open(path: string) {
    try {
      await openPath(path);
    } catch (openError) {
      setError(`无法打开缓存目录：${String(openError)}`);
    }
  }

  return (
    <section className="cache-page">
      <h1>缓存管理</h1>
      <p>探测本机开发工具（npm、pnpm、Cargo、Go 等）的缓存目录并统计占用空间。优先读取工具自身的配置，其次检查环境变量和平台默认路径。</p>
      {!desktop && <p className="ui-feedback" role="status">请在 Tauri 桌面应用中使用此功能，浏览器无法扫描本机目录。</p>}
      <form className="ui-toolbar" onSubmit={(event) => { event.preventDefault(); void scan(); }}>
        <button className="ui-button ui-button--primary" type="submit" disabled={busy || !desktop}>
          {busy ? "扫描中…" : targets ? "重新扫描" : "开始扫描"}
        </button>
        {targets && !desktop && (
          <small className="cache-snapshot-note">以下为最近一次扫描的快照，重新扫描需在桌面应用中进行。</small>
        )}
        {targets && (
          <label className="cache-showall">
            <input type="checkbox" checked={showMissing} onChange={(event) => setShowMissing(event.target.checked)} />
            显示未检测到的工具
          </label>
        )}
      </form>
      {error && <p className="ui-feedback ui-feedback--error" role="alert">{error}</p>}
      {targets && (
        <>
          <p role="status">
            已检测到 {detectedTargets.length} 个工具的 {dirCount} 个缓存目录，总计 {formatBytes(totalBytes)}（扫描于 {new Date(snapshot!.scannedAt).toLocaleString()}）。大小按文件逻辑字节统计，与磁盘占用可能略有差异。
          </p>
          {visible.length === 0 ? (
            <p>没有检测到已知工具的缓存目录。</p>
          ) : (
            <div className="ui-table-wrap" tabIndex={0} role="region" aria-label="缓存目录列表，可横向滚动">
              <table className="ui-table">
                <thead>
                  <tr><th>缓存</th><th>大小</th><th>目录</th></tr>
                </thead>
                <tbody>
                  {visible.map((target) => (
                    <tr key={target.id}>
                      <td><strong>{target.name}</strong><small>{target.category}</small></td>
                      <td className="cache-size">{detected(target) ? formatBytes(target.totalBytes) : "—"}</td>
                      <td>
                        {target.dirs.map((dir) => (
                          <div className="cache-dir" key={dir.path}>
                            <div className="cache-dir-main">
                              <code>{dir.path}</code>
                              <small>
                                {dir.source}
                                {dir.exists
                                  ? ` · ${formatBytes(dir.sizeBytes)} · ${dir.fileCount.toLocaleString()} 个文件`
                                  : " · 未创建"}
                                {dir.error ? ` · ${dir.error}` : ""}
                              </small>
                            </div>
                            {dir.exists && (
                              <button type="button" className="ui-button" onClick={() => void open(dir.path)}
                                aria-label={`在文件管理器中打开 ${dir.path}`}>打开</button>
                            )}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
