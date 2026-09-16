import { createModuleSettings } from "../../shared/module-settings";

export type TypingMode = "words" | "sentences";
export type TypingEffect = "none" | "pulse" | "glow" | "particles";

// 打字页的模式、时长与速度动效偏好；页面工具栏与设置分区共享同一份状态。
export interface TypingSettings {
  mode: TypingMode;
  effect: TypingEffect;
  showKeyHint: boolean;
  // 单词模式一轮的时长（秒）；0 表示不限时，手动结束。
  wordSeconds: number;
  // 虚拟键盘的最大宽度（px），自由调节；快捷档位见 KEYBOARD_WIDTH_PRESETS。
  keyboardWidth: number;
}

export const WORD_SECONDS_OPTIONS = [60, 300, 0] as const;

export const KEYBOARD_WIDTH_MIN = 400;
export const KEYBOARD_WIDTH_MAX = 1100;
export const KEYBOARD_WIDTH_PRESETS: readonly { value: number; label: string }[] = [
  { value: 560, label: "小" },
  { value: 720, label: "标准" },
  { value: 900, label: "大" },
];

export function clampKeyboardWidth(value: number): number {
  if (!Number.isFinite(value)) return 720;
  return Math.min(KEYBOARD_WIDTH_MAX, Math.max(KEYBOARD_WIDTH_MIN, Math.round(value)));
}

export const EFFECT_OPTIONS: readonly { value: TypingEffect; label: string }[] = [
  { value: "none", label: "关闭" },
  { value: "pulse", label: "脉冲" },
  { value: "glow", label: "热力辉光" },
  { value: "particles", label: "粒子" },
];

const EFFECT_VALUES = new Set<string>(EFFECT_OPTIONS.map((option) => option.value));

export const typingSettings = createModuleSettings<TypingSettings>({
  key: "typing-module-settings",
  defaults: { mode: "words", effect: "pulse", showKeyHint: true, wordSeconds: 60, keyboardWidth: 720 },
  parse(raw) {
    const wordSeconds = Number(raw.wordSeconds);
    return {
      mode: raw.mode === "sentences" ? "sentences" : "words",
      effect: typeof raw.effect === "string" && EFFECT_VALUES.has(raw.effect)
        ? (raw.effect as TypingEffect)
        : "pulse",
      showKeyHint: raw.showKeyHint !== false,
      wordSeconds: (WORD_SECONDS_OPTIONS as readonly number[]).includes(wordSeconds) ? wordSeconds : 60,
      keyboardWidth: clampKeyboardWidth(Number(raw.keyboardWidth)),
    };
  },
});
