import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import "./ports.css";

interface PortOwner {
  platform: "windows" | "macos";
  protocol: string;
  address: string;
  remoteAddress: string | null;
  port: number;
  pid: number;
  state: string;
  name: string;
  path: string | null;
  workingDirectory: string | null;
  workingDirectoryError: string | null;
  startedAt: string | null;
  blockedReason: string | null;
  startedAtDisplay: string | null;
  commandLine: string | null;
  parentPid: number | null;
  parentName: string | null;
  services: { name: string; displayName: string; state: string }[] | null;
  detailsWarnings: string[];
}

interface Endpoint {
  address: string;
  remote: string | null;
  state: string;
}

type GroupedRow = PortOwner & { endpoints: Endpoint[] };

export function groupPortOwners(rows: PortOwner[]): GroupedRow[] {
  const groups = new Map<string, GroupedRow>();
  for (const row of rows) {
    const key = `${row.pid}-${row.port}-${row.protocol}`;
    let group = groups.get(key);
    if (!group) {
      group = { ...row, endpoints: [] };
      groups.set(key, group);
    }
    // 地址、对端和状态成组保留，避免合并后把已连接地址误展示为监听地址。
    const remote = row.remoteAddress ?? null;
    if (!group.endpoints.some((endpoint) => endpoint.address === row.address && endpoint.remote === remote && endpoint.state === row.state)) {
      group.endpoints.push({ address: row.address, remote, state: row.state });
    }
  }
  return [...groups.values()];
}

interface NameFilter {
  label: string;
  match: (row: PortOwner) => boolean;
}

// 预设按进程名精确匹配；Windows 的 ProcessName 和 macOS 的 lsof 命令名都不带扩展名。
const PROCESS_PRESETS: NameFilter[] = [
  { label: "Node.js", match: (row) => row.name.toLowerCase() === "node" },
  { label: "Java", match: (row) => ["java", "javaw"].includes(row.name.toLowerCase()) },
  { label: "Python", match: (row) => /^pythonw?[\d.]*$/.test(row.name.toLowerCase()) },
];

interface QueryTarget {
  port: number | null;
  name: NameFilter | null;
}

function isListenEndpoint(endpoint: Endpoint) {
  return endpoint.state === "LISTENING" || endpoint.state === "BOUND";
}

function CopyButton(props: {
  field: string;
  value: string | null;
  copied: { key: string; ok: boolean } | null;
  onCopy: (key: string, value: string) => void;
}) {
  if (!props.value) return null;
  const state = props.copied?.key === props.field ? props.copied : null;
  return (
    <button type="button" className="ports-copy" onClick={() => props.onCopy(props.field, props.value!)}>
      {state ? (state.ok ? "已复制" : "复制失败") : "复制"}
    </button>
  );
}

