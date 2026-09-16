import { SegmentedField } from "../../shared/SegmentedField";
import { portsSettings, REFRESH_OPTIONS } from "./settings";
import "./ports.css";

export default function PortsSettings() {
  const settings = portsSettings.use();
  const persistError = portsSettings.usePersistError();
  return (
    <>
      <p>端口管理页的排序、状态筛选和自动刷新行为，修改立即生效并记住。</p>
      {persistError && (
        <p className="ui-feedback ui-feedback--error" role="alert">
          修改已生效，但无法保存到本机存储，重启后将丢失：{persistError}
        </p>
      )}
      <SegmentedField
        id="ports-sort"
        label="列表排序"
        value={settings.sortKey}
        options={[
          { value: "port", label: "按端口" },
          { value: "name", label: "按进程名" },
        ]}
        onChange={(sortKey) => portsSettings.update({ sortKey })}
      />
      <SegmentedField
        id="ports-sort-dir"
        label="排序方向"
        value={settings.sortAsc ? "asc" : "desc"}
        options={[
          { value: "asc", label: "升序" },
          { value: "desc", label: "降序" },
        ]}
        onChange={(value) => portsSettings.update({ sortAsc: value === "asc" })}
      />
      <SegmentedField
        id="ports-filter"
        label="状态筛选"
        value={settings.listenOnly ? "listen" : "all"}
        options={[
          { value: "all", label: "全部" },
          { value: "listen", label: "仅监听" },
        ]}
        onChange={(value) => portsSettings.update({ listenOnly: value === "listen" })}
      />
      <SegmentedField
        id="ports-refresh"
        label="自动刷新间隔"
        value={String(settings.refreshSeconds)}
        options={REFRESH_OPTIONS.map((seconds) => ({ value: String(seconds), label: `${seconds} 秒` }))}
        onChange={(value) => portsSettings.update({ refreshSeconds: Number(value) })}
      />
      <div className="ui-field">
        <label className="ports-autorefresh">
          <input
            type="checkbox"
            checked={settings.autoRefresh}
            onChange={(event) => portsSettings.update({ autoRefresh: event.target.checked })}
          />
          查询后自动刷新
        </label>
      </div>
      <div className="ui-actions">
        <button className="ui-button" type="button" onClick={() => portsSettings.reset()}>
          恢复默认
        </button>
      </div>
    </>
  );
}
