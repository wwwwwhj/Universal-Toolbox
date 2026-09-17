// 贪吃蛇的世界模型：无限地图、确定性地形与岩石生成、游戏状态与推进。
// 渲染（render.ts）与页面（SnakePage.tsx）共享这里的类型和函数。

export interface Cell {
  x: number;
  y: number;
}

// 道具：smash = 碎岩（短时内撞上的岩石被永久撞碎）；swim = 游泳（短时内水面安全）；
// fly = 飞行（持续腾空无视地形与自身，且移动加速）。
export type ItemType = "smash" | "swim" | "fly";
export interface Item extends Cell {
  type: ItemType;
}

// queue 是一局内尚未消费的转向输入，最多缓存 2 步，避免一次 tick 内连续两次按键被丢掉。
export interface GameState {
  snake: Cell[];
  foods: Cell[];
  items: Item[];
  dir: Cell;
  queue: Cell[];
  score: number;
  // 剩余腾空 tick 数；>0 时障碍与自撞不生效，归零的那一 tick 判定落点。
  air: number;
  // 落地后的跳跃冷却 tick 数。
  cooldown: number;
  // 本局内被碎岩道具撞碎的岩石坐标集合；岩石由坐标哈希生成，撞碎记录在此排除。
  destroyed: Set<string>;
  // 道具效果剩余毫秒数，每个 tick 按相邻两步的真实时间差扣减——
  // 不受速度档位或飞行加速影响，卡顿如实计入，暂停不计入。5 秒就是真实 5 秒。
  smash: number;
  swim: number;
  // 飞行剩余毫秒数；>0 时持续腾空（同 air 的危险豁免），归零即落地判定。
  fly: number;
}

export const RIGHT: Cell = { x: 1, y: 0 };

// 跳跃：腾空 3 个 tick（空中可越过岩石、水面与自身），落地后冷却 5 个 tick。
export const JUMP_TICKS = 3;
export const JUMP_COOLDOWN = 5;

// 同时存在的食物数量；补给在蛇头周围的环形带里刷新。
export const FOOD_TARGET = 3;
export const FOOD_CULL_DIST = 22;

// 道具：每种至多 1 个，贴着对应环境必定刷出（水边必有水滴、岩石旁必有宝石）；
// 碎岩 5s、游泳 10s（按吃到时的速度折算成 tick）。
export const ITEM_CULL_DIST = FOOD_CULL_DIST;
export const SMASH_MS = 5000;
export const SWIM_MS = 10000;
export const FLY_MS = 5000;
// 飞行时 tick 间隔乘以此系数（约 1.5 倍速）。
export const FLY_TICK_FACTOR = 0.65;

export const eq = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y;
export const keyOf = (cell: Cell) => `${cell.x},${cell.y}`;

// 坐标哈希 → [0,1)：让无限地图上的每格都有确定且一致的随机数，不用存地图。
export function hash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// 地形：值噪声（粗网格四角哈希 + 双线性平滑）把世界分成草地 / 沙漠 / 海洋，
// 边界是不规则的有机形状，同一位置永远是同一地形。海洋是危险地形（等同岩石）。
export type Terrain = "grass" | "sand" | "water";
const TERRAIN_GRID = 14;
const WATER_MAX = 0.15;
const SAND_MAX = 0.4;
const smooth = (t: number) => t * t * (3 - 2 * t);
function terrainNoise(x: number, y: number): number {
  const gx = Math.floor(x / TERRAIN_GRID);
  const gy = Math.floor(y / TERRAIN_GRID);
  const fx = smooth(x / TERRAIN_GRID - gx);
  const fy = smooth(y / TERRAIN_GRID - gy);
  const top = hash2(gx, gy) + (hash2(gx + 1, gy) - hash2(gx, gy)) * fx;
  const bottom = hash2(gx, gy + 1) + (hash2(gx + 1, gy + 1) - hash2(gx, gy + 1)) * fx;
  return top + (bottom - top) * fy;
}
export function terrainAt(x: number, y: number): Terrain {
  // 出生点安全区永远是草地（与 isObstacle 的留空区域一致）。
  if (x >= -5 && x <= 5 && y >= -4 && y <= 4) return "grass";
  const n = terrainNoise(x, y);
  if (n < WATER_MAX) return "water";
  if (n < SAND_MAX) return "sand";
  return "grass";
}

// 岩石障碍：按 6×6 分块，约一半的块长出一簇 1–4 格的岩石；
// 簇成员由簇中心坐标决定，因此同一格在任何时刻查询结果一致。出生点附近留安全区。
const CHUNK = 6;
export function isObstacle(x: number, y: number): boolean {
  if (x >= -5 && x <= 5 && y >= -4 && y <= 4) return false;
  const cx = Math.floor(x / CHUNK);
  const cy = Math.floor(y / CHUNK);
  if (hash2(cx, cy) >= 0.5) return false;
  const ox = cx * CHUNK + 1 + Math.floor(hash2(cx, cy + 512) * (CHUNK - 2));
  const oy = cy * CHUNK + 1 + Math.floor(hash2(cx + 512, cy) * (CHUNK - 2));
  if (x === ox && y === oy) return true;
  if (x === ox + 1 && y === oy) return hash2(ox, oy) < 0.7;
  if (x === ox && y === oy + 1) return hash2(ox + 31, oy) < 0.7;
  if (x === ox - 1 && y === oy) return hash2(ox, oy + 31) < 0.4;
  if (x === ox && y === oy - 1) return hash2(ox - 31, oy) < 0.4;
  return false;
}