export default function PortsPage() {
  const [port, setPort] = useState("");
  const [procName, setProcName] = useState("");
  const [rows, setRows] = useState<PortOwner[]>([]);
  const [query, setQuery] = useState<QueryTarget | null>(null);
  const [hasQueried, setHasQueried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<PortOwner | null>(null);
  const [detail, setDetail] = useState<PortOwner | null>(null);
  const [listenOnly, setListenOnly] = useState(false);
  const [sort, setSort] = useState<{ key: "port" | "name"; asc: boolean }>({ key: "port", asc: true });
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [copied, setCopied] = useState<{ key: string; ok: boolean } | null>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const polling = useRef(false);
  const generation = useRef(0);
  const desktop = isTauri();

  const groupedRows = groupPortOwners(rows);
  const filteredRows = listenOnly
    ? groupedRows
        .map((row) => ({ ...row, endpoints: row.endpoints.filter(isListenEndpoint) }))
        .filter((row) => row.endpoints.length > 0)
    : groupedRows;
  const displayedRows = [...filteredRows].sort((a, b) => {
    const cmp = sort.key === "port"
      ? a.port - b.port || a.protocol.localeCompare(b.protocol)
      : a.name.localeCompare(b.name) || a.port - b.port;
    return (cmp || a.pid - b.pid) * (sort.asc ? 1 : -1);
  });
  const queryParts = query
    ? [query.port !== null ? `端口 ${query.port}` : null, query.name ? `${query.name.label} 进程` : null]
    : [];
  const queryLabel = queryParts.filter(Boolean).join(" · ") || "全部端口";

  useEffect(() => {
    // 从长列表选择进程时，把确认信息带入视野和键盘焦点。
    if (selected) confirmation.current?.focus();
  }, [selected]);

  useEffect(() => {
    // 详情开关统一走 dialog 的 open 状态，关闭事件再清空选中的行。
    if (detail && !dialog.current?.open) dialog.current?.showModal();
    if (!detail && dialog.current?.open) dialog.current.close();
  }, [detail]);

  useEffect(() => {
    if (!autoRefresh || !query || !desktop) return;
    const timer = window.setInterval(() => {
      if (polling.current || busy) return;
      polling.current = true;
      const gen = generation.current;
      // 后台轮询不清空已有结果；期间发起过手动查询就丢弃过期轮询结果。
      void fetchRows(query)
        .then((result) => { if (generation.current === gen) setRows(result); })
        .catch(() => {})
        .finally(() => { polling.current = false; });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, query, desktop, busy]);

  async function fetchRows(target: QueryTarget) {
    const result = await invoke<PortOwner[]>("list_port_owners", { port: target.port });
    const filter = target.name;
    return filter ? result.filter((row) => filter.match(row)) : result;
  }

  async function refresh(target: QueryTarget) {
    setRows(await fetchRows(target));
    setQuery(target);
    setHasQueried(true);
  }

  async function runQuery(target: QueryTarget) {
    generation.current++;
    setBusy(true);
    setError("");
    setMessage("");
    setSelected(null);
    setDetail(null);
    // 新查询失败时不保留旧列表，避免把旧结果误认为当前查询的占用。
    setRows([]);
    setHasQueried(false);
    try { await refresh(target); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  async function search() {
    const portText = port.trim();
    const nameText = procName.trim();
    if (portText !== "" && (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)) {
      setError("请输入 1–65535 之间的整数端口，或留空查询全部。");
      return;
    }
    // 自由文本同时匹配进程名、启动命令和程序路径，否则搜脚本名/服务名会漏掉 node、java 这类宿主进程。
    const text = nameText.toLowerCase();
    await runQuery({
      port: portText === "" ? null : Number(portText),
      name: nameText === "" ? null : {
        label: nameText,
        match: (row) => [row.name, row.commandLine, row.path]
          .some((value) => value?.toLowerCase().includes(text)),
      },
    });
  }

  function toggleSort(key: "port" | "name") {
    setSort((current) => current.key === key ? { key, asc: !current.asc } : { key, asc: true });
  }

  function copy(field: string, value: string) {
    // 非安全上下文中 navigator.clipboard 可能不存在，访问前先判空。
    if (!navigator.clipboard?.writeText) {
      setCopied({ key: field, ok: false });
      return;
    }
    void navigator.clipboard.writeText(value)
      .then(() => setCopied({ key: field, ok: true }))
      .catch(() => setCopied({ key: field, ok: false }));
    window.setTimeout(() => setCopied((current) => current?.key === field ? null : current), 1500);
  }

  function askStop(row: PortOwner) {
    setSelected(row);
    setError("");
    setMessage("");
    if (dialog.current?.open) dialog.current.close();
  }

  async function stop() {
    if (!selected?.startedAt) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await invoke("stop_port_owner", {
        port: selected.port, pid: selected.pid, startedAt: selected.startedAt,
      });
      setMessage(`已停止 ${selected.name}（PID ${selected.pid}）。`);
      setSelected(null);
      generation.current++;
      // 停止成功与刷新失败分别反馈，避免误导用户再次停止同一个 PID。
      setRows([]);
      setHasQueried(false);
      try { await refresh(query ?? { port: null, name: null }); }
      catch (error) { setError(`进程已停止，但刷新失败：${String(error)}`); }
    } catch (error) {
      setError(String(error));
      setSelected(null);
    } finally { setBusy(false); }
  }

  const sortIcon = (key: "port" | "name") =>
    sort.key === key
      ? (sort.asc ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />)
      : <ArrowUpDown size={14} aria-hidden="true" />;

  return (
    <section className="ports-page">
      <h1>端口管理</h1>
      <p>查询 Windows / macOS 本地 TCP/UDP 端口占用，停止占用端口的进程。结果受当前账户的系统权限限制。</p>
      {!desktop && <p className="ui-feedback" role="status">请在 Tauri 桌面应用中使用此功能，浏览器无法查询或停止本机进程。</p>}
      <form className="ui-toolbar" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <div className="ui-field">
        <label htmlFor="port-number">端口号</label>
        <input className="ui-input" id="port-number" type="text" inputMode="numeric" placeholder="例如 1420，留空查询全部"
          value={port} onChange={(event) => setPort(event.target.value)} disabled={busy || !desktop} />
        </div>
        <div className="ui-field">
        <label htmlFor="process-name">进程名</label>
        <input className="ui-input ports-name-input" id="process-name" type="text" placeholder="进程名 / 命令行关键字，留空不限"
          value={procName} onChange={(event) => setProcName(event.target.value)} disabled={busy || !desktop} />
        </div>
        <button className="ui-button ui-button--primary" type="submit" disabled={busy || !desktop}>{busy ? "处理中…" : "查询 / 刷新"}</button>
        <div className="ui-field" role="group" aria-label="常用类型">
          <span>常用类型</span>
          <div className="ui-actions">
            {PROCESS_PRESETS.map((preset) => (
              <button key={preset.label} className="ui-button" type="button" disabled={busy || !desktop}
                onClick={() => void runQuery({ port: null, name: preset })}>{preset.label}</button>
            ))}
          </div>
        </div>
      </form>
      {error && <p className="ui-feedback ui-feedback--error" role="alert">{error}</p>}
      {message && <p className="ui-feedback ui-feedback--success" role="status">{message}</p>}
      {selected && (
        <div ref={confirmation} tabIndex={-1} className="ui-confirm" role="group" aria-label="确认停止进程">
          <h2>停止 {selected.name}（PID {selected.pid}）？</h2>
          <p>端口：{selected.port} / {selected.protocol}；路径：{selected.path || "无法读取"}</p>
          <p>工作目录：{selected.workingDirectory || "无法读取"}</p>
          <p>{selected.platform === "macos" ? "这会向整个进程发送终止信号，不自动强杀。" : "这会强制结束整个进程。"}影响它的所有端口，未保存的数据可能丢失。若有守护程序，进程可能自动重启。</p>
          <div className="ui-actions">
            <button type="button" className="ui-button ui-button--danger" onClick={() => void stop()} disabled={busy}>确认停止</button>
            <button className="ui-button" type="button" onClick={() => setSelected(null)} disabled={busy}>取消</button>
          </div>
        </div>
      )}
      {hasQueried && (
        <>
          <div className="ports-viewbar">
            <p role="status">{queryLabel}：{displayedRows.length} 组占用（按进程、端口和协议合并）</p>
            <div className="ui-segmented" role="radiogroup" aria-label="状态筛选">
              <label>
                <input type="radio" name="ports-state" value="all" checked={!listenOnly} onChange={() => setListenOnly(false)} />全部
              </label>
              <label>
                <input type="radio" name="ports-state" value="listen" checked={listenOnly} onChange={() => setListenOnly(true)} />仅监听
              </label>
            </div>
            <label className="ports-autorefresh">
              <input type="checkbox" checked={autoRefresh} disabled={!desktop || !query}
                onChange={(event) => setAutoRefresh(event.target.checked)} />自动刷新（5 秒）
            </label>
          </div>
          <details className="ui-help">
            <summary>地址说明 · IPv4 / IPv6</summary>
            <p>IPv4 地址如 127.0.0.1，IPv6 地址如 [::1]，这两个都是本机回环地址。监听时，0.0.0.0 表示全部 IPv4 地址，[::] 表示全部 IPv6 地址。已连接的对端显示在「远端地址」列。</p>
          </details>
          {rows.length === 0 ? <p>未发现匹配记录（{queryLabel}）。此结果不包含无所属进程的 TIME_WAIT 记录或系统保留端口。</p>
          : displayedRows.length === 0 ? <p>没有监听中的端口，切换「全部」查看连接状态。</p> : (
            <div className="ui-table-wrap" tabIndex={0} role="region" aria-label="端口占用结果，可横向滚动">
              <table className="ui-table">
                <thead><tr>
                  <th aria-sort={sort.key === "port" ? (sort.asc ? "ascending" : "descending") : "none"}>
                    <button type="button" className="ports-sort" onClick={() => toggleSort("port")}>端口 / 协议{sortIcon("port")}</button>
                  </th>
                  <th>本地地址</th>
                  <th>远端地址</th>
                  <th>状态</th>
                  <th aria-sort={sort.key === "name" ? (sort.asc ? "ascending" : "descending") : "none"}>
                    <button type="button" className="ports-sort" onClick={() => toggleSort("name")}>进程 / PID{sortIcon("name")}</button>
                  </th>
                  <th>操作</th>
                </tr></thead>
                <tbody>{displayedRows.map((row) => (
                  <tr key={`${row.protocol}-${row.port}-${row.pid}`}>
                    <td>{row.port} / {row.protocol}</td>
                    <td>{row.endpoints.map((endpoint) => (
                      <div key={`${endpoint.address}-${endpoint.remote}-${endpoint.state}`}>
                        {endpoint.address}（{endpoint.address.includes(":") ? "IPv6" : "IPv4"}）
                      </div>
                    ))}</td>
                    <td>{row.endpoints.map((endpoint) => <div key={`${endpoint.address}-${endpoint.remote}-${endpoint.state}`}>{endpoint.remote || "—"}</div>)}</td>
                    <td>{row.endpoints.map((endpoint) => <div key={`${endpoint.address}-${endpoint.remote}-${endpoint.state}`}>{endpoint.state}</div>)}</td>
                    <td>
                      <strong>{row.name}</strong> / {row.pid}<small>工作目录：{row.workingDirectory || "无法读取，见详情"}</small>
                    </td>
                    <td>
                      <div className="ui-actions">
                        <button className="ui-button" type="button" onClick={() => setDetail(row)}
                          aria-label={`查看 ${row.name} 详情，PID ${row.pid}，端口 ${row.port}`}>详情</button>
                        <button className="ui-button" type="button" onClick={() => askStop(row)}
                          disabled={busy || !!row.blockedReason || !row.startedAt}
                          aria-label={`停止 ${row.name}，PID ${row.pid}，端口 ${row.port}`}>停止进程</button>
                      </div>
                      {row.blockedReason && <small>{row.blockedReason}</small>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
      <dialog ref={dialog} className="ui-dialog ports-dialog" aria-labelledby="ports-detail-title"
        onClose={() => setDetail(null)}
        onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
        {detail && (
          <>
            <h2 id="ports-detail-title">{detail.name}（PID {detail.pid}）· {detail.port} / {detail.protocol}</h2>
            <dl>
              <dt>工作目录（当前）<CopyButton field="cwd" value={detail.workingDirectory} copied={copied} onCopy={copy} /></dt>
              <dd>{detail.workingDirectory || detail.workingDirectoryError || "无法读取（权限不足或进程已退出）"}</dd>
              <dt>启动命令<CopyButton field="command" value={detail.commandLine} copied={copied} onCopy={copy} /></dt>
              <dd><code>{detail.commandLine || "无法读取（权限不足或进程已变化）"}</code></dd>
              <dt>程序路径<CopyButton field="path" value={detail.path} copied={copied} onCopy={copy} /></dt>
              <dd>{detail.path || "无法读取"}</dd>
              <dt>启动时间</dt><dd>{detail.startedAtDisplay ? new Date(detail.startedAtDisplay).toLocaleString() : "无法读取"}</dd>
              <dt>父进程</dt><dd>{detail.parentPid === null ? "无法读取" : `${detail.parentName || "名称不可用（可能已退出）"} / PID ${detail.parentPid}`}</dd>
              <dt>关联 Windows 服务</dt>
              <dd>{detail.platform === "macos" ? "不适用（macOS）" : detail.services === null ? "无法读取（权限不足或进程已变化）" : detail.services.length === 0 ? "无关联服务" : (
                <ul>{detail.services.map((service) => <li key={service.name}>{service.displayName}（{service.name}）— {service.state}</li>)}</ul>
              )}</dd>
            </dl>
            {detail.detailsWarnings.map((warning) => <p className="ui-feedback ui-feedback--error" key={warning}>{warning}</p>)}
            <div className="ui-actions ports-dialog-actions">
              <button className="ui-button" type="button" onClick={() => askStop(detail)}
                disabled={busy || !!detail.blockedReason || !detail.startedAt}>停止进程</button>
              <button className="ui-button" type="button" onClick={() => dialog.current?.close()}>关闭</button>
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
