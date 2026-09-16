import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./cache.css";

interface CacheDir {
  path: string;
  source: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  error: string | null;
  // 列表中存在被本目录覆盖的子目录条目；sizeBytes 已排除那些子树。
  nested: boolean;
}

interface CacheTarget {
  id: string;
  name: string;
  category: string;
  dirs: CacheDir[];
  totalBytes: number;
  canSet: boolean;
  setCommand: string | null;
  relocateGuide: string | null;
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
// 结构随功能演进会变化，用版本号区分，旧快照直接作废并重新扫描。
const STORAGE_KEY = "cache-module-scan";
const SNAPSHOT_VERSION = 4;

interface ScanResult {
  targets: CacheTarget[];
  // 跨工具去重后的合计：不同工具指向相同或父子重叠的目录只计一次。
  unionBytes: number;
}

interface ScanSnapshot extends ScanResult {
  v: number;
  scannedAt: string;
}

interface Stored {
  snapshot: ScanSnapshot | null;
  // 无论快照版本是否匹配都保留的历史目录路径：旧自定义目录只存在快照里，
  // 版本升级丢弃整个快照会永远丢失它们，需作为重扫的 previous 种子。
  previous: Record<string, string[]>;
}

function loadStored(): Stored {
  const empty: Stored = { snapshot: null, previous: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const data = JSON.parse(raw);
    const previous: Record<string, string[]> = {};
    if (Array.isArray(data?.targets)) {
      for (const target of data.targets) {
        if (typeof target?.id !== "string" || !Array.isArray(target?.dirs)) continue;
        const paths = target.dirs
          .filter((dir: CacheDir) => dir?.exists === true && typeof dir?.path === "string")
          .map((dir: CacheDir) => dir.path);
        if (paths.length > 0) previous[target.id] = paths;
      }
    }
    const valid = data?.v === SNAPSHOT_VERSION
      && typeof data?.scannedAt === "string"
      && Array.isArray(data?.targets);
    return { snapshot: valid ? (data as ScanSnapshot) : null, previous };
  } catch {
    return empty;
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
  const [stored] = useState(loadStored);
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(stored.snapshot);
  // 版本不符的快照中抢救出的历史目录，供首次重扫继续统计；消费后清空。
  const salvaged = useRef(stored.previous);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showMissing, setShowMissing] = useState(false);
  const [editing, setEditing] = useState<CacheTarget | null>(null);
  const [newPath, setNewPath] = useState("");
  const [dialogError, setDialogError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const started = useRef(false);
  const desktop = isTauri();
  const targets = snapshot?.targets ?? null;

  const visible = (targets ?? [])
    .filter((target) => showMissing || detected(target))
    .sort((a, b) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name, "zh-CN"));
  const detectedTargets = (targets ?? []).filter(detected);
  const dirCount = detectedTargets.flatMap((target) => target.dirs).filter((dir) => dir.exists).length;
  const totalBytes = snapshot?.unionBytes ?? 0;
  const rawTotal = detectedTargets.reduce((sum, target) => sum + target.totalBytes, 0);

  useEffect(() => {
    // 有快照就不自动扫描；仅首次使用（无快照）时自动扫一次。
    if (started.current || !desktop || snapshot) return;
    started.current = true;
    void scan();
  }, [desktop, snapshot]);

  useEffect(() => {
    if (editing && !dialog.current?.open) dialog.current?.showModal();
    if (!editing && dialog.current?.open) dialog.current.close();
  }, [editing]);

  async function scan() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // 回传上次快照中仍存在的目录：改过位置的旧目录不再由工具配置报告，
      // 后端会对其重新统计并标注为「之前的位置」。
      const previous: Record<string, string[]> = { ...salvaged.current };
      for (const target of snapshot?.targets ?? []) {
        const paths = target.dirs.filter((dir) => dir.exists).map((dir) => dir.path);
        if (paths.length > 0) previous[target.id] = paths;
      }
      const result = await invoke<ScanResult>("scan_dev_caches", { previous });
      const next: ScanSnapshot = { v: SNAPSHOT_VERSION, scannedAt: new Date().toISOString(), ...result };
      setSnapshot(next);
      saveSnapshot(next);
      salvaged.current = {};
    } catch (scanError) {
      setError(String(scanError));
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(target: CacheTarget) {
    setEditing(target);
    setNewPath("");
    setDialogError("");
    setError("");
    setMessage("");
  }

  async function applyNewPath() {
    if (!editing) return;
    const path = newPath.trim();
    if (path === "") {
      setDialogError("请输入新的缓存目录绝对路径。");
      return;
    }
    setBusy(true);
    setDialogError("");
    setError("");
    setMessage("");
    try {
      await invoke("set_cache_dir", { id: editing.id, path });
      dialog.current?.close();
      // 配置已写入；重新扫描让列表直接反映工具报告的生效结果。
      setMessage(`已执行 ${editing.setCommand ?? "配置命令"}，正在重新扫描…`);
      await scan();
    } catch (applyError) {
      // 失败原因展示在弹窗内部，避免被模态遮挡。
      setDialogError(String(applyError));
    } finally {
      setBusy(false);
    }
  }

  async function open(path: string) {
    try {
      await invoke("open_cache_dir", { path });
    } catch (openError) {
      setError(`无法打开缓存目录：${String(openError)}`);
    }
  }

  return (
    <section className="cache-page">
      <h1>开发缓存管理</h1>
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
      {message && <p className="ui-feedback ui-feedback--success" role="status">{message}</p>}
      {targets && (
        <>
          <p role="status">
            已检测到 {detectedTargets.length} 个工具的 {dirCount} 个缓存目录，总计 {formatBytes(totalBytes)}{rawTotal > totalBytes ? `（已剔除 ${formatBytes(rawTotal - totalBytes)} 重叠目录的重复统计）` : ""}（扫描于 {new Date(snapshot!.scannedAt).toLocaleString()}）。大小按文件逻辑字节统计，与磁盘占用可能略有差异。
          </p>
          {visible.length === 0 ? (
            <p>没有检测到已知工具的缓存目录。</p>
          ) : (
            <div className="ui-table-wrap" tabIndex={0} role="region" aria-label="缓存目录列表，可横向滚动">
              <table className="ui-table">
                <thead>
                  <tr><th>缓存</th><th>大小</th><th>目录</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {visible.map((target) => (
                    <tr key={target.id}>
                      <td><strong>{target.name}</strong><small>{target.category}</small></td>
                      <td className="cache-size">{detected(target) ? formatBytes(target.totalBytes) : "—"}</td>
                      <td>
                        {target.dirs.map((dir) => (
                          <div className="cache-dir" key={dir.path}>
                            <div className="cache-dir-head">
                              <code>{dir.path}</code>
                              {dir.exists && desktop && (
                                <button type="button" className="ui-button" onClick={() => void open(dir.path)}
                                  aria-label={`在文件管理器中打开 ${dir.path}`}>打开</button>
                              )}
                            </div>
                            <small>
                              {dir.source}
                              {dir.exists
                                ? ` · ${formatBytes(dir.sizeBytes)} · ${dir.fileCount.toLocaleString()} 个文件`
                                : " · 未创建"}
                              {dir.nested ? " · 大小不含单列子目录" : ""}
                              {dir.error ? ` · ${dir.error}` : ""}
                            </small>
                          </div>
                        ))}
                      </td>
                      <td>
                        {(target.canSet || target.relocateGuide) && desktop && (
                          <button type="button" className="ui-button" onClick={() => beginEdit(target)} disabled={busy}
                            aria-label={`更改 ${target.name} 的缓存位置`}>更改位置</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <dialog ref={dialog} className="ui-dialog cache-dialog" aria-labelledby="cache-set-title"
        onClose={() => { setEditing(null); setDialogError(""); }}
        onCancel={(event) => { if (busy) event.preventDefault(); }}
        onClick={(event) => { if (!busy && event.target === dialog.current) dialog.current.close(); }}>
        {editing && (
          <>
            <h2 id="cache-set-title">更改 {editing.name} 的缓存位置</h2>
            <dl>
              <dt>当前目录</dt>
              {editing.dirs.map((dir) => <dd key={dir.path}><code>{dir.path}</code></dd>)}
            </dl>
            {editing.setCommand ? (
              <form onSubmit={(event) => { event.preventDefault(); void applyNewPath(); }}>
                <div className="ui-field">
                  <label htmlFor="cache-new-path">新目录（绝对路径，不存在会自动创建）</label>
                  <input className="ui-input" id="cache-new-path" type="text" autoFocus
                    placeholder={editing.dirs[0]?.path ?? "例如 D:\\dev-cache\\npm"}
                    value={newPath} onChange={(event) => setNewPath(event.target.value)} disabled={busy} />
                </div>
                <p>将执行 <code>{editing.setCommand}</code>，写入该工具的全局配置。已有缓存内容不会自动迁移，旧目录仍会显示在列表中。</p>
                {dialogError && <p className="ui-feedback ui-feedback--error" role="alert">{dialogError}</p>}
                <div className="ui-actions cache-dialog-actions">
                  <button type="submit" className="ui-button ui-button--primary" disabled={busy}>
                    {busy ? "处理中…" : "确认修改"}
                  </button>
                  <button type="button" className="ui-button" onClick={() => dialog.current?.close()} disabled={busy}>取消</button>
                </div>
              </form>
            ) : (
              <>
                <p className="cache-guide">{editing.relocateGuide}</p>
                <div className="ui-actions cache-dialog-actions">
                  <button type="button" className="ui-button" onClick={() => dialog.current?.close()}>关闭</button>
                </div>
              </>
            )}
          </>
        )}
      </dialog>
    </section>
  );
}
