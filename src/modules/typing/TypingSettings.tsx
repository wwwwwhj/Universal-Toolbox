import { SegmentedField } from "../../shared/SegmentedField";
import {
  clampKeyboardWidth,
  EFFECT_OPTIONS,
  KEYBOARD_WIDTH_MAX,
  KEYBOARD_WIDTH_MIN,
  KEYBOARD_WIDTH_PRESETS,
  typingSettings,
} from "./settings";
import "./typing.css";

export default function TypingSettings() {
  const settings = typingSettings.use();
  const persistError = typingSettings.usePersistError();
  return (
    <>
      <p>英文打字的反馈动效、键盘提示与键盘尺寸，修改立即生效并记住。动效强度跟随最近几秒的打字速度变化。</p>
      {persistError && (
        <p className="ui-feedback ui-feedback--error" role="alert">
          修改已生效，但无法保存到本机存储，重启后将丢失：{persistError}
        </p>
      )}
      <SegmentedField
        id="typing-effect"
        label="速度动效"
        value={settings.effect}
        options={EFFECT_OPTIONS}
        onChange={(effect) => typingSettings.update({ effect })}
      />
      <div className="ui-field">
        <label htmlFor="typing-keyboard-width">
          键盘宽度（{KEYBOARD_WIDTH_MIN}–{KEYBOARD_WIDTH_MAX} px）
        </label>
        <div className="typing-width">
          <input
            type="range"
            id="typing-keyboard-width"
            min={KEYBOARD_WIDTH_MIN}
            max={KEYBOARD_WIDTH_MAX}
            step={10}
            value={settings.keyboardWidth}
            onChange={(event) => typingSettings.update({ keyboardWidth: Number(event.target.value) })}
          />
          <input
            className="ui-input typing-width-num"
            type="number"
            aria-label="键盘宽度数值"
            min={KEYBOARD_WIDTH_MIN}
            max={KEYBOARD_WIDTH_MAX}
            step={10}
            value={settings.keyboardWidth}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (event.target.value !== "" && Number.isFinite(value)) {
                typingSettings.update({ keyboardWidth: clampKeyboardWidth(value) });
              }
            }}
          />
        </div>
        <div className="ui-actions typing-width-presets">
          {KEYBOARD_WIDTH_PRESETS.map((preset) => (
            <button
              key={preset.value}
              className="ui-button"
              type="button"
              onClick={() => typingSettings.update({ keyboardWidth: preset.value })}
            >
              {preset.label} {preset.value}px
            </button>
          ))}
        </div>
      </div>
      <div className="ui-field">
        <label className="typing-check">
          <input
            type="checkbox"
            checked={settings.showKeyHint}
            onChange={(event) => typingSettings.update({ showKeyHint: event.target.checked })}
          />
          在键盘上高亮下一个待按按键
        </label>
      </div>
      <div className="ui-actions">
        <button className="ui-button" type="button" onClick={() => typingSettings.reset()}>
          恢复默认
        </button>
      </div>
    </>
  );
}
