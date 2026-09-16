import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { cacheSettings, type CustomCacheTarget } from "./settings";
import "./cache.css";

// 后端内置目标的探测/修改方式说明，只用于设置页展示。
interface CacheTargetInfo {
  id: string;
  name: string;
  category: string;
  getCommands: string[];
  setCommand: string | null;
  relocateGuide: string | null;
}

interface Draft {
  id: string;
  name: string;
  getCommand: string;
  setCommand: string;
  dirsText: string;
}

export default function CacheSettings() {
  const settings = cacheSettings.use();
  const persistError = cacheSettings.usePersistError();
  const [infos, setInfos] = useState<CacheTargetInfo[]>([]);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dialogError, setDialogError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const desktop = isTauri();
  const hidden = new Set(settings.hiddenIds);
  const editingExisting = draft !== null && settings.customTargets.some((target) => target.id === draft.id);

  useEffect(() => {
    if (!desktop) return;
    invoke<CacheTargetInfo[]>("list_cache_targets")
      .then(setInfos)
      .catch((error) => setLoadError(String(error)));
  }, [desktop]);

  useEffect(() => {
    if (draft && !dialog.current?.open) dialog.current?.showModal();
    if (!draft && dialog.current?.open) dialog.current.close();
  }, [draft]);

  function openEditor(target?: CustomCacheTarget) {
    setDraft(
      target
        ? { ...target, dirsText: target.dirs.join("\n") }
        : { id: `custom-${Date.now().toString(36)}`, name: "", getCommand: "", setCommand: "", dirsText: "" },
    );
    setDialogError("");
  }

  function saveDraft() {
    if (!draft) return;
    const name = draft.name.trim();
    const getCommand = draft.getCommand.trim();
    const setCommand = draft.setCommand.trim();
    const dirs = draft.dirsText.split("\n").map((line) => line.trim()).filter(Boolean);
    if (name === "") {
      setDialogError("请输入工具名称。");
      return;
    }
    if (getCommand === "" && dirs.length === 0) {
      setDialogError("请填写获取路径命令，或至少一个固定目录。");
      return;
    }
    const target: CustomCacheTarget = { id: draft.id, name, getCommand, setCommand, dirs };
    cacheSettings.update({
      customTargets: editingExisting
        ? settings.customTargets.map((item) => (item.id === target.id ? target : item))
        : [...settings.customTargets, target],
    });
    setDraft(null);
  }

  return (
    <>
      <p>各工具缓存目录的获取与修改方式。移除内置目标后扫描和列表都不再包含它；自定义目标按同样规则参与扫描。</p>
      {persistError && (
        <p className="ui-feedback ui-feedback--error" role="alert">
          修改已生效，但无法保存到本机存储，重启后将丢失：{persistError}
        </p>
      )}
      {loadError && <p className="ui-feedback ui-feedback--error" role="alert">无法读取内置目标列表：{loadError}</p>}
      {!desktop && (
        <p className="ui-feedback" role="status">
          浏览器预览无法读取内置目标的命令列表；自定义条目仍会保存，并在桌面应用中参与扫描。
        </p>
      )}
      <div className="ui-table-wrap" tabIndex={0} role="region" aria-label="缓存目标的获取与修改命令，可横向滚动">
        <table className="ui-table cache-targets">
          <thead>
            <tr><th>工具</th><th>获取路径</th><th>修改路径</th><th>操作</th></tr>
          </thead>
          <tbody>
            {infos.map((info) => {
              const isHidden = hidden.has(info.id);
              return (
                <tr key={info.id} className={isHidden ? "is-hidden" : undefined}>
                  <td><strong>{info.name}</strong><small>{info.category}</small></td>
                  <td>{info.getCommands.map((command) => <code key={command} className="cache-command">{command}</code>)}</td>
                  <td>
                    {info.setCommand
                      ? <code className="cache-command">{info.setCommand}</code>
                      : info.relocateGuide ? <small>{info.relocateGuide}</small> : "—"}
                  </td>
                  <td>
                    {isHidden ? (
                      <button className="ui-button" type="button"
                        onClick={() => cacheSettings.update({ hiddenIds: settings.hiddenIds.filter((id) => id !== info.id) })}>
                        恢复
                      </button>
                    ) : (
                      <button className="ui-button" type="button" aria-label={`从扫描中移除 ${info.name}`}
                        onClick={() => cacheSettings.update({ hiddenIds: [...settings.hiddenIds, info.id] })}>
                        移除
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {settings.customTargets.map((target) => (
              <tr key={target.id}>
                <td><strong>{target.name}</strong><small>自定义</small></td>
                <td>
                  {target.getCommand && <code className="cache-command">{target.getCommand}</code>}
                  {target.dirs.map((dir) => <code key={dir} className="cache-command">{dir}</code>)}
                </td>
                <td>{target.setCommand ? <code className="cache-command">{target.setCommand}</code> : "—"}</td>
                <td>
                  <div className="ui-actions">
                    <button className="ui-button" type="button" onClick={() => openEditor(target)}>编辑</button>
                    <button className="ui-button" type="button" aria-label={`删除自定义目标 ${target.name}`}
                      onClick={() => cacheSettings.update({ customTargets: settings.customTargets.filter((item) => item.id !== target.id) })}>
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ui-actions">
        <button className="ui-button" type="button" onClick={() => openEditor()}>添加自定义目标</button>
        <button className="ui-button" type="button" onClick={() => cacheSettings.reset()}>恢复默认</button>
      </div>
      <dialog ref={dialog} className="ui-dialog cache-dialog" aria-labelledby="cache-custom-title"
        onClose={() => { setDraft(null); setDialogError(""); }}
        onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
        {draft && (
          <>
            <h2 id="cache-custom-title">{editingExisting ? "编辑自定义目标" : "添加自定义目标"}</h2>
            <form onSubmit={(event) => { event.preventDefault(); saveDraft(); }}>
              <div className="ui-field">
                <label htmlFor="cache-custom-name">工具名称</label>
                <input className="ui-input" id="cache-custom-name" type="text" autoFocus
                  value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </div>
              <div className="ui-field">
                <label htmlFor="cache-custom-get">获取路径命令（可选）</label>
                <input className="ui-input" id="cache-custom-get" type="text" placeholder="例如 my-tool cache dir"
                  value={draft.getCommand} onChange={(event) => setDraft({ ...draft, getCommand: event.target.value })} />
                <small>执行该命令，取输出中最后一行绝对路径作为缓存目录；含空格的部分用双引号包裹。</small>
              </div>
              <div className="ui-field">
                <label htmlFor="cache-custom-set">修改路径命令（可选）</label>
                <input className="ui-input" id="cache-custom-set" type="text"
                  placeholder="例如 my-tool config set cache {path}"
                  value={draft.setCommand} onChange={(event) => setDraft({ ...draft, setCommand: event.target.value })} />
                <small>{"{path} 会被替换为新目录；不写占位符时在命令末尾追加路径。含空格的部分用双引号包裹。"}</small>
              </div>
              <div className="ui-field">
                <label htmlFor="cache-custom-dirs">固定目录（可选，每行一个绝对路径）</label>
                <textarea className="ui-input" id="cache-custom-dirs" rows={3}
                  value={draft.dirsText} onChange={(event) => setDraft({ ...draft, dirsText: event.target.value })} />
              </div>
              {dialogError && <p className="ui-feedback ui-feedback--error" role="alert">{dialogError}</p>}
              <div className="ui-actions cache-dialog-actions">
                <button type="submit" className="ui-button ui-button--primary">保存</button>
                <button type="button" className="ui-button" onClick={() => dialog.current?.close()}>取消</button>
              </div>
            </form>
          </>
        )}
      </dialog>
    </>
  );
}
