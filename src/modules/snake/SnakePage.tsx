import { useEffect, useRef, useState } from "react";
import {
  Apple,
  ChevronsUp,
  Pause,
  Play,
  RotateCcw,
  Ruler,
  Timer,
  Trophy,
} from "lucide-react";
import { SegmentedField } from "../../shared/SegmentedField";
import {
  SIZE_OPTIONS,
  SPEED_OPTIONS,
  TICK_MS,
  VIEW_CELLS,
  VIEW_OPTIONS,
  snakeSettings,
} from "./settings";
import {
  FLY_MS,
  FLY_TICK_FACTOR,
  FOOD_CULL_DIST,
  FOOD_TARGET,
  ITEM_CULL_DIST,
  JUMP_COOLDOWN,
  JUMP_TICKS,
  SMASH_MS,
  SWIM_MS,
  eq,
  isObstacle,
  keyOf,
  newGame,
  spawnFood,
  spawnItem,
  terrainAt,
  type Cell,
  type GameState,
} from "./world";
import { drawBoard, type RenderOptions, type RenderSnapshot } from "./render";
import "./snake.css";

type Phase = "ready" | "running" | "paused" | "over";

const DIRECTIONS: Record<string, Cell> = {
  arrowup: { x: 0, y: -1 },
  w: { x: 0, y: -1 },
  arrowdown: { x: 0, y: 1 },
  s: { x: 0, y: 1 },
  arrowleft: { x: -1, y: 0 },
  a: { x: -1, y: 0 },
  arrowright: { x: 1, y: 0 },
  d: { x: 1, y: 0 },
};

const PHASE_LABEL: Record<Phase, string> = {
  ready: "尚未开始",
  running: "进行中",
  paused: "已暂停",
  over: "已结束",
};

// 只把真正的文本输入视为可编辑目标；复选框、单选等控件仍属于游戏页的一部分。
const TEXT_INPUT_TYPES = new Set([
  "text", "search", "number", "email", "url", "password", "tel",
  "date", "time", "datetime-local", "month", "week",
]);

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

// 点击或勾选后让控件失焦：本页键盘输入优先于控件激活，避免空格、Enter 被焦点控件吃掉。
function blurActiveControl() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

// 分段控件 onChange 后按需失焦：鼠标点击时焦点不在控件内（mousedown 已拦截），
// 失焦无感；键盘 Tab + 方向键操作时焦点在该控件的 radio 上，必须保留才能连续调整。
function blurUnlessInside(name: string) {
  if (
    document.activeElement instanceof HTMLElement &&
    document.activeElement.closest(`input[name="${name}"]`)
  ) {
    return;
  }
  blurActiveControl();
}

