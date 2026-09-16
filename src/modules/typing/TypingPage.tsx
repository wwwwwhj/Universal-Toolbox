import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BookOpenText, RotateCcw } from "lucide-react";
import { SegmentedField } from "../../shared/SegmentedField";
import TypingKeyboard, { type KeyFlash } from "./Keyboard";
import LibraryDialog from "./LibraryDialog";
import { setCategoryEnabled, usableEntries, useCategories, type TypingCategory } from "./library";
import { typingSettings, WORD_SECONDS_OPTIONS } from "./settings";
import "./typing.css";

type CharStatus = "pending" | "correct" | "error";

interface Particle {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

function pickUnit(categories: TypingCategory[]): string {
  const pool = categories.flatMap((category) => usableEntries(category));
  return pool.length === 0 ? "" : pool[Math.floor(Math.random() * pool.length)];
}

const pendingArray = (length: number) => Array.from({ length }, (): CharStatus => "pending");

// 只把真正的文本输入视为可编辑目标；复选框、单选、滑杆等控件仍属于打字页的一部分。
const TEXT_INPUT_TYPES = new Set([
  "text", "search", "number", "email", "url", "password", "tel",
  "date", "time", "datetime-local", "month", "week",
]);

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

// 点击或勾选后让控件失焦：本页键盘输入优先于控件激活，避免空格、Enter、Backspace 被焦点控件吃掉。
function blurActiveControl() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

export default function TypingPage() {
  const settings = typingSettings.use();
  const persistError = typingSettings.usePersistError();
  const categories = useCategories();
  const isWords = settings.mode === "words";
  const kind = isWords ? "word" : "sentence";
  const modeCats = categories.filter((category) => category.kind === kind);
  const activeCats = modeCats.filter((category) => category.enabled);
  const catsKey = activeCats.map((category) => category.id).join(",");
  // 句子模式一轮就是一句，不套用时限；单词模式 0 表示不限时。
  const limit = isWords ? settings.wordSeconds : 0;

  const [target, setTarget] = useState("");
  const [nextWord, setNextWord] = useState("");
  const [statuses, setStatuses] = useState<CharStatus[]>([]);
  const [pos, setPos] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);
  const [correct, setCorrect] = useState(0);
  const [errors, setErrors] = useState(0);
  const [wordsDone, setWordsDone] = useState(0);
  const [flash, setFlash] = useState<KeyFlash | null>(null);
  const [heat, setHeat] = useState(0);
  const [now, setNow] = useState(0);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const promptRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  // 最近 3 秒内的正确击键时间戳，用于估算实时速度（热度 0–1）。
  const strokes = useRef<number[]>([]);
  const flashSeq = useRef(0);
  const particleSeq = useRef(0);

  const done = doneAt !== null;
  const running = startedAt !== null && !done;

  function reset() {
    const text = pickUnit(activeCats);
    setTarget(text);
    setStatuses(pendingArray(text.length));
    setNextWord(isWords && text !== "" ? pickUnit(activeCats) : "");
    setPos(0);
    setStartedAt(null);
    setDoneAt(null);
    setCorrect(0);
    setErrors(0);
    setWordsDone(0);
    setParticles([]);
    strokes.current = [];
  }

  // 模式、时长或启用的类目集合变化时重新出题；类目内容本身的修改不打断当前轮次。
  // 用 layout effect 在首帧绘制前出题，避免先闪一次空状态。
  useLayoutEffect(() => {
    reset();
  }, [settings.mode, settings.wordSeconds, catsKey]);

  // 空题面下词库出现可用内容（如修正无效条目、重新启用）时自动出题恢复。
  const hasUsable = activeCats.some((category) => usableEntries(category).length > 0);
  useLayoutEffect(() => {
    if (!done && target === "" && hasUsable) reset();
  }, [done, target, hasUsable]);

  // 输入挂在 window 上：页面可见即可直接打字；输入框、弹窗与按钮上的按键不拦截。
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (document.querySelector("dialog[open]")) return;
    if (isEditableTarget(event.target)) return;
    const onControl = event.target instanceof HTMLElement && event.target.closest("button, a, summary, input, select");
    if (onControl && (event.key === " " || event.key === "Enter" || event.key === "Backspace")) return;

