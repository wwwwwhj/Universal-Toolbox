import { useEffect, useRef, useState, type CSSProperties } from "react";

// 虚拟键盘：展示物理按键的按下状态、对错闪烁，并按需高亮下一个待按按键。
// 只做视觉反馈（aria-hidden），真正的输入处理在页面层。
interface KeyDef {
  id: string;
  label: string;
  u: number;
}

const key = (id: string, label = id, u = 1): KeyDef => ({ id, label, u });
const letter = (ch: string): KeyDef => key(ch, ch.toUpperCase());

const KEY_ROWS: readonly KeyDef[][] = [
  [key("`"), ..."1234567890".split("").map((d) => key(d)), key("-"), key("="), key("Backspace", "⌫", 2)],
  [key("Tab", "Tab", 1.5), ..."qwertyuiop".split("").map(letter), key("["), key("]"), key("\\", "\\", 1.5)],
  [key("Caps", "Caps", 1.8), ..."asdfghjkl".split("").map(letter), key(";"), key("'"), key("Enter", "Enter", 2.2)],
  [key("ShiftL", "Shift", 2.4), ..."zxcvbnm".split("").map(letter), key(","), key("."), key("/"), key("ShiftR", "Shift", 2.6)],
  [key("Space", "", 8)],
];

// KeyboardEvent.code → 键盘上的键位 id，物理布局无关。
const CODE_TO_KEY: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Space: "Space",
  Backspace: "Backspace", Tab: "Tab", CapsLock: "Caps", Enter: "Enter", NumpadEnter: "Enter",
  ShiftLeft: "ShiftL", ShiftRight: "ShiftR",
};
for (const ch of "abcdefghijklmnopqrstuvwxyz") CODE_TO_KEY[`Key${ch.toUpperCase()}`] = ch;
for (const d of "0123456789") {
  CODE_TO_KEY[`Digit${d}`] = d;
  CODE_TO_KEY[`Numpad${d}`] = d;
}

// 需要 Shift 才能输入的符号 → 所在基础键。
const SHIFT_BASE: Record<string, string> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
  "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\",
  ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
};
const BASE_KEYS = new Set("`1234567890-=[]\\;',./abcdefghijklmnopqrstuvwxyz");
// 左手负责的键；提示 Shift 时点亮对侧的那只。
const LEFT_HAND = new Set("`12345qwertasdfgzxcvb");

export function keyIdForChar(ch: string): string | null {
  if (ch === " ") return "Space";
  const lower = ch.toLowerCase();
  if (BASE_KEYS.has(lower)) return lower;
  return SHIFT_BASE[ch] ?? null;
}

export function shiftSideForChar(ch: string): "ShiftL" | "ShiftR" | null {
  const shifted = (ch >= "A" && ch <= "Z") || ch in SHIFT_BASE;
  if (!shifted) return null;
  const base = ch >= "A" && ch <= "Z" ? ch.toLowerCase() : SHIFT_BASE[ch];
  return LEFT_HAND.has(base) ? "ShiftR" : "ShiftL";
}

export interface KeyFlash {
  code: string;
  ok: boolean;
  seq: number;
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

export default function TypingKeyboard(props: { nextChar: string | null; flash: KeyFlash | null; width: number }) {
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const keyEls = useRef(new Map<string, HTMLElement>());

  // 物理按键的按住状态；弹窗打开或在输入框中打字时不响应。
  useEffect(() => {
    function onDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target) || document.querySelector("dialog[open]")) return;
      const id = CODE_TO_KEY[event.code];
      if (!id) return;
      setHeld((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    }
    function onUp(event: KeyboardEvent) {
      const id = CODE_TO_KEY[event.code];
      if (!id) return;
      setHeld((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
    function clear() {
      setHeld((prev) => (prev.size ? new Set() : prev));
    }
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // 对错闪烁：移除再加回 class 以重启动画。
  useEffect(() => {
    if (!props.flash) return;
    const id = CODE_TO_KEY[props.flash.code];
    const el = id ? keyEls.current.get(id) : undefined;
    if (!el) return;
    el.classList.remove("typing-key--ok", "typing-key--err");
    void el.offsetWidth;
    el.classList.add(props.flash.ok ? "typing-key--ok" : "typing-key--err");
  }, [props.flash]);

  const nextId = props.nextChar ? keyIdForChar(props.nextChar) : null;
  const shiftId = props.nextChar ? shiftSideForChar(props.nextChar) : null;

  return (
    <div
      className="typing-keyboard"
      aria-hidden="true"
      style={{ maxWidth: props.width, "--kb-scale": (props.width / 720).toFixed(3) } as CSSProperties}
    >
      {KEY_ROWS.map((row, index) => (
        <div className="typing-key-row" key={index}>
          {row.map((def) => (
            <span
              key={def.id}
              ref={(el) => {
                if (el) keyEls.current.set(def.id, el);
                else keyEls.current.delete(def.id);
              }}
              className={
                "typing-key" +
                (held.has(def.id) ? " typing-key--held" : "") +
                (def.id === nextId || def.id === shiftId ? " typing-key--next" : "")
              }
              style={{ "--u": String(def.u) } as CSSProperties}
            >
              {def.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
