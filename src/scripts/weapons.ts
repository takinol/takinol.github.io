/**
 * 手持武器渲染（各流派）
 * ============================================================
 * 设计原则（与 katana.ts 同源）：
 *  1. 角度/长度**优先来自判定层那一份几何**（blade = f.bladeDraw）——
 *     「画出来的武器」和「判定用的胶囊」用同一组数字，物理上不可能分叉。
 *     没有 blade（待机/收招间隙）就沿前臂方向画常驻持械姿态。
 *  2. 所有尺寸 ×k（角色缩放），世界坐标直接画（place() 已做 facing 镜像，
 *     所以这里的角度在两个朝向下天然正确）。
 *  3. 剑客(swordsman)的鞘/拔刀精绘和机关臂(puppeteer)的套管在 drawFigure
 *     里有专属分支，不经本模块。
 */
import { drawKatana } from './katana';

export interface WeaponPt { x: number; y: number; z?: number }
export interface BladeGeo { hand: { x: number; y: number; z?: number }; angle: number; len: number }

const WOOD = '#8B5E3C';
const WOOD_DARK = '#6B4429';
const METAL = '#C9A227';
const STEEL = '#9AA7B4';
const DARK = '#232931';

/** 手持武器分发表：build → 画法。swordsman/puppeteer 不经过这里（见文件头）。 */
export function drawHeldWeapon(
  ctx: CanvasRenderingContext2D,
  build: string,
  p: { handF: WeaponPt; elbowF: WeaponPt; handB: WeaponPt; elbowB: WeaponPt },
  facing: number,
  k: number,
  outline: string,
  blade?: BladeGeo,
): void {
  const armAng = Math.atan2(p.handF.y - p.elbowF.y, p.handF.x - p.elbowF.x);
  const armAngB = Math.atan2(p.handB.y - p.elbowB.y, p.handB.x - p.elbowB.x);
  // 武器主轴角：有判定几何用判定的，否则沿前臂
  const ang = blade ? blade.angle : armAng;
  const hand = blade ? blade.hand : p.handF;
  const fx = Math.cos(ang), fy = Math.sin(ang);        // 沿武器方向
  const nx = -fy, ny = fx;                              // 法线方向
  const tip = { x: hand.x + fx * (blade ? blade.len : 10 * k), y: hand.y + fy * (blade ? blade.len : 10 * k) };

  switch (build) {
    /* ── 刀类：拔刀时委托 katana（与剑客同一份精绘）；武士待机画腰间鞘 ── */
    case 'samurai':
      if (blade) { drawKatana(ctx, blade.hand, blade.angle, blade.len, k, facing, outline); break; }
      drawWaistSaya(ctx, p, facing, k, outline);
      break;

    /* ── 大战斧：长柄 + 双面新月巨刃（占半个身位宽）+ 背刺 ──
     * 「大大的斧头」：刃要一眼看出是斧，不是一根棍 */
    case 'viking': {
      const L = blade ? blade.len * 1.15 : 17 * k;
      const tipA = { x: hand.x + fx * L, y: hand.y + fy * L };
      // 柄（手后留柄尾，更长的柄）
      stroke(ctx, hand.x - fx * 7 * k, hand.y - fy * 7 * k, tipA.x, tipA.y, WOOD_DARK, 3.2 * k, outline);
      // 双面新月巨刃：以柄顶为中心、法线两侧各张开一大片
      const hr = 14 * k;
      for (const side of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(tipA.x, tipA.y);
        ctx.arc(
          tipA.x - fx * 2 * k, tipA.y - fy * 2 * k, hr,
          ang + side * Math.PI * 0.5 - Math.PI * 0.38,
          ang + side * Math.PI * 0.5 + Math.PI * 0.38,
        );
        ctx.closePath();
        ctx.fillStyle = side > 0 ? STEEL : '#8494A6';
        ctx.fill();
        ctx.strokeStyle = outline; ctx.lineWidth = 1.5 * k; ctx.stroke();
        // 刃口高光
        ctx.beginPath();
        ctx.arc(
          tipA.x - fx * 2 * k, tipA.y - fy * 2 * k, hr * 0.86,
          ang + side * Math.PI * 0.5 - Math.PI * 0.3,
          ang + side * Math.PI * 0.5 + Math.PI * 0.3,
        );
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1 * k; ctx.stroke();
      }
      // 柄顶配重钉
      ctx.fillStyle = METAL;
      ctx.beginPath();
      ctx.arc(tipA.x, tipA.y, 2 * k, 0, Math.PI * 2);
      ctx.fill();
      // 缠柄绳
      ctx.fillStyle = '#C9A227';
      ctx.beginPath();
      ctx.arc(hand.x - fx * 3 * k, hand.y - fy * 3 * k, 1.7 * k, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    /* ── 战锤：粗柄 + 沉重方头 ── */
    case 'hammer': {
      const L = blade ? blade.len : 12 * k;
      const tipA = { x: hand.x + fx * L, y: hand.y + fy * L };
      stroke(ctx, hand.x - fx * 6 * k, hand.y - fy * 6 * k, tipA.x, tipA.y, WOOD_DARK, 3.6 * k, outline);
      // 锤头：垂直于柄的圆角矩形（沉、宽）
      const hw = 5.2 * k, hl = 4.4 * k;
      ctx.save();
      ctx.translate(tipA.x, tipA.y);
      ctx.rotate(ang);
      ctx.fillStyle = '#7A8698';
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1.4 * k;
      roundRect(ctx, -hl * 0.7, -hw, hl * 1.6, hw * 2, 1.6 * k);
      ctx.fill(); ctx.stroke();
      // 打击面高光
      ctx.fillStyle = METAL;
      ctx.fillRect(hl * 0.55, -hw * 0.82, 1.3 * k, hw * 1.64);
      ctx.restore();
      // 箍
      ctx.fillStyle = METAL;
      ctx.beginPath();
      ctx.arc(hand.x + fx * L * 0.45, hand.y + fy * L * 0.45, 1.8 * k, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    /* ── 丈二长枪：杆远超臂展（后段长出 22k、前伸 len+8k），菱形枪尖 + 杆尾 ──
     * 「林冲的枪」：真正比人还长的兵器，不是手里多根小棍 */
    case 'spear': {
      const L = blade ? blade.len : 30 * k;
      const rear = 22 * k;
      const tail = { x: hand.x - fx * rear, y: hand.y - fy * rear };
      const tipA = { x: hand.x + fx * (L + 8 * k), y: hand.y + fy * (L + 8 * k) };
      stroke(ctx, tail.x, tail.y, tipA.x, tipA.y, WOOD, 2.1 * k, outline);
      // 杆尾（青铜鐏）
      ctx.fillStyle = METAL;
      ctx.beginPath();
      ctx.arc(tail.x, tail.y, 1.7 * k, 0, Math.PI * 2);
      ctx.fill();
      // 菱形枪尖：细长（比短兵更长更锐）
      const sl = 9 * k, sw = 2.6 * k;
      ctx.beginPath();
      ctx.moveTo(tipA.x + fx * sl, tipA.y + fy * sl);
      ctx.lineTo(tipA.x + nx * sw, tipA.y + ny * sw);
      ctx.lineTo(tipA.x - fx * sl * 0.45, tipA.y - fy * sl * 0.45);
      ctx.lineTo(tipA.x - nx * sw, tipA.y - ny * sw);
      ctx.closePath();
      ctx.fillStyle = STEEL;
      ctx.fill();
      ctx.strokeStyle = outline; ctx.lineWidth = 1.2 * k; ctx.stroke();
      // 缨座（红缨本体由挂件层 tassel 画）
      ctx.fillStyle = '#B03A2E';
      ctx.beginPath();
      ctx.arc(hand.x + fx * (L - 4 * k), hand.y + fy * (L - 4 * k), 1.9 * k, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    /* ── 短弓：垂直于前臂的弓弧 + 弦；攻击时搭箭 ── */
    case 'ranger': {
      const br = 11.5 * k;
      // 弓弧：以手为圆心，开口朝后
      ctx.beginPath();
      ctx.arc(hand.x, hand.y, br, ang + Math.PI * 0.68, ang + Math.PI * 1.32);
      ctx.strokeStyle = WOOD_DARK;
      ctx.lineWidth = 2.6 * k;
      ctx.stroke();
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1 * k;
      ctx.stroke();
      // 弦：连弓弧两端
      const a0 = ang + Math.PI * 0.68, a1 = ang + Math.PI * 1.32;
      stroke(ctx,
        hand.x + Math.cos(a0) * br, hand.y + Math.sin(a0) * br,
        hand.x + Math.cos(a1) * br, hand.y + Math.sin(a1) * br,
        'rgba(240,235,220,0.85)', 0.9 * k);
      // 搭箭（有判定几何时 = 正在射击/戳击）
      if (blade) {
        stroke(ctx, hand.x - fx * 4 * k, hand.y - fy * 4 * k, tip.x, tip.y, '#8B5E3C', 1.3 * k);
        ctx.beginPath();
        ctx.moveTo(tip.x + fx * 3 * k, tip.y + fy * 3 * k);
        ctx.lineTo(tip.x - nx * 1.6 * k, tip.y - ny * 1.6 * k);
        ctx.lineTo(tip.x + nx * 1.6 * k, tip.y + ny * 1.6 * k);
        ctx.closePath();
        ctx.fillStyle = STEEL; ctx.fill();
      }
      break;
    }

    /* ── 长弓（弩手改弓手）：比游侠的短弓更大的双曲长弓，常驻在手 ── */
    case 'gunner': {
      const br = 14 * k;
      // 弓臂：两段反向曲率（recurve），比单弧短弓更「长弓」
      const a0 = ang + Math.PI * 0.62, a1 = ang + Math.PI * 1.38;
      ctx.beginPath();
      ctx.arc(hand.x + fx * 2 * k, hand.y + fy * 2 * k, br, a0 + 0.22, a0 + 0.22 + 0.66);
      ctx.arc(hand.x + fx * 2 * k, hand.y + fy * 2 * k, br, a1 - 0.66, a1 - 0.22);
      ctx.strokeStyle = WOOD_DARK; ctx.lineWidth = 2.8 * k; ctx.lineCap = 'round'; ctx.stroke();
      ctx.strokeStyle = outline; ctx.lineWidth = 1 * k; ctx.stroke();
      // 弦：连两段弓臂的末端
      const e0 = a0 + 0.22 + 0.66, e1 = a1 - 0.66;
      stroke(ctx,
        hand.x + fx * 2 * k + Math.cos(e0) * br, hand.y + fy * 2 * k + Math.sin(e0) * br,
        hand.x + fx * 2 * k + Math.cos(e1) * br, hand.y + fy * 2 * k + Math.sin(e1) * br,
        'rgba(240,235,220,0.85)', 0.9 * k);
      // 搭箭（有判定几何时）
      if (blade) {
        stroke(ctx, hand.x - fx * 5 * k, hand.y - fy * 5 * k, tip.x, tip.y, '#8B5E3C', 1.3 * k);
        ctx.beginPath();
        ctx.moveTo(tip.x + fx * 3.4 * k, tip.y + fy * 3.4 * k);
        ctx.lineTo(tip.x - nx * 1.8 * k, tip.y - ny * 1.8 * k);
        ctx.lineTo(tip.x + nx * 1.8 * k, tip.y + ny * 1.8 * k);
        ctx.closePath();
        ctx.fillStyle = STEEL; ctx.fill();
      }
      break;
    }

    /* ── 圆盾：画在前臂上（常驻）；bash 判定中心就是盾心 ── */
    case 'shield': {
      const cx = (p.elbowF.x * 0.35 + p.handF.x * 0.65);
      const cy = (p.elbowF.y * 0.35 + p.handF.y * 0.65);
      const r = 11.5 * k;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#5A6B7E';
      ctx.fill();
      ctx.strokeStyle = outline; ctx.lineWidth = 1.6 * k; ctx.stroke();
      // 内盘 + 金属盏突
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
      ctx.strokeStyle = '#8FA0B4'; ctx.lineWidth = 1.3 * k; ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = METAL; ctx.fill();
      ctx.strokeStyle = outline; ctx.lineWidth = 1 * k; ctx.stroke();
      break;
    }

    /* ── 大三角镖：双手各一枚大三角飞镖（中央握柄、刃口三边） ── */
    case 'dagger': {
      drawDart(ctx, p.handF, blade ? blade.angle : armAng, blade ? Math.max(blade.len, 10 * k) : 10 * k, k, outline);
      drawDart(ctx, p.handB, armAngB, 10 * k, k, outline);
      break;
    }

    /* ── 手里剑：手上四角星，常驻 ── */
    case 'ninja': {
      const cx = p.handF.x, cy = p.handF.y;
      const r = 3.8 * k;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = armAng + (i / 8) * Math.PI * 2;
        const rr = i % 2 === 0 ? r : r * 0.38;
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = STEEL;
      ctx.fill();
      ctx.strokeStyle = outline; ctx.lineWidth = 1 * k; ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = DARK; ctx.fill();
      break;
    }

    /* ── 链锤：只画握柄（链与刺球由挂件层 chain 画，甩出去的那截就是判定 tip=-1） ── */
    case 'flail': {
      stroke(ctx, hand.x - fx * 4 * k, hand.y - fy * 4 * k, hand.x + fx * 8 * k, hand.y + fy * 8 * k, DARK, 3 * k, outline);
      ctx.fillStyle = METAL;
      ctx.beginPath();
      ctx.arc(hand.x + fx * 8 * k, hand.y + fy * 8 * k, 1.7 * k, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
}

/* ---------- 小工具 ---------- */

function stroke(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, w: number, outline?: string) {
  if (outline) {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.strokeStyle = outline; ctx.lineWidth = w + 1.4; ctx.lineCap = 'round'; ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 武士待机：腰间斜鞘（简化版，剑客的精绘鞘在 drawFigure 专属分支里） */
function drawWaistSaya(
  ctx: CanvasRenderingContext2D,
  p: { elbowB: WeaponPt },
  facing: number,
  k: number,
  outline: string,
) {
  const a = p.elbowB;
  const ang = 0.9; // 斜向下的固定角度（腰挂鞘不跟手臂）
  const x0 = a.x - facing * 2 * k, y0 = a.y + 6 * k;
  const x1 = x0 - facing * Math.cos(ang) * 16 * k, y1 = y0 + Math.sin(ang) * 16 * k;
  stroke(ctx, x0, y0, x1, y1, '#39434E', 3.2 * k, outline);
  // 鞘口金环
  ctx.beginPath();
  ctx.arc(x0, y0, 1.4 * k, 0, Math.PI * 2);
  ctx.fillStyle = METAL; ctx.fill();
}

/** 单把大三角镖：等边三角形镖体 + 中央握柄 + 刃口高光 */
function drawDart(ctx: CanvasRenderingContext2D, hand: WeaponPt, ang: number, len: number, k: number, outline: string) {
  const fx = Math.cos(ang), fy = Math.sin(ang);
  const cx = hand.x + fx * len * 0.55, cy = hand.y + fy * len * 0.55;
  const R = len * 0.62;   // 镖体远大于旧短刀
  // 镖体：等边三角，一角朝武器方向
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = ang + (i / 3) * Math.PI * 2;
    const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = '#D8DEE6';
  ctx.fill();
  ctx.strokeStyle = outline; ctx.lineWidth = 1.2 * k; ctx.stroke();
  // 刃口高光（朝前的两条边）
  ctx.beginPath();
  for (let i = 0; i < 2; i++) {
    const a = ang + (i / 3) * Math.PI * 2;
    const x = cx + Math.cos(a) * R * 0.92, y = cy + Math.sin(a) * R * 0.92;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1 * k; ctx.stroke();
  // 中央握柄孔 + 握柄
  ctx.beginPath();
  ctx.arc(cx, cy, 1.8 * k, 0, Math.PI * 2);
  ctx.fillStyle = DARK; ctx.fill();
  stroke(ctx, hand.x, hand.y, cx, cy, METAL, 1.6 * k);
}
