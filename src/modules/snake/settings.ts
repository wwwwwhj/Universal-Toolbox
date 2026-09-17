import { createModuleSettings } from "../../shared/module-settings";

export type SnakeSpeed = "slow" | "normal" | "fast";
export type SnakeView = "small" | "normal" | "large";
export type SnakeSize = "auto" | "s" | "m" | "l";

// 贪吃蛇的速度、障碍开关、视野、网格与最高分；页面工具栏与设置分区共享同一份状态。
// 地图无限延伸，没有边界概念；障碍是按坐标哈希生成的散落岩簇。
export interface SnakeSettings {
  speed: SnakeSpeed;
  // 是否生成岩石障碍（坐标哈希决定，同一张地图不变），腾空跳跃可越过。
  obstacles: boolean;
  // 相机窗口展示的地图格数（边长，取奇数保证蛇头居中）。
  view: SnakeView;
  // 棋盘像素尺寸：auto 随窗口大小铺满，s/m/l 为固定边长。
  size: SnakeSize;
  showGrid: boolean;
  // 本机历史最高分。
  best: number;
}

export const SPEED_OPTIONS: readonly { value: SnakeSpeed; label: string }[] = [
  { value: "slow", label: "慢速" },
  { value: "normal", label: "标准" },
  { value: "fast", label: "快速" },
];

// 每一格移动间隔（毫秒），速度档位的实际手感。
export const TICK_MS: Record<SnakeSpeed, number> = { slow: 180, normal: 120, fast: 80 };

export const VIEW_OPTIONS: readonly { value: SnakeView; label: string }[] = [
  { value: "small", label: "近" },
  { value: "normal", label: "标准" },
  { value: "large", label: "远" },
];

// 视野档位的窗口边长（格数），越大看到的地图区域越广、格子越小。
export const VIEW_CELLS: Record<SnakeView, number> = { small: 15, normal: 21, large: 27 };

export const SIZE_OPTIONS: readonly { value: SnakeSize; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "s", label: "小" },
  { value: "m", label: "中" },
  { value: "l", label: "大" },
];

const SPEED_VALUES = new Set<string>(SPEED_OPTIONS.map((option) => option.value));
const VIEW_VALUES = new Set<string>(VIEW_OPTIONS.map((option) => option.value));
const SIZE_VALUES = new Set<string>(SIZE_OPTIONS.map((option) => option.value));

export const snakeSettings = createModuleSettings<SnakeSettings>({
  key: "snake-module-settings",
  defaults: { speed: "normal", obstacles: true, view: "normal", size: "auto", showGrid: true, best: 0 },
  parse(raw) {
    const best = Number(raw.best);
    return {
      speed: typeof raw.speed === "string" && SPEED_VALUES.has(raw.speed)
        ? (raw.speed as SnakeSpeed)
        : "normal",
      obstacles: raw.obstacles !== false,
      view: typeof raw.view === "string" && VIEW_VALUES.has(raw.view)
        ? (raw.view as SnakeView)
        : "normal",
      size: typeof raw.size === "string" && SIZE_VALUES.has(raw.size)
        ? (raw.size as SnakeSize)
        : "auto",
      showGrid: raw.showGrid !== false,
      best: Number.isFinite(best) && best > 0 ? Math.floor(best) : 0,
    };
  },
});
