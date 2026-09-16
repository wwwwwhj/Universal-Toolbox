import { useEffect, useRef, useState } from "react";
import { SegmentedField } from "../../shared/SegmentedField";
import { BUILTIN_CATEGORIES, type CategoryKind } from "./content";
import { removeCategory, saveBuiltinExtras, saveCategory, setCategoryEnabled, typingLibrary, useCategories } from "./library";

interface Draft {
  id: string | null;
  name: string;
  kind: CategoryKind;
  text: string;
}

export default function LibraryDialog(props: { open: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const categories = useCategories();
  // 词库存储有自己的持久化错误通道，与打字偏好分开订阅。
  const libError = typingLibrary.usePersistError();
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [extrasText, setExtrasText] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteTimer = useRef(0);

  useEffect(() => {
    if (props.open && !dialog.current?.open) dialog.current?.showModal();
    if (!props.open && dialog.current?.open) dialog.current.close();
  }, [props.open]);

  useEffect(() => () => window.clearTimeout(deleteTimer.current), []);

  const selected = categories.find((category) => category.id === selId) ?? null;
  // 内置类目预览只展示固定部分；补充条目在下方单独编辑。
  const builtinBase =
    selected?.builtin
      ? (BUILTIN_CATEGORIES.find((category) => category.id === selected.id)?.entries ?? [])
      : [];

  function select(id: string) {
    const category = categories.find((item) => item.id === id);
    if (!category) return;
    setSelId(id);
    setError("");
    setSaved(false);
    setConfirmDelete(false);
    setExtrasText(category.builtin ? category.extras.join("\n") : null);
    setDraft(
      category.builtin
        ? null
        : { id: category.id, name: category.name, kind: category.kind, text: category.entries.join("\n") },
    );
  }

  function startNew() {
    setSelId(null);
    setError("");
    setSaved(false);
    setConfirmDelete(false);
    setExtrasText(null);
    setDraft({ id: null, name: "", kind: "word", text: "" });
  }

  function save() {
    if (!draft) return;
    const entries = draft.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (draft.name.trim() === "") {
      setError("请输入类目名称。");
      return;
    }
    if (entries.length === 0) {
      setError("请至少添加一条内容，每行一条。");
      return;
    }
    if (draft.kind === "word") {
      const invalid = entries.find((entry) => /\s/.test(entry));
      if (invalid) {
        setError(`单词条目不能包含空白字符：「${invalid}」。多词内容请建句子类目。`);
        return;
      }
    }
    const id = saveCategory({ id: draft.id ?? undefined, name: draft.name, kind: draft.kind, entries });
    setSelId(id);
    setDraft({ ...draft, id, name: draft.name.trim(), text: entries.join("\n") });
    setConfirmDelete(false);
    setError("");
  }

  function remove() {
    if (!draft?.id) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      window.clearTimeout(deleteTimer.current);
      deleteTimer.current = window.setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    removeCategory(draft.id);
    setDraft(null);
    setSelId(null);
    setConfirmDelete(false);
  }

  function saveExtras() {
    if (!selected?.builtin || extrasText === null) return;
    const entries = [...new Set(extrasText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    if (selected.kind === "word") {
      const invalid = entries.find((entry) => /\s/.test(entry));
      if (invalid) {
        setError(`单词条目不能包含空白字符：「${invalid}」。`);
        setSaved(false);
        return;
      }
    }
    setError("");
    saveBuiltinExtras(selected.id, entries);
    setExtrasText(entries.join("\n"));
    setSaved(true);
  }

  return (
    <dialog
      ref={dialog}
      className="ui-dialog typing-lib-dialog"
      aria-labelledby="typing-lib-title"
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current.close();
      }}
    >
      <h2 id="typing-lib-title">词库管理</h2>
      <p>勾选启用参与出题的类目；内置类目可追加补充条目，自定义类目可整体编辑（每行一条）。</p>
      {libError && (
        <p className="ui-feedback ui-feedback--error" role="alert">
          词库修改已生效，但无法保存到本机存储，重启后将丢失：{libError}
        </p>
      )}
      <div className="typing-lib">
        <div className="typing-lib-list">
          <div className="ui-actions">
            <button type="button" className="ui-button" onClick={startNew}>
              新建类目
            </button>
          </div>
          <ul className="typing-lib-cats">
            {categories.map((category) => (
              <li key={category.id}>
                <input
                  type="checkbox"
                  checked={category.enabled}
                  aria-label={`启用 ${category.name}`}
                  onChange={(event) => setCategoryEnabled(category, event.target.checked)}
                />
                <button
                  type="button"
                  className="typing-lib-cat"
                  aria-current={selId === category.id || (!category.builtin && draft?.id === category.id)}
                  onClick={() => select(category.id)}
                >
                  {category.name}
                  <small>
                    {category.builtin ? "内置" : "自定义"} · {category.kind === "word" ? "单词" : "句子"} · {category.entries.length} 条
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="typing-lib-editor">
          {draft ? (
            <>
              <div className="ui-field">
                <label htmlFor="typing-lib-name">类目名称</label>
                <input
                  className="ui-input"
                  id="typing-lib-name"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </div>
              <SegmentedField
                id="typing-lib-kind"
                label="类型"
                value={draft.kind}
                options={[
                  { value: "word", label: "单词" },
                  { value: "sentence", label: "句子" },
                ]}
                onChange={(kind) => setDraft({ ...draft, kind })}
              />
              <div className="ui-field">
                <label htmlFor="typing-lib-entries">条目（每行一条）</label>
                <textarea
                  className="ui-input typing-lib-text"
                  id="typing-lib-entries"
                  rows={9}
                  value={draft.text}
                  onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                />
              </div>
              {error && (
                <p className="ui-feedback ui-feedback--error" role="alert">
                  {error}
                </p>
              )}
              <div className="ui-actions">
                <button type="button" className="ui-button ui-button--primary" onClick={save}>
                  {draft.id ? "保存修改" : "创建类目"}
                </button>
                {draft.id && (
                  <button type="button" className="ui-button ui-button--danger" onClick={remove}>
                    {confirmDelete ? "确认删除该类目" : "删除"}
                  </button>
                )}
              </div>
            </>
          ) : selected?.builtin ? (
            <>
              <h3>
                {selected.name}{" "}
                <small>
                  内置 · {selected.kind === "word" ? "单词" : "句子"} · {selected.entries.length} 条
                  {selected.extras.length > 0 ? `（含补充 ${selected.extras.length}）` : ""} ·{" "}
                  {selected.enabled ? "已启用" : "已停用"}
                </small>
              </h3>
              <p className="typing-lib-preview">
                {builtinBase.slice(0, 24).join(" · ")}
                {builtinBase.length > 24 ? " …" : ""}
              </p>
              <div className="ui-field">
                <label htmlFor="typing-lib-extras">补充条目（每行一条，随内置内容一起出题）</label>
                <textarea
                  className="ui-input typing-lib-text typing-lib-extras"
                  id="typing-lib-extras"
                  rows={6}
                  value={extrasText ?? ""}
                  onChange={(event) => {
                    setExtrasText(event.target.value);
                    setSaved(false);
                  }}
                />
              </div>
              {error && (
                <p className="ui-feedback ui-feedback--error" role="alert">
                  {error}
                </p>
              )}
              {saved && !libError && (
                <p className="ui-feedback ui-feedback--success" role="status">
                  已保存补充条目。
                </p>
              )}
              <div className="ui-actions">
                <button type="button" className="ui-button ui-button--primary" onClick={saveExtras}>
                  保存补充
                </button>
              </div>
            </>
          ) : (
            <p>从左侧选择一个类目查看内容，或新建自定义类目。</p>
          )}
        </div>
      </div>
      <div className="ui-actions typing-lib-actions">
        <button type="button" className="ui-button" onClick={() => dialog.current?.close()}>
          关闭
        </button>
      </div>
    </dialog>
  );
}