// 危险地形：水面（地形固有，不受障碍开关影响）+ 岩石（障碍开关控制，碎掉的除外）。
export function hazardAt(
  x: number,
  y: number,
  obstaclesOn: boolean,
  destroyed?: Set<string>,
): boolean {
  return (
    terrainAt(x, y) === "water" ||
    (obstaclesOn && isObstacle(x, y) && !destroyed?.has(`${x},${y}`))
  );
}

// 在蛇头周围的环形带里随机找可站立的地面放食物；环半径随视野缩放，
// 让食物大多落在窗口边缘附近——看得见、够得着、又不会贴脸刷出。
export function spawnFood(
  head: Cell,
  taken: Set<string>,
  obstaclesOn: boolean,
  halfView: number,
  destroyed?: Set<string>,
): Cell | null {
  const rMin = Math.max(3, halfView - 4);
  const rMax = halfView + 5;
  for (let i = 0; i < 80; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = rMin + Math.random() * (rMax - rMin);
    const cell = {
      x: head.x + Math.round(Math.cos(angle) * r),
      y: head.y + Math.round(Math.sin(angle) * r),
    };
    const key = keyOf(cell);
    if (!taken.has(key) && !hazardAt(cell.x, cell.y, obstaclesOn, destroyed)) return cell;
  }
  return null;
}

// 道具在对应环境附近必定刷出，但不紧贴环境——落在距环境 3–8 格的可站立地面：
// 先在蛇头环形带里找环境格（水滴找水面、宝石找岩石），再在距它 3–8 格处找落点。
// 附近没有对应环境就不刷。
export function spawnItem(
  head: Cell,
  taken: Set<string>,
  obstaclesOn: boolean,
  halfView: number,
  destroyed: Set<string> | undefined,
  want: ItemType,
): Item | null {
  const rMin = Math.max(3, halfView - 4);
  const rMax = halfView + 5;
  const isWater = (x: number, y: number) => terrainAt(x, y) === "water";
  const isRock = (x: number, y: number) =>
    obstaclesOn && isObstacle(x, y) && !destroyed?.has(`${x},${y}`);
  // 飞行宝石是通用通行道具，刷在水面或岩石附近皆可。
  const isEnv =
    want === "swim" ? isWater : want === "smash" ? isRock : (x: number, y: number) => isWater(x, y) || isRock(x, y);
  for (let i = 0; i < 40; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = rMin + Math.random() * (rMax - rMin);
    const envCell = {
      x: head.x + Math.round(Math.cos(angle) * r),
      y: head.y + Math.round(Math.sin(angle) * r),
    };
    if (!isEnv(envCell.x, envCell.y)) continue;
    // 在距环境格 3–8 格的环里找可站立落点。
    for (let j = 0; j < 24; j++) {
      const a2 = Math.random() * Math.PI * 2;
      const d = 3 + Math.random() * 5;
      const cell = {
        x: envCell.x + Math.round(Math.cos(a2) * d),
        y: envCell.y + Math.round(Math.sin(a2) * d),
      };
      const key = keyOf(cell);
      if (taken.has(key) || hazardAt(cell.x, cell.y, obstaclesOn, destroyed)) continue;
      // 超出道具保留范围的位置不刷（迟早被丢弃）。
      if (Math.abs(cell.x - head.x) + Math.abs(cell.y - head.y) > ITEM_CULL_DIST) continue;
      return { ...cell, type: want };
    }
  }
  return null;
}

export function newGame(obstaclesOn: boolean, halfView: number): GameState {
  const snake: Cell[] = [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -2, y: 0 },
  ];
  const taken = new Set(snake.map(keyOf));
  const foods: Cell[] = [];
  for (let i = 0; i < FOOD_TARGET; i++) {
    const food = spawnFood(snake[0], taken, obstaclesOn, halfView);
    if (!food) break;
    foods.push(food);
    taken.add(keyOf(food));
  }
  // 出生点附近有对应环境时各送一个道具，让新玩家尽早认识它们。
  const items: Item[] = [];
  for (const type of ["swim", "smash", "fly"] as const) {
    const item = spawnItem(snake[0], taken, obstaclesOn, halfView, undefined, type);
    if (item) {
      items.push(item);
      taken.add(keyOf(item));
    }
  }
  return {
    snake,
    foods,
    items,
    dir: RIGHT,
    queue: [],
    score: 0,
    air: 0,
    cooldown: 0,
    destroyed: new Set(),
    smash: 0,
    swim: 0,
    fly: 0,
  };
}
