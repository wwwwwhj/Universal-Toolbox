// 贪吃蛇的 canvas 渲染器：整个游戏区一张贴图，rAF 每帧绘制。
// 相机与蛇身位置都是亚格插值——彻底没有 DOM 动画、合成层与每 tick 的 reconcile。
import { isObstacle, terrainAt, type Cell, type GameState } from "./world";

// 渲染快照：prev/cur 是最近两个 tick 的游戏状态，tickAt 是 cur 的产生时刻，
// 每帧按 (now-tickAt)/tickMs 在两者之间插值；gen 变化（重开）时相机直接归位。
export interface RenderSnapshot {
  prev: GameState;
  cur: GameState;
  tickAt: number;
  gen: number;
  pops: { x: number; y: number; at: number; label: string; color: "food" | "smash" | "swim" | "fly" }[];
  // 爆发事件：rock = 岩石被撞碎（碎片飞散 + 画面微震）；dust = 起跳扬尘。
  bursts: { x: number; y: number; at: number; kind: "rock" | "dust" }[];
}

export interface RenderOptions {
  view: number;
  obstacles: boolean;
  showGrid: boolean;
  tickMs: number;
  crashed: boolean;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function drawBoard(
  canvas: HTMLCanvasElement,
  cssSize: number,
  snap: RenderSnapshot,
  o: RenderOptions,
  camX: number,
  camY: number,
  now: number,
) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const buf = Math.max(1, Math.round(cssSize * dpr));
  if (canvas.width !== buf || canvas.height !== buf) {
    canvas.width = buf;
    canvas.height = buf;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);
  const cell = cssSize / o.view;
  // 碎岩震屏：最近 220ms 内有岩石被撞碎时，画面按剩余强度随机抖动。
  let shakeX = 0;
  let shakeY = 0;
  for (const burst of snap.bursts) {
    if (burst.kind !== "rock") continue;
    const t = (now - burst.at) / 220;
    if (t < 1) {
      const amp = (1 - t) * cell * 0.09;
      shakeX += (Math.random() * 2 - 1) * amp;
      shakeY += (Math.random() * 2 - 1) * amp;
    }
  }
  if (shakeX !== 0 || shakeY !== 0) ctx.translate(shakeX, shakeY);
  // 主题色：把 var() 赋给 color 再读计算样式，可正确解析 light-dark()。
  const style = canvas.style;
  const colorOf = (token: string) => {
    style.color = token;
    return getComputedStyle(canvas).color;
  };
  const C = {
    sand: colorOf("var(--snake-sand)"),
    water: colorOf("var(--snake-water)"),
    line: colorOf("var(--snake-line)"),
    body: colorOf("var(--snake-body)"),
    head: colorOf("var(--snake-head)"),
    food: colorOf("var(--snake-food)"),
    wall: colorOf("var(--snake-wall)"),
    smash: colorOf("var(--snake-smash)"),
    swim: colorOf("var(--snake-swim)"),
    fly: colorOf("var(--snake-fly)"),
    danger: colorOf("var(--ui-danger)"),
    eye: colorOf("var(--ui-surface)"),
  };
  style.color = "";

  const sx = (wx: number) => (wx - camX) * cell;
  const sy = (wy: number) => (wy - camY) * cell;
  // 相机是小数，绘制范围取视野上下各外扩 1 格即可。
  const i0 = Math.floor(camX) - 1;
  const i1 = Math.ceil(camX + o.view) + 1;
  const j0 = Math.floor(camY) - 1;
  const j1 = Math.ceil(camY + o.view) + 1;