function formatTime(ms: number) {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export default function SnakePage() {
  const settings = snakeSettings.use();
  const persistError = snakeSettings.usePersistError();
  // 视野档位 → 窗口边长（奇数格）；蛇头固定在正中心那一格。
  const VIEW = VIEW_CELLS[settings.view];
  const HALF_VIEW = (VIEW - 1) / 2;
  const [phase, setPhase] = useState<Phase>("ready");
  // 每次重开递增：驱动移动定时器重建，保证新局第一步等待完整节拍。
  const [runId, setRunId] = useState(0);
  const [game, setGame] = useState<GameState>(() => {
    const initial = snakeSettings.get();
    return newGame(initial.obstacles, (VIEW_CELLS[initial.view] - 1) / 2);
  });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [newBest, setNewBest] = useState(false);
  const [crash, setCrash] = useState(false);
  // 飞行加速：实际 tick 间隔 = 档位 × 0.65（约 1.5 倍速），同时是渲染插值基准。
  const flying = game.fly > 0;
  const effTickMs = flying
    ? Math.round(TICK_MS[settings.speed] * FLY_TICK_FACTOR)
    : TICK_MS[settings.speed];
  // 吃到道具时的顶部横幅提示。
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const noticeSeq = useRef(0);
  const noticeTimer = useRef(0);
  function showNotice(text: string) {
    noticeSeq.current += 1;
    setNotice({ id: noticeSeq.current, text });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2400);
  }
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  // 可变游戏状态走 ref + 原子提交，interval 与键位处理器总能读到最新值。
  const gameRef = useRef(game);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // 用时 = 已确认累计（暂停/结束时结算）+ 当前运行段。
  const accumRef = useRef(0);
  const runStartRef = useRef(0);
  // 本局起跑时的最高分基线：破纪录在吃食当下立即持久化（重开不丢分），
  // 此基线仅用于结算卡的「新纪录」标记。
  const bestAtStartRef = useRef(settings.best);
  // 上一步的真实时间戳：效果时长按实际时间差扣减；暂停 / 恢复 / 重开时重置。
  const lastStepAtRef = useRef(performance.now());

  // 渲染快照：canvas 每帧在 prev→cur 之间插值；tickAt 只在真正的游戏 tick 推进，
  // 转向 / 跳跃等非 tick 提交不打断插值相位；gen 变化（重开）时相机直接归位。
  const renderRef = useRef<RenderSnapshot>({
    prev: game,
    cur: game,
    tickAt: performance.now(),
    gen: 0,
    pops: [],
    bursts: [],
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const boardPxRef = useRef(0);
  const optsRef = useRef<RenderOptions>({
    view: VIEW,
    obstacles: settings.obstacles,
    showGrid: settings.showGrid,
    tickMs: TICK_MS[settings.speed],
    crashed: crash,
  });
  optsRef.current = {
    view: VIEW,
    obstacles: settings.obstacles,
    showGrid: settings.showGrid,
    // 用实际 tick 间隔做插值基准，飞行加速时蛇身动画不掉拍。
    tickMs: effTickMs,
    crashed: crash,
  };

  function commitGame(next: GameState, tick = false) {
    gameRef.current = next;
    const r = renderRef.current;
    if (tick) {
      renderRef.current = {
        prev: r.cur,
        cur: next,
        tickAt: performance.now(),
        gen: r.gen,
        pops: r.pops,
        bursts: r.bursts,
      };
    } else {
      r.cur = next;
    }
    setGame(next);
  }

  function start() {
    const now = performance.now();
    runStartRef.current = now;
    lastStepAtRef.current = now;
    phaseRef.current = "running";
    setPhase("running");
  }

  function restart() {
    const next = newGame(settings.obstacles, HALF_VIEW);
    const r = renderRef.current;
    const now = performance.now();
    renderRef.current = {
      prev: next,
      cur: next,
      tickAt: now,
      gen: r.gen + 1,
      pops: [],
      bursts: [],
    };
    commitGame(next);
    accumRef.current = 0;
    bestAtStartRef.current = settings.best;
    lastStepAtRef.current = now;
    // 上一局的道具横幅和它的定时器一并清掉，不带到新局。
    window.clearTimeout(noticeTimer.current);
    setNotice(null);
    setElapsedMs(0);
    setNewBest(false);
    setCrash(false);
    runStartRef.current = now;
    phaseRef.current = "running";
    setPhase("running");
    // 进行中重开时 phase/effTickMs 都没变，定时器不会重建；
    // bump runId 强制重建，新局第一步总是等满一个完整节拍。
    setRunId((id) => id + 1);
  }

  function pause() {
    if (phaseRef.current !== "running") return;
    const now = performance.now();
    // 先结算上次 tick 到暂停之间已运行的时间：这段道具时长不能漏扣。
    const stepMs = Math.max(now - lastStepAtRef.current, 0);
    lastStepAtRef.current = now;
    const g = gameRef.current;
    if (stepMs > 0 && (g.smash > 0 || g.swim > 0 || g.fly > 0)) {
      commitGame({
        ...g,
        smash: Math.max(0, g.smash - stepMs),
        swim: Math.max(0, g.swim - stepMs),
        fly: Math.max(0, g.fly - stepMs),
      });
    }
    accumRef.current += now - runStartRef.current;
    setElapsedMs(accumRef.current);
    phaseRef.current = "paused";
    setPhase("paused");
  }

  function resume() {
    if (phaseRef.current !== "paused") return;
    const now = performance.now();
    runStartRef.current = now;
    lastStepAtRef.current = now;
    phaseRef.current = "running";
    setPhase("running");
  }

  function finish(crashed: boolean) {
    accumRef.current += performance.now() - runStartRef.current;
    setElapsedMs(accumRef.current);
    phaseRef.current = "over";
    setPhase("over");
    setCrash(crashed);
  }

  function turn(dir: Cell) {
    const g = gameRef.current;
    const last = g.queue.length > 0 ? g.queue[g.queue.length - 1] : g.dir;
    // 忽略反向与同向重复的输入，防止一次 tick 内 180° 掉头撞到自己。
    if ((dir.x === -last.x && dir.y === -last.y) || (dir.x === last.x && dir.y === last.y)) return;
    if (g.queue.length >= 2) return;
    commitGame({ ...g, queue: [...g.queue, dir] });
  }

  function jump() {
    if (phaseRef.current !== "running") return;
    const g = gameRef.current;
    // 飞行中已经在天上，跳跃无意义。
    if (g.air > 0 || g.cooldown > 0 || g.fly > 0) return;
    // 起跳扬尘：脚下爆出一圈尘雾。
    renderRef.current.bursts.push({
      x: g.snake[0].x,
      y: g.snake[0].y,
      at: performance.now(),
      kind: "dust",
    });
    commitGame({ ...g, air: JUMP_TICKS });
  }

  function step() {
    if (phaseRef.current !== "running") return;
    const g = gameRef.current;
    const queue = g.queue.slice();
    const dir = queue.length > 0 ? queue.shift()! : g.dir;
    const head = { x: g.snake[0].x + dir.x, y: g.snake[0].y + dir.y };
    const headKey = keyOf(head);
    const now = performance.now();
    // 效果按真实流逝时间扣减：取相邻两步的实际时间差，卡顿 / 计时间隔漂移会如实计入；
    // start / resume / restart 会重置 lastStepAt，暂停时长不计入。
    const stepMs = Math.max(now - lastStepAtRef.current, 0);
    lastStepAtRef.current = now;
    // air 按 tick 递减；归零即落地，落点必须是空地（不能撞岩石水面或自身）。
    const air = Math.max(0, g.air - 1);
    // 道具效果按真实流逝毫秒扣减，吃到新道具时刷新为满时长。
    let fly = Math.max(0, g.fly - stepMs);
    let smash = Math.max(0, g.smash - stepMs);
    let swim = Math.max(0, g.swim - stepMs);
    // 跳跃的短腾空吃不到东西，飞行可以俯冲拾取。
    const canPick = air === 0;
    const foodIndex = canPick ? g.foods.findIndex((food) => eq(food, head)) : -1;
    const eating = foodIndex >= 0;
    const itemIndex = canPick ? g.items.findIndex((item) => eq(item, head)) : -1;
    if (eating) {
      renderRef.current.pops.push({ x: head.x, y: head.y, at: now, label: "+1", color: "food" });
    }
    if (itemIndex >= 0) {
      const item = g.items[itemIndex];
      const ms = item.type === "smash" ? SMASH_MS : item.type === "swim" ? SWIM_MS : FLY_MS;
      if (item.type === "smash") smash = Math.max(smash, ms);
      else if (item.type === "swim") swim = Math.max(swim, ms);
      else fly = Math.max(fly, ms);
      showNotice(
        item.type === "smash"
          ? "获得撞碎岩石能力 5秒"
          : item.type === "swim"
            ? "获得游泳能力 10秒"
            : "获得飞行加速能力 5秒",
      );
      renderRef.current.pops.push({
        x: head.x,
        y: head.y,
        at: now,
        label: item.type === "smash" ? "碎岩!" : item.type === "swim" ? "游泳!" : "飞行!",
        color: item.type,
      });
    }
    // 腾空状态在道具结算后计算：当步吃到飞行宝石立即生效，能救下致命落点。
    const airborne = air > 0 || fly > 0;
    // 不吃食物时尾格会让出，先去掉再判自撞。
    const body = eating ? g.snake : g.snake.slice(0, -1);
    const onWater = terrainAt(head.x, head.y) === "water";
    const onRock =
      settings.obstacles && isObstacle(head.x, head.y) && !g.destroyed.has(headKey);
    const onBody = body.some((cell) => eq(cell, head));
    let cooldown = Math.max(0, g.cooldown - 1);
    if (g.air > 0 && air === 0) cooldown = JUMP_COOLDOWN;
    // 碎岩生效时撞上岩石 = 永久撞碎并占位；游泳生效时水面安全。落水 / 撞岩 / 咬到自己照常结束。
    let destroyed = g.destroyed;
    if (!airborne && onRock && smash > 0) {
      destroyed = new Set(g.destroyed);
      destroyed.add(headKey);
      renderRef.current.bursts.push({ x: head.x, y: head.y, at: now, kind: "rock" });
    }
    if (!airborne && (onBody || (onWater && swim === 0) || (onRock && smash === 0))) {
      // 撞死也提交新头部位置，插值动画会把头滑进岩石 / 水面 / 身体。
      commitGame(
        { ...g, snake: [head, ...body], dir, queue: [], air, cooldown, smash, swim, fly },
        true,
      );
      finish(true);
      return;
    }
    const snake = [head, ...body];
    const score = g.score + (eating ? 1 : 0);
    // 得分破纪录立即持久化：刷新纪录后直接重开也不丢分；
    // 「新纪录」以本局起跑基线为准，只标记一次。
    if (score > settings.best) snakeSettings.update({ best: score });
    if (score > bestAtStartRef.current) setNewBest(true);
    let foods = eating ? g.foods.filter((_, index) => index !== foodIndex) : g.foods;
    let items = itemIndex >= 0 ? g.items.filter((_, index) => index !== itemIndex) : g.items;
    // 甩掉离蛇头太远的食物和道具，再把数量补足到常驻值。
    foods = foods.filter(
      (food) => Math.abs(food.x - head.x) + Math.abs(food.y - head.y) <= FOOD_CULL_DIST,
    );
    items = items.filter(
      (item) => Math.abs(item.x - head.x) + Math.abs(item.y - head.y) <= ITEM_CULL_DIST,
    );
    const taken = new Set([
      ...snake.map(keyOf),
      ...foods.map(keyOf),
      ...items.map(keyOf),
    ]);
    while (foods.length < FOOD_TARGET) {
      const food = spawnFood(head, taken, settings.obstacles, HALF_VIEW, destroyed);
      if (!food) break;
      foods = [...foods, food];
      taken.add(keyOf(food));
    }
    // 道具按环境必定补刷：水边必刷水滴、岩石旁必刷宝石、危险地形附近刷飞行晶（各至多 1 个）。
    for (const type of ["swim", "smash", "fly"] as const) {
      if (items.some((item) => item.type === type)) continue;
      const item = spawnItem(head, taken, settings.obstacles, HALF_VIEW, destroyed, type);
      if (item) {
        items = [...items, item];
        taken.add(keyOf(item));
      }
    }
    commitGame(
      {
        snake,
        foods,
        items,
        dir,
        queue,
        score,
        air,
        cooldown,
        destroyed,
        smash,
        swim,
        fly,
      },
      true,
    );
    setElapsedMs(accumRef.current + performance.now() - runStartRef.current);
  }

  // interval 经 ref 调最新 step，速度档位、飞行加速或重开（runId）变化时按新间隔重建定时器。
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (phase !== "running") return;
    const id = window.setInterval(() => stepRef.current(), effTickMs);
    return () => window.clearInterval(id);
  }, [phase, effTickMs, runId]);

  // 渲染循环：rAF 每帧绘制，相机指数平滑追蛇头（时间常数 ~1.8 tick）。
  // 游戏区不再有任何 DOM 动画 / React reconcile，开销与节点数无关。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let camX = NaN;
    let camY = NaN;
    let lastGen = -1;
    let lastT = performance.now();
    let raf = requestAnimationFrame(function frame(now) {
      const r = renderRef.current;
      const o = optsRef.current;
      const half = (o.view - 1) / 2;
      const head = r.cur.snake[0];
      const tx = head.x - half;
      const ty = head.y - half;
      if (r.gen !== lastGen || Number.isNaN(camX)) {
        camX = tx;
        camY = ty;
        lastGen = r.gen;
      }
      const dt = Math.min(64, now - lastT);
      lastT = now;
      const k = 1 - Math.exp(-dt / (o.tickMs * 1.8));
      camX += (tx - camX) * k;
      camY += (ty - camY) * k;
      const size = boardPxRef.current;
      if (size > 0) drawBoard(canvas, size, r, o, camX, camY, now);
      raf = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // 棋盘像素边长经 ResizeObserver 进 ref，供渲染循环使用（不触发 React 更新）。
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const ro = new ResizeObserver((entries) => {
      boardPxRef.current = entries[0].contentRect.width;
    });
    ro.observe(board);
    return () => ro.disconnect();
  }, []);

  // 输入挂在 window 上：页面可见即可直接操作；弹窗与输入控件上的按键不拦截。
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (document.querySelector("dialog[open]")) return;
    if (isEditableTarget(event.target)) return;
    const onControl =
      event.target instanceof HTMLElement &&
      event.target.closest("button, a, summary, input, select");
    if (onControl && (event.key === " " || event.key === "Enter")) return;

    const key = event.key.toLowerCase();
    const dir = DIRECTIONS[key];
    if (dir) {
      // 焦点在选项类控件上时方向键留给原生交互（分段控件的 radio 用方向键切换选项），
      // 避免一边转向一边误改速度 / 障碍设置。
      const onOption =
        event.target instanceof HTMLElement && event.target.closest("input, select");
      if (onOption && key.startsWith("arrow")) return;
      // 先拦浏览器默认滚动，再忽略长按重复——顺序不能反，否则长按方向键仍滚动页面。
      event.preventDefault();
      if (event.repeat) return;
      if (phaseRef.current === "running") turn(dir);
      return;
    }
    // 空格是主操作键：未开始 = 开始，已暂停 = 继续，进行中 = 跳跃；J / Shift 仅跳跃。
    if (key === " " || key === "j" || key === "shift") {
      event.preventDefault();
      if (event.repeat) return;
      const current = phaseRef.current;
      if (current === "ready") start();
      else if (current === "paused") resume();
      else jump();
      return;
    }
    if (key === "p" || key === "escape") {
      if (event.repeat) return;
      const current = phaseRef.current;
      if (current === "running") pause();
      else if (current === "paused") resume();
      return;
    }
    if (key === "enter") {
      event.preventDefault();
      if (event.repeat) return;
      if (phaseRef.current === "ready") start();
      else restart();
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // 窗口失焦自动暂停，避免切换窗口时白白撞死。
  useEffect(() => {
    const listener = () => pause();
    window.addEventListener("blur", listener);
    return () => window.removeEventListener("blur", listener);
  }, []);

  const best = Math.max(settings.best, game.score);
  const headInWater =
    game.swim > 0 && terrainAt(game.snake[0].x, game.snake[0].y) === "water";
  const boardLabel = `棋盘：${PHASE_LABEL[phase]}，得分 ${game.score}，长度 ${game.snake.length}${game.air > 0 || flying ? "，腾空" : ""}${game.smash > 0 ? "，碎岩生效中" : ""}${game.swim > 0 ? "，游泳生效中" : ""}${flying ? "，飞行中" : ""}`;
  const jumpLabel = game.air > 0 ? "空中" : game.cooldown > 0 ? "冷却" : "就绪";

  return (
    <section
      className="snake-page"
      onMouseDown={(event) => {
        // 游戏页优先保证键盘输入：鼠标点击控件不转移焦点（键盘 Tab 仍可聚焦操作）。
        if (event.target instanceof HTMLElement && event.target.closest("dialog")) return;
        event.preventDefault();
        blurActiveControl();
      }}
    >
      <h1>贪吃蛇</h1>
      <p>方向键或 WASD 控制，地图无限延伸、视角跟随蛇头；撞上岩石、掉进水里或咬到自己即结束。</p>
      {persistError && (
        <p className="ui-feedback ui-feedback--error" role="alert">
          贪吃蛇偏好未能保存到本机存储，重启后将恢复为上次保存的值：{persistError}
        </p>
      )}
      <div className="ui-toolbar">
        <SegmentedField
          id="snake-speed"
          label="速度"
          value={settings.speed}
          options={SPEED_OPTIONS}
          onChange={(speed) => {
            snakeSettings.update({ speed });
            blurUnlessInside("snake-speed");
          }}
        />
        <SegmentedField
          id="snake-obstacles"
          label="障碍"
          value={settings.obstacles ? "on" : "off"}
          options={[
            { value: "on", label: "开启" },
            { value: "off", label: "关闭" },
          ]}
          onChange={(value) => {
            snakeSettings.update({ obstacles: value === "on" });
            blurUnlessInside("snake-obstacles");
          }}
        />
        <SegmentedField
          id="snake-view"
          label="视野"
          value={settings.view}
          options={VIEW_OPTIONS}
          onChange={(view) => {
            snakeSettings.update({ view });
            blurUnlessInside("snake-view");
          }}
        />
        <SegmentedField
          id="snake-size"
          label="尺寸"
          value={settings.size}
          options={SIZE_OPTIONS}
          onChange={(size) => {
            snakeSettings.update({ size });
            blurUnlessInside("snake-size");
          }}
        />
        <button
          className="ui-button snake-btn"
          type="button"
          disabled={phase === "ready" || phase === "over"}
          onClick={(event) => {
            event.currentTarget.blur();
            if (phase === "paused") resume();
            else pause();
          }}
        >
          {phase === "paused" ? (
            <>
              <Play size={14} aria-hidden="true" />
              继续
            </>
          ) : (
            <>
              <Pause size={14} aria-hidden="true" />
              暂停
            </>
          )}
        </button>
        <button
          className="ui-button snake-btn"
          type="button"
          onClick={(event) => {
            event.currentTarget.blur();
            restart();
          }}
        >
          <RotateCcw size={14} aria-hidden="true" />
          重新开始
        </button>
      </div>
      <details className="ui-help">
        <summary>规则与操作</summary>
        <p>
          地图无限延伸，相机始终跟随蛇头，世界按区域生成草地、沙漠与海洋地形。吃到一个食物得 1
          分并变长一格，场上始终有 3 个食物在附近刷新；咬到自己、撞上岩石或掉进水里即结束。岩簇缝隙
          可直接穿行，空格 / J / Shift 跳跃会腾空 3 步，可越过岩石、水面和自己的蛇身，但落地格必须是
          空地，腾空时吃不到食物和道具，落地后短暂冷却。距水面 3–8 格内必刷蓝色水滴「游泳」
          （吃下后 10 秒内水面安全），距岩石 3–8 格内必刷金色菱形「碎岩」（吃下后 5 秒内撞上岩石
          会将其永久撞碎），危险地形附近还会刷紫色三角「飞行宝石」（吃下后 5 秒持续飞行且移动加速，
          飞行中无视一切地形与自身、可照常拾取，效果结束时落点必须安全）。P 或 Esc 暂停 / 继续，
          Enter 重新开始一局，窗口失焦时自动暂停。
        </p>
      </details>
      <div className="snake-surface">
        <div className="snake-stats" role="status">
          <span>
            <Apple size={13} aria-hidden="true" />
            得分 <strong>{game.score}</strong>
          </span>
          <span>
            <Trophy size={13} aria-hidden="true" />
            最高 <strong>{best}</strong>
          </span>
          <span>
            <Ruler size={13} aria-hidden="true" />
            长度 <strong>{game.snake.length}</strong>
          </span>
          <span>
            <ChevronsUp size={13} aria-hidden="true" />
            跳跃 <strong>{jumpLabel}</strong>
          </span>
          <span>
            <Timer size={13} aria-hidden="true" />
            用时 <strong>{formatTime(elapsedMs)}</strong>
          </span>
        </div>
        <div
          className={`snake-board-wrap${
            settings.size === "auto" ? "" : ` snake-board-wrap--${settings.size}`
          }${crash ? " snake-board-wrap--crash" : ""}`}
        >
          <div
            ref={boardRef}
            className="snake-board"
            role="img"
            aria-label={boardLabel}
          >
            {/* 整个游戏区是一张 canvas：地形、岩石、食物、蛇身、飘分全在
                一个元素里由 rAF 逐帧绘制，DOM 只剩状态遮罩。 */}
            <canvas ref={canvasRef} className="snake-canvas" />
            {game.swim > 0 && (
              <div
                className={`snake-swim-glow${headInWater ? " snake-swim-glow--deep" : ""}`}
                aria-hidden="true"
              />
            )}
          </div>
          {notice && (
            <div className="snake-notice" key={notice.id} role="status">
              {notice.text}
            </div>
          )}
          {(game.smash > 0 || game.swim > 0 || game.fly > 0) && (
            <div className="snake-buffs">
              {game.smash > 0 && (
                <div className="snake-buff snake-buff--smash">
                  <span>碎岩 {Math.ceil(game.smash / 1000)}s</span>
                  <i
                    style={{
                      width: `${Math.min(100, (game.smash * 100) / SMASH_MS)}%`,
                      transitionDuration: `${effTickMs}ms`,
                    }}
                  />
                </div>
              )}
              {game.swim > 0 && (
                <div className="snake-buff snake-buff--swim">
                  <span>游泳 {Math.ceil(game.swim / 1000)}s</span>
                  <i
                    style={{
                      width: `${Math.min(100, (game.swim * 100) / SWIM_MS)}%`,
                      transitionDuration: `${effTickMs}ms`,
                    }}
                  />
                </div>
              )}
              {game.fly > 0 && (
                <div className="snake-buff snake-buff--fly">
                  <span>飞行 {Math.ceil(game.fly / 1000)}s</span>
                  <i
                    style={{
                      width: `${Math.min(100, (game.fly * 100) / FLY_MS)}%`,
                      transitionDuration: `${effTickMs}ms`,
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {phase !== "running" && (
            <div className={`snake-overlay${phase === "over" ? " snake-overlay--over" : ""}`}>
              <div className="snake-card">
                {phase === "ready" && (
                  <>
                    <h2>准备开始</h2>
                    <p>地图无限延伸，吃掉食物变长；空格腾空越过岩石与水面。</p>
                    <div className="ui-actions">
                      <button
                        className="ui-button ui-button--primary"
                        type="button"
                        onClick={(event) => {
                          event.currentTarget.blur();
                          start();
                        }}
                      >
                        开始游戏（空格）
                      </button>
                    </div>
                  </>
                )}
                {phase === "paused" && (
                  <>
                    <h2>已暂停</h2>
                    <p>局面已冻结，继续后从当前位置恢复。</p>
                    <div className="ui-actions">
                      <button
                        className="ui-button ui-button--primary"
                        type="button"
                        onClick={(event) => {
                          event.currentTarget.blur();
                          resume();
                        }}
                      >
                        继续（空格）
                      </button>
                      <button
                        className="ui-button"
                        type="button"
                        onClick={(event) => {
                          event.currentTarget.blur();
                          restart();
                        }}
                      >
                        重新开始
                      </button>
                    </div>
                  </>
                )}
                {phase === "over" && (
                  <>
                    <h2>游戏结束</h2>
                    <p>
                      本局 <strong>{game.score}</strong> 分 ·{" "}
                      {newBest ? (
                        <span className="snake-new-best">
                          <Trophy size={13} aria-hidden="true" />
                          新纪录！
                        </span>
                      ) : (
                        <>最高 {settings.best} 分</>
                      )}
                    </p>
                    <div className="ui-actions">
                      <button
                        className="ui-button ui-button--primary"
                        type="button"
                        onClick={(event) => {
                          event.currentTarget.blur();
                          restart();
                        }}
                      >
                        再来一局（Enter）
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        <p className="snake-hint">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <kbd>←</kbd>
          <kbd>→</kbd> / <kbd>W</kbd>
          <kbd>A</kbd>
          <kbd>S</kbd>
          <kbd>D</kbd> 移动 · <kbd>空格</kbd> 跳跃 · <kbd>P</kbd> 暂停 ·{" "}
          <kbd>Enter</kbd> 重新开始
        </p>
      </div>
    </section>
  );
}
