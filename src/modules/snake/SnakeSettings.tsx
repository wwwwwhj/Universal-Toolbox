import { SegmentedField } from "../../shared/SegmentedField";
import { SIZE_OPTIONS, SPEED_OPTIONS, VIEW_OPTIONS, snakeSettings } from "./settings";
import "./snake.css";

export default function SnakeSettings() {
  const settings = snakeSettings.use();
  const persistError = snakeSettings.usePersistError();
  return (
    <>
      <p>贪吃蛇的移动速度、岩石障碍、视野与棋盘网格，修改立即生效并记住；最高分只记录在本机。地图无限延伸，没有边界。</p>
      {persistError && (
        <p className="ui-feedback ui-feedback--error" role="alert">
          修改已生效，但无法保存到本机存储，重启后将丢失：{persistError}
        </p>
      )}
      <SegmentedField
        id="snake-set-speed"
        label="默认速度"
        value={settings.speed}
        options={SPEED_OPTIONS}
        onChange={(speed) => snakeSettings.update({ speed })}
      />
      <SegmentedField
        id="snake-set-obstacles"
        label="默认障碍"
        value={settings.obstacles ? "on" : "off"}
        options={[
          { value: "on", label: "开启" },
          { value: "off", label: "关闭" },
        ]}
        onChange={(value) => snakeSettings.update({ obstacles: value === "on" })}
      />
      <SegmentedField
        id="snake-set-view"
        label="默认视野"
        value={settings.view}
        options={VIEW_OPTIONS}
        onChange={(view) => snakeSettings.update({ view })}
      />
      <SegmentedField
        id="snake-set-size"
        label="默认尺寸"
        value={settings.size}
        options={SIZE_OPTIONS}
        onChange={(size) => snakeSettings.update({ size })}
      />
      <div className="ui-field">
        <label className="snake-check">
          <input
            type="checkbox"
            checked={settings.showGrid}
            onChange={(event) => snakeSettings.update({ showGrid: event.target.checked })}
          />
          显示棋盘网格
        </label>
      </div>
      <div className="ui-field">
        <span>最高分记录</span>
        <p className="snake-best-note">
          当前最高 <strong>{settings.best}</strong> 分，保存在本机存储中。
        </p>
      </div>
      <div className="ui-actions">
        <button
          className="ui-button"
          type="button"
          disabled={settings.best === 0}
          onClick={() => snakeSettings.update({ best: 0 })}
        >
          清除最高分
        </button>
        <button className="ui-button" type="button" onClick={() => snakeSettings.reset()}>
          恢复默认
        </button>
      </div>
    </>
  );
}