  // 地形：沙漠 / 海洋色块，草地由棋盘底色承担。
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const terrain = terrainAt(i, j);
      if (terrain === "grass") continue;
      ctx.fillStyle = terrain === "water" ? C.water : C.sand;
      ctx.fillRect(sx(i), sy(j), cell + 0.6, cell + 0.6);
      if (terrain === "water") {
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(sx(i), sy(j), cell + 0.6, cell * 0.22);
        ctx.fillStyle = "rgba(0,0,0,0.1)";
        ctx.fillRect(sx(i), sy(j + 0.78), cell + 0.6, cell * 0.22);
      }
    }
  }

  // 网格线。
  if (o.showGrid) {
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = Math.floor(camX); i <= Math.ceil(camX + o.view); i++) {
      const x = Math.round(sx(i)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssSize);
    }
    for (let j = Math.floor(camY); j <= Math.ceil(camY + o.view); j++) {
      const y = Math.round(sy(j)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(cssSize, y);
    }
    ctx.stroke();
  }

  // 岩石：石材方块，上缘受光 / 下缘背光 + 落地投影；被碎岩道具撞碎的不再绘制。
  if (o.obstacles) {
    const pad = cell * 0.08;
    const size = cell - pad * 2;
    const destroyed = snap.cur.destroyed;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!isObstacle(i, j)) continue;
        if (destroyed.size > 0 && destroyed.has(`${i},${j}`)) continue;
        const x = sx(i) + pad;
        const y = sy(j) + pad;
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.2)";
        ctx.shadowBlur = 3;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = C.wall;
        ctx.beginPath();
        ctx.roundRect(x, y, size, size, size * 0.18);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = "rgba(255,255,255,0.14)";
        ctx.fillRect(x, y, size, size * 0.18);
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.fillRect(x, y + size * 0.78, size, size * 0.22);
      }
    }
  }

  // 食物：径向渐变球体 + 呼吸脉动 + 峰值微光。
  const pulse = 0.62 + 0.06 * Math.sin((now / 1600) * Math.PI * 2);
  const glow = 0.5 + 0.5 * Math.sin((now / 1600) * Math.PI * 2);
  for (const food of snap.cur.foods) {
    const cx = sx(food.x + 0.5);
    const cy = sy(food.y + 0.5);
    const r = cell * 0.5 * pulse;
    const grad = ctx.createRadialGradient(
      cx - r * 0.3,
      cy - r * 0.3,
      r * 0.1,
      cx,
      cy,
      r,
    );
    grad.addColorStop(0, "rgba(255,255,255,0.65)");
    grad.addColorStop(0.35, C.food);
    grad.addColorStop(1, C.food);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.28)";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (glow > 0.85) {
      ctx.strokeStyle = C.food;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // 道具：碎岩 = 金色菱形宝石，游泳 = 蓝色水滴；上下浮动与食物区分。
  for (const item of snap.cur.items) {
    const bob = Math.sin(now / 800 + (item.x * 7 + item.y * 13)) * cell * 0.05;
    const cx = sx(item.x + 0.5);
    const cy = sy(item.y + 0.5) + bob;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 2;
    if (item.type === "smash") {
      const r = cell * 0.3;
      ctx.fillStyle = C.smash;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.45);
      ctx.lineTo(cx + r * 0.45, cy);
      ctx.lineTo(cx, cy + r * 0.45);
      ctx.lineTo(cx - r * 0.45, cy);
      ctx.closePath();
      ctx.fill();
    } else if (item.type === "fly") {
      // 飞行宝石：紫色三角晶 + 内芯高光。
      const r = cell * 0.32;
      ctx.fillStyle = C.fly;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.9, cy + r * 0.7);
      ctx.lineTo(cx - r * 0.9, cy + r * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.45);
      ctx.lineTo(cx + r * 0.38, cy + r * 0.32);
      ctx.lineTo(cx - r * 0.38, cy + r * 0.32);
      ctx.closePath();
      ctx.fill();
    } else {
      const r = cell * 0.26;
      ctx.fillStyle = C.swim;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 1.3);
      ctx.bezierCurveTo(
        cx + r * 0.9, cy - r * 0.15,
        cx + r * 0.8, cy + r * 0.85,
        cx, cy + r * 0.85,
      );
      ctx.bezierCurveTo(
        cx - r * 0.8, cy + r * 0.85,
        cx - r * 0.9, cy - r * 0.15,
        cx, cy - r * 1.3,
      );
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = Math.max(1, cell * 0.05);
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.5, cy + r * 0.2);
      ctx.quadraticCurveTo(cx - r * 0.25, cy - r * 0.1, cx, cy + r * 0.2);
      ctx.quadraticCurveTo(cx + r * 0.25, cy + r * 0.5, cx + r * 0.5, cy + r * 0.2);
      ctx.stroke();
    }
  }

  // 蛇身：每帧在 prev→cur 之间插值，腾空时画地面投影再上抬。
  const t = Math.min(1, (now - snap.tickAt) / o.tickMs);
  const snake = snap.cur.snake;
  const prev = snap.prev.snake;
  const air = snap.cur.air > 0;
  const fly = snap.cur.fly > 0;
  const airborne = air || fly;
  const segPos = (i: number): Cell => {
    const cur = snake[i];
    const from = i === 0 ? prev[0] : (prev[Math.min(i - 1, prev.length - 1)] ?? cur);
    return from ? { x: lerp(from.x, cur.x, t), y: lerp(from.y, cur.y, t) } : cur;
  };
  const pad = cell * 0.08;
  // 飞行比跳跃抬得更高。
  const lift = fly ? cell * 0.32 : air ? cell * 0.26 : 0;
  if (airborne) {
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    for (let i = snake.length - 1; i >= 0; i--) {
      const p = segPos(i);
      ctx.beginPath();
      ctx.ellipse(
        sx(p.x + 0.5),
        sy(p.y + 0.72),
        cell * 0.34,
        cell * 0.11,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
  for (let i = snake.length - 1; i >= 0; i--) {
    const p = segPos(i);
    const isHead = i === 0;
    const isTail = i === snake.length - 1;
    const scale = isTail ? 0.7 : 1;
    const size = (cell - pad * 2) * scale;
    const x = sx(p.x) + (cell - size) / 2;
    const y = sy(p.y) + (cell - size) / 2 - lift;
    ctx.save();
    if (o.crashed && !isHead) ctx.globalAlpha = 0.55;
    ctx.shadowColor = "rgba(0,0,0,0.16)";
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = isHead ? (o.crashed ? C.danger : C.head) : C.body;
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, size * (isHead ? 0.34 : 0.26));
    ctx.fill();
    ctx.restore();
    // 上缘受光 / 下缘背光；腾空时整条蛇泛白光，强化离地感。
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(x, y, size, size * 0.2);
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    ctx.fillRect(x, y + size * 0.78, size, size * 0.22);
    if (airborne) {
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.beginPath();
      ctx.roundRect(x, y, size, size, size * (isHead ? 0.34 : 0.26));
      ctx.fill();
    }
    // 道具生效中：碎岩 = 金色描边（外），游泳 = 蓝色描边（内），可叠加。
    if (snap.cur.smash > 0) {
      ctx.strokeStyle = C.smash;
      ctx.lineWidth = Math.max(1.5, cell * 0.06);
      ctx.beginPath();
      ctx.roundRect(x, y, size, size, size * (isHead ? 0.34 : 0.26));
      ctx.stroke();
    }
    if (snap.cur.swim > 0) {
      const inset = Math.max(2, cell * 0.07);
      ctx.strokeStyle = C.swim;
      ctx.lineWidth = Math.max(1, cell * 0.045);
      ctx.beginPath();
      ctx.roundRect(
        x + inset,
        y + inset,
        size - inset * 2,
        size - inset * 2,
        size * 0.2,
      );
      ctx.stroke();
    }
    if (isHead) {
      // 眼睛朝移动方向：前向偏移 + 两侧各一只。
      const d = snap.cur.dir;
      const px = -d.y;
      const py = d.x;
      const cx = sx(p.x + 0.5);
      const cy = sy(p.y + 0.5) - lift;
      ctx.fillStyle = C.eye;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(
          cx + d.x * cell * 0.16 + px * side * cell * 0.17,
          cy + d.y * cell * 0.16 + py * side * cell * 0.17,
          cell * 0.08,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      // 腾空 / 飞行时蛇头扇动一对白色小翅膀（在移动方向两侧上下扇动）。
      if (airborne) {
        const flap = Math.sin(now / (fly ? 60 : 80)) * 0.45;
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        for (const side of [-1, 1]) {
          ctx.save();
          ctx.translate(cx + px * side * cell * 0.34, cy + py * side * cell * 0.34);
          ctx.rotate(Math.atan2(py * side, px * side) - side * (0.4 + flap));
          ctx.beginPath();
          ctx.ellipse(cell * 0.2, 0, cell * 0.28, cell * 0.11, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
      // 飞行加速：蛇头后方拖出三条速度线。
      if (fly) {
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = Math.max(1, cell * 0.05);
        for (let i = 0; i < 3; i++) {
          const off = 0.55 + i * 0.35;
          const wob = Math.sin(now / 90 + i * 2) * 0.1;
          ctx.beginPath();
          ctx.moveTo(
            cx - d.x * cell * off + px * wob * cell,
            cy - d.y * cell * off + py * wob * cell,
          );
          ctx.lineTo(
            cx - d.x * cell * (off + 0.25) + px * wob * cell,
            cy - d.y * cell * (off + 0.25) + py * wob * cell,
          );
          ctx.stroke();
        }
      }
    }
  }

  // 爆发特效：rock = 被撞碎的岩石爆出 6 块碎石（抛物线飞散）；
  // dust = 起跳扬尘（扩散环 + 沙色小尘团）。
  snap.bursts = snap.bursts.filter((burst) => now - burst.at < 450);
  for (const burst of snap.bursts) {
    const t = (now - burst.at) / (burst.kind === "dust" ? 350 : 450);
    if (t >= 1) continue;
    const cx = sx(burst.x + 0.5);
    const cy = sy(burst.y + 0.5);
    if (burst.kind === "dust") {
      ctx.globalAlpha = (1 - t) * 0.6;
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = Math.max(1, cell * 0.05);
      ctx.beginPath();
      ctx.arc(cx, cy, cell * (0.2 + t * 0.7), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = C.sand;
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2 + burst.x * 0.9;
        const dist = t * cell * 0.8;
        const size = Math.max(0.5, cell * 0.1 * (1 - t));
        ctx.fillRect(
          cx + Math.cos(ang) * dist - size / 2,
          cy + Math.sin(ang) * dist - size / 2,
          size,
          size,
        );
      }
    } else {
      ctx.fillStyle = C.wall;
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + burst.x * 0.7 + burst.y * 1.3;
        const dist = t * cell * (0.9 + (i % 3) * 0.3);
        const size = Math.max(0.5, cell * 0.15 * (1 - t));
        ctx.globalAlpha = 1 - t;
        ctx.fillRect(
          cx + Math.cos(ang) * dist - size / 2,
          cy + Math.sin(ang) * dist - size / 2 + t * t * cell * 0.45,
          size,
          size,
        );
      }
    }
  }
  ctx.globalAlpha = 1;

  // 吃食 / 吃道具的飘字：原格上浮渐隐；过期的顺手清掉。
  snap.pops = snap.pops.filter((pop) => now - pop.at < 560);
  if (snap.pops.length > 0) {
    ctx.font = `600 ${cell * 0.45}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const pop of snap.pops) {
      const k = (now - pop.at) / 560;
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle =
        pop.color === "food"
          ? C.food
          : pop.color === "smash"
            ? C.smash
            : pop.color === "fly"
              ? C.fly
              : C.swim;
      ctx.fillText(pop.label, sx(pop.x + 0.5), sy(pop.y + 0.3 - k * 1.4));
    }
    ctx.globalAlpha = 1;
  }
}