    if (event.key === "Backspace") {
      event.preventDefault();
      // 单词模式结束后不回改上一词；句子模式可退回继续。
      if (done) {
        if (isWords) return;
        setDoneAt(null);
      }
      if (pos > 0) {
        setStatuses((prev) => {
          const next = prev.slice();
          next[pos - 1] = "pending";
          return next;
        });
        setPos(pos - 1);
      }
      return;
    }
    if (event.key === "Enter") {
      if (done || target === "") {
        event.preventDefault();
        reset();
      }
      return;
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    // 空题面（全部类目停用或条目均不可用）不接收输入，也不计入统计。
    if (done || target === "") return;
    // 与定时器同一判定：超过限时立即结束，避免 200ms 轮询间隙内的击键被计入成绩。
    if (limit > 0 && startedAt !== null && performance.now() - startedAt >= limit * 1000) {
      setDoneAt(startedAt + limit * 1000);
      return;
    }

    if (isWords) {
      if (event.key === " ") {
        // 词未打完空格不生效；打完即可进入下一词，允许带错误前进。
        if (pos < target.length) {
          setErrors((prev) => prev + 1);
          setFlash({ code: event.code, ok: false, seq: ++flashSeq.current });
          return;
        }
        setCorrect((prev) => prev + 1);
        setWordsDone((prev) => prev + 1);
        strokes.current.push(performance.now());
        const word = nextWord || pickUnit(activeCats);
        setTarget(word);
        setStatuses(pendingArray(word.length));
        setPos(0);
        setNextWord(pickUnit(activeCats));
        setFlash({ code: event.code, ok: true, seq: ++flashSeq.current });
        return;
      }
      if (pos >= target.length) {
        // 词尾之后的额外字母忽略，只给错误闪烁提示。
        setErrors((prev) => prev + 1);
        setFlash({ code: event.code, ok: false, seq: ++flashSeq.current });
        return;
      }
    }
    typeChar(event.key, event.code);
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // 实时速度与计时：只在输入进行中刷新时钟，热度按最近 3 秒的击键密度衰减；到时自动结束。
  const sessionRef = useRef({ running: false, startedAt: 0, limit: 0 });
  sessionRef.current = { running, startedAt: startedAt ?? 0, limit };
  useEffect(() => {
    const timer = window.setInterval(() => {
      const cutoff = performance.now() - 3000;
      const list = strokes.current;
      while (list.length > 0 && list[0] <= cutoff) list.shift();
      const next = Math.min(1, (list.length / 5) * 20 / 100);
      setHeat((prev) => (Math.abs(prev - next) > 0.02 ? next : prev));
      const session = sessionRef.current;
      if (session.running) {
        const t = performance.now();
        setNow(t);
        if (session.limit > 0 && t - session.startedAt >= session.limit * 1000) {
          setDoneAt(session.startedAt + session.limit * 1000);
        }
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  // 光标跟随当前字符平滑移动；当前单元打完时停在最后一个字符右缘。
  const placeCaret = useCallback(() => {
    const caret = caretRef.current;
    const prompt = promptRef.current;
    if (!caret || !prompt) return;
    const el = prompt.querySelector<HTMLElement>(`[data-i="${Math.min(pos, target.length - 1)}"]`);
    if (!el) {
      caret.style.opacity = "0";
      return;
    }
    caret.style.opacity = "";
    const x = pos >= target.length ? el.offsetLeft + el.offsetWidth : el.offsetLeft;
    caret.style.transform = `translate(${x}px, ${el.offsetTop}px)`;
    caret.style.height = `${el.offsetHeight}px`;
  }, [pos, target]);

  useLayoutEffect(() => {
    placeCaret();
  }, [placeCaret]);

  // 窗口缩放等导致题面重排（单词重新居中、句子换行）时重新定位光标。
  useLayoutEffect(() => {
    const prompt = promptRef.current;
    if (!prompt) return;
    const observer = new ResizeObserver(placeCaret);
    observer.observe(prompt);
    return () => observer.disconnect();
  }, [placeCaret]);

  function typeChar(ch: string, code: string) {
    const ok = target[pos] === ch;
    const t = performance.now();
    setStartedAt((prev) => prev ?? t);
    setStatuses((prev) => {
      const next = prev.slice();
      next[pos] = ok ? "correct" : "error";
      return next;
    });
    setPos(pos + 1);
    if (ok) {
      setCorrect((prev) => prev + 1);
      strokes.current.push(t);
      if (settings.effect === "particles") spawnParticles();
    } else {
      setErrors((prev) => prev + 1);
    }
    setFlash({ code, ok, seq: ++flashSeq.current });
    if (!isWords && pos + 1 >= target.length) setDoneAt(t);
  }

  function spawnParticles() {
    const prompt = promptRef.current;
    const el = prompt?.querySelector<HTMLElement>(`[data-i="${pos}"]`);
    if (!el) return;
    const count = 1 + Math.round(heat * 4);
    const batch: Particle[] = [];
    for (let i = 0; i < count; i++) {
      batch.push({
        id: ++particleSeq.current,
        x: el.offsetLeft + el.offsetWidth / 2,
        y: el.offsetTop + el.offsetHeight / 2,
        dx: (Math.random() - 0.5) * 56,
        dy: -(14 + Math.random() * 34),
      });
    }
    setParticles((prev) => [...prev.slice(-(80 - count)), ...batch]);
  }

  // 句子按词与空格切分为 token：每个字符（含连续空格）都有自己的 span 和 data-i，
  // 保证显示数量与判题一致、光标不会落到不存在的元素上。
  const sentenceTokens = useMemo(() => {
    const list: { start: number; text: string; isSpace: boolean }[] = [];
    let i = 0;
    while (i < target.length) {
      if (target[i] === " ") {
        list.push({ start: i, text: " ", isSpace: true });
        i++;
      } else {
        let j = i;
        while (j < target.length && target[j] !== " ") j++;
        list.push({ start: i, text: target.slice(i, j), isSpace: false });
        i = j;
      }
    }
    return list;
  }, [target]);

  const elapsedSec = startedAt === null ? 0 : Math.max(0, ((doneAt ?? Math.max(now, startedAt)) - startedAt) / 1000);
  const total = correct + errors;
  const accuracy = total === 0 ? 100 : Math.round((correct / total) * 100);
  const wpm = elapsedSec >= 1 ? Math.round(correct / 5 / (elapsedSec / 60)) : 0;

  function renderChar(index: number, ch: string) {
    const status = statuses[index] ?? "pending";
    return (
      <span
        key={index}
        data-i={index}
        className={`typing-char typing-char--${status}${ch === " " ? " typing-char--space" : ""}`}
      >
        {ch === " " ? " " : ch}
      </span>
    );
  }

  return (
    <section
      className="typing-page"
      onMouseDown={(event) => {
        // 打字页优先保证键盘输入：鼠标点击控件不转移焦点（键盘 Tab 仍可聚焦操作），
        // 点击题面时主动释放已有焦点（Tab 聚焦过的按钮不会在打字时被空格/回车触发）。
        // 词库弹窗内的输入框除外，那里需要正常点击聚焦。
        if (event.target instanceof HTMLElement && event.target.closest("dialog")) return;
        event.preventDefault();
        blurActiveControl();
      }}
    >
      <h1>英文打字</h1>
      <p>对照文本直接输入即可开始计时，Backspace 可回改；词库类目支持自定义维护。</p>
      {persistError && (
        <p className="ui-feedback ui-feedback--error" role="alert">
          打字偏好未能保存到本机存储，重启后将恢复为上次保存的值：{persistError}
        </p>
      )}
      <div className="ui-toolbar">
        <SegmentedField
          id="typing-mode"
          label="模式"
          value={settings.mode}
          options={[
            { value: "words", label: "单词" },
            { value: "sentences", label: "句子" },
          ]}
          onChange={(mode) => {
            typingSettings.update({ mode });
            blurActiveControl();
          }}
        />
        {isWords && (
          <SegmentedField
            id="typing-limit"
            label="时长"
            value={String(settings.wordSeconds)}
            options={WORD_SECONDS_OPTIONS.map((seconds) => ({
              value: String(seconds),
              label: seconds === 0 ? "不限时" : `${seconds / 60} 分钟`,
            }))}
            onChange={(value) => {
              typingSettings.update({ wordSeconds: Number(value) });
              blurActiveControl();
            }}
          />
        )}
        <div className="ui-field">
          <span id="typing-cats-label">类目</span>
          <div className="ui-segmented" role="group" aria-labelledby="typing-cats-label">
            {modeCats.map((category) => (
              <label key={category.id}>
                <input
                  type="checkbox"
                  checked={category.enabled}
                  onChange={(event) => {
                    setCategoryEnabled(category, event.target.checked);
                    event.currentTarget.blur();
                  }}
                />
                {category.name}
              </label>
            ))}
          </div>
        </div>
        <button
          className="ui-button typing-btn"
          type="button"
          onClick={(event) => {
            event.currentTarget.blur();
            setLibraryOpen(true);
          }}
        >
          <BookOpenText size={14} aria-hidden="true" />
          词库管理
        </button>
        <button
          className="ui-button typing-btn"
          type="button"
          onClick={(event) => {
            event.currentTarget.blur();
            reset();
          }}
        >
          <RotateCcw size={14} aria-hidden="true" />
          换一组
        </button>
      </div>
      {target === "" ? (
        <div className="ui-empty">
          <div className="ui-empty-icon">
            <BookOpenText size={22} aria-hidden="true" />
          </div>
          <p>
            <strong>当前模式下没有启用的类目</strong>
          </p>
          <p>请在上方勾选，或新建自定义类目。</p>
          <div className="ui-actions">
            <button
              className="ui-button"
              type="button"
              onClick={(event) => {
                event.currentTarget.blur();
                setLibraryOpen(true);
              }}
            >
              打开词库管理
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`typing-surface typing-fx-${settings.effect}`}
          style={{ "--type-heat": heat.toFixed(2) } as CSSProperties}
        >
          <div className="typing-stats" role="status">
            <span>
              速度 <strong>{wpm}</strong> WPM
            </span>
            <span>
              正确率 <strong>{accuracy}%</strong>
            </span>
            {isWords ? (
              <>
                <span>
                  单词 <strong>{wordsDone}</strong>
                </span>
                <span>
                  {limit > 0 ? "剩余" : "用时"} <strong>{limit > 0 ? Math.max(0, Math.ceil(limit - elapsedSec)) : elapsedSec.toFixed(0)}</strong> 秒
                </span>
                {running && (
                  <button
                    type="button"
                    className="ui-button typing-end"
                    onClick={(event) => {
                      event.currentTarget.blur();
                      setDoneAt(performance.now());
                    }}
                  >
                    结束本轮
                  </button>
                )}
              </>
            ) : (
              <>
                <span>
                  进度 <strong>{pos}</strong>/{target.length}
                </span>
                <span>
                  用时 <strong>{elapsedSec.toFixed(0)}</strong> 秒
                </span>
              </>
            )}
          </div>
          <div className={`typing-prompt${isWords ? " typing-prompt--word" : ""}`} ref={promptRef} aria-label="待输入文本">
            <span className="typing-caret" ref={caretRef} aria-hidden="true" />
            {particles.map((particle) => (
              <span
                key={particle.id}
                className="typing-particle"
                aria-hidden="true"
                style={
                  {
                    left: particle.x,
                    top: particle.y,
                    "--dx": `${particle.dx}px`,
                    "--dy": `${particle.dy}px`,
                  } as CSSProperties
                }
                onAnimationEnd={() =>
                  setParticles((prev) => prev.filter((item) => item.id !== particle.id))
                }
              />
            ))}
            {isWords ? (
              <>
                <span className="typing-word">
                  {target.split("").map((ch, i) => renderChar(i, ch))}
                </span>
                {nextWord !== "" && (
                  <span className="typing-next" aria-hidden="true">
                    {nextWord}
                  </span>
                )}
              </>
            ) : (
              sentenceTokens.map((token) =>
                token.isSpace ? (
                  renderChar(token.start, " ")
                ) : (
                  <span className="typing-word" key={token.start}>
                    {token.text.split("").map((ch, i) => renderChar(token.start + i, ch))}
                  </span>
                ),
              )
            )}
          </div>
          <p className="typing-hint">
            {done
              ? "按 Enter 再来一组。"
              : isWords
                ? "输入单词后按空格进入下一个；未到词尾的空格无效。"
                : "直接输入开始计时，Backspace 可回改。"}
          </p>
          <TypingKeyboard
            width={settings.keyboardWidth}
            nextChar={
              settings.showKeyHint && !done
                ? pos < target.length
                  ? target[pos]
                  : isWords
                    ? " "
                    : null
                : null
            }
            flash={flash}
          />
          {done && (
            <div className="typing-result" role="status">
              <h2>本轮完成</h2>
              <p>
                {isWords && (
                  <>
                    单词 <strong>{wordsDone} 个</strong> ·{" "}
                  </>
                )}
                速度 <strong>{wpm} WPM</strong> · 正确率 <strong>{accuracy}%</strong> · 用时{" "}
                <strong>{elapsedSec.toFixed(1)} 秒</strong> · 击键 <strong>{total} 次</strong>（错 {errors}）
              </p>
              <div className="ui-actions">
                <button
                  className="ui-button ui-button--primary"
                  type="button"
                  onClick={(event) => {
                    event.currentTarget.blur();
                    reset();
                  }}
                >
                  再来一组（Enter）
                </button>
                <button
                  className="ui-button"
                  type="button"
                  onClick={(event) => {
                    event.currentTarget.blur();
                    setLibraryOpen(true);
                  }}
                >
                  调整词库
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <LibraryDialog open={libraryOpen} onClose={() => setLibraryOpen(false)} />
    </section>
  );
}
