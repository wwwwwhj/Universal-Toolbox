import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./ports.css";

interface PortOwner {
  protocol: string;
  address: string;
  port: number;
  pid: number;
  state: string;
  name: string;
  path: string | null;
  startedAt: string | null;
  blockedReason: string | null;
}

export default function PortsPage() {
  const [port, setPort] = useState("");
  const [rows, setRows] = useState<PortOwner[]>([]);
  const [queriedPort, setQueriedPort] = useState<number | null>(null);
  const [hasQueried, setHasQueried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<PortOwner | null>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const desktop = isTauri();

  useEffect(() => {
    // 从长列表选择进程时，把确认信息带入视野和键盘焦点。
    if (selected) confirmation.current?.focus();
  }, [selected]);

  async function refresh(value: number | null) {
    const result = await invoke<PortOwner[]>("list_port_owners", { port: value });
    setRows(result);
    setQueriedPort(value);
    setHasQueried(true);
  }

  async function search() {
    const value = port.trim() === "" ? null : Number(port);
    if (value !== null && (!/^\d+$/.test(port) || value < 1 || value > 65535)) {
      setError("请输入 1–65535 之间的整数端口，或留空查询全部。");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    setSelected(null);
    // 新查询失败时不保留旧列表，避免把旧结果误认为当前端口的占用。
    setRows([]);
    setHasQueried(false);
    try { await refresh(value); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
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
      // 停止成功与刷新失败分别反馈，避免误导用户再次停止同一个 PID。
      setRows([]);
      setHasQueried(false);
      try { await refresh(queriedPort); }
      catch (error) { setError(`进程已停止，但刷新失败：${String(error)}`); }
    } catch (error) {
      setError(String(error));
      setSelected(null);
    } finally { setBusy(false); }
  }

  return (
    <section className="ports-page">
      <h1>端口管理</h1>
      <p>查询 Windows 本地 TCP/UDP 端口占用，停止占用端口的进程。</p>
      {!desktop && <p role="status">请在 Tauri 桌面应用中使用此功能，浏览器无法查询或停止本机进程。</p>}
      <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label htmlFor="port-number">端口号</label>
        <input id="port-number" type="text" inputMode="numeric" placeholder="例如 1420，留空查询全部"
          value={port} onChange={(event) => setPort(event.target.value)} disabled={busy || !desktop} />
        <button type="submit" disabled={busy || !desktop}>{busy ? "处理中…" : "查询 / 刷新"}</button>
      </form>
      {error && <p className="ports-error" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {selected && (
        <div ref={confirmation} tabIndex={-1} className="ports-confirm" role="group" aria-label="确认停止进程">
          <h2>停止 {selected.name}（PID {selected.pid}）？</h2>
          <p>端口：{selected.port} / {selected.protocol}；路径：{selected.path || "无法读取"}</p>
          <p>这会强制结束整个进程，影响它的所有端口，未保存的数据可能丢失。若有守护程序，进程可能自动重启。</p>
          <button type="button" className="ports-danger" onClick={() => void stop()} disabled={busy}>确认停止</button>
          <button type="button" onClick={() => setSelected(null)} disabled={busy}>取消</button>
        </div>
      )}
      {hasQueried && (
        <>
          <p role="status">{queriedPort === null ? "全部端口" : `端口 ${queriedPort}`}：{rows.length} 条占用记录</p>
          {rows.length === 0 ? <p>未发现有进程占用。此结果不包含无所属进程的 TIME_WAIT 记录或系统保留端口。</p> : (
            <div className="ports-table-wrap">
              <table>
                <thead><tr><th>端口 / 协议</th><th>本地地址</th><th>状态</th><th>进程 / PID</th><th>操作</th></tr></thead>
                <tbody>{rows.map((row) => (
                  <tr key={`${row.protocol}-${row.address}-${row.port}-${row.pid}-${row.state}`}>
                    <td>{row.port} / {row.protocol}</td>
                    <td>{row.address}</td><td>{row.state}</td>
                    <td><strong>{row.name}</strong> / {row.pid}<small>{row.path || "路径不可用"}</small></td>
                    <td>
                      <button type="button" onClick={() => { setSelected(row); setError(""); setMessage(""); }}
                        disabled={busy || !!row.blockedReason || !row.startedAt}
                        aria-label={`停止 ${row.name}，PID ${row.pid}，端口 ${row.port}`}>停止进程</button>
                      {row.blockedReason && <small>{row.blockedReason}</small>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
