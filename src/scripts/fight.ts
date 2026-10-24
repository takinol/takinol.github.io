/**
 * 首页「小人打架」—— 骨骼动画版
 *
 * 做法参考开源项目的通用思路（Cani2D / Axis 火柴人关键帧 / HumanSkeletonJS 层级骨架）：
 *   1. 骨架是一棵层级树：骨盆 → 胸腔 → 头；胸腔 → 上臂 → 前臂 → 手；骨盆 → 大腿 → 小腿 → 脚
 *   2. 每一帧的动作 = 一组「关节角度」(Pose)
 *   3. 一套动作 = 若干关键帧 Pose，按时间在关键帧之间插值 → 正向运动学(FK)算出各关节坐标
 *   4. 倒地不再手写旋转，而是把当前所有关节点转成 Verlet 粒子 + 骨骼距离约束，
 *      丢给简易物理模拟 —— 这样人是「瘫倒」而不是「整体转一下」
 */

export interface Pose {
  lean: number; // 躯干前倾（+ 为朝面向方向）
  head: number; // 头相对躯干
  armUB: number; // 后手上臂
  armLB: number; // 后手前臂（相对上臂）
  armUF: number; // 前手上臂
  armLF: number; // 前手前臂
  legUB: number;
  legLB: number;
  legUF: number;
  legLF: number;
  lift: number; // 整体离地高度（+ 为腾空）
}

interface Key {
  t: number; // 0~1
  pose: Pose;
}

interface Clip {
  dur: number;
  loop: boolean;
  keys: Key[];
}

/** 骨骼长度（像素），整体身高约 56 */
const L = {
  spine: 15,
  neck: 3,
  headR: 6.5,
  upperArm: 9,
  foreArm: 9,
  thigh: 12,
  shin: 12,
};

const TAU = Math.PI * 2;
const P = (p: Partial<Pose>): Pose => ({
  lean: 0,
  head: 0,
  armUB: 0,
  armLB: 0,
  armUF: 0,
  armLF: 0,
  legUB: 0,
  legLB: 0,
  legUF: 0,
  legLF: 0,
  lift: 0,
  ...p,
});

/* ---------------- 姿势库 ---------------- */

// 站立待机
const IDLE = P({ lean: 0.04, armUB: 0.16, armLB: 0.2, armUF: -0.12, armLF: 0.24, legUB: -0.1, legLB: 0.06, legUF: 0.1, legLF: 0.03 });
// 待机呼吸（另一帧）
const IDLE2 = P({ lean: 0.07, head: -0.04, armUB: 0.21, armLB: 0.24, armUF: -0.07, armLF: 0.28, legUB: -0.08, legLB: 0.05, legUF: 0.08, legLF: 0.04 });

// 格斗架势
const GUARD = P({ lean: 0.14, head: -0.05, armUB: 1.0, armLB: 1.75, armUF: 1.05, armLF: 1.7, legUB: -0.26, legLB: 0.16, legUF: 0.3, legLF: 0.1 });

// 直拳（前手）：蓄力 → 出拳 → 收拳
const JAB_WIND = P({ lean: 0.1, head: -0.05, armUB: 1.05, armLB: 1.85, armUF: 0.75, armLF: 2.0, legUB: -0.24, legLB: 0.16, legUF: 0.3, legLF: 0.08 });
const JAB_HIT = P({ lean: 0.24, head: -0.02, armUB: 0.85, armLB: 2.0, armUF: 1.55, armLF: 0.04, legUB: -0.34, legLB: 0.2, legUF: 0.42, legLF: 0.06 });

// 后手重拳（配合身体转动）
const CROSS_WIND = P({ lean: -0.02, head: -0.06, armUB: 0.6, armLB: 2.15, armUF: 1.0, armLF: 1.75, legUB: -0.2, legLB: 0.14, legUF: 0.26, legLF: 0.1 });
const CROSS_HIT = P({ lean: 0.34, head: 0.04, armUB: 1.5, armLB: 0.06, armUF: 0.55, armLF: 1.95, legUB: -0.4, legLB: 0.24, legUF: 0.46, legLF: 0.05 });

// 前踢：抬腿 → 踢出
const KICK_UP = P({ lean: -0.16, head: -0.04, armUB: 0.7, armLB: 1.6, armUF: 0.9, armLF: 1.4, legUB: 0.12, legLB: 0.02, legUF: 1.0, legLF: -1.5 });
const KICK_HIT = P({ lean: -0.34, head: -0.06, armUB: 0.2, armLB: 1.2, armUF: 0.4, armLF: 1.1, legUB: 0.16, legLB: 0.04, legUF: 1.5, legLF: 0.02 });

// 受击
const HURT = P({ lean: -0.3, head: -0.55, armUB: -0.5, armLB: 0.7, armUF: -0.75, armLF: 0.9, legUB: -0.3, legLB: 0.24, legUF: 0.26, legLF: 0.12 });

// 起跳：下蹲 → 蹬地 → 空中收腿 → 落地
const JUMP_CROUCH = P({ lean: 0.3, head: -0.1, armUB: -0.6, armLB: 0.7, armUF: -0.7, armLF: 0.8, legUB: 0.58, legLB: -1.25, legUF: 0.54, legLF: -1.5 });
const JUMP_UP = P({ lean: 0.06, head: 0.06, armUB: 1.7, armLB: 0.15, armUF: 1.85, armLF: 0.1, legUB: -0.06, legLB: 0.02, legUF: 0.08, legLF: 0.02, lift: 30 });
const JUMP_TUCK = P({ lean: 0.12, head: 0.04, armUB: 1.35, armLB: 0.5, armUF: 1.5, armLF: 0.45, legUB: 0.85, legLB: -1.3, legUF: 1.0, legLF: -1.45, lift: 34 });
const JUMP_LAND = P({ lean: 0.36, head: -0.12, armUB: -0.5, armLB: 0.9, armUF: -0.6, armLF: 1.0, legUB: 0.66, legLB: -1.35, legUF: 0.6, legLF: -1.5 });

const CLIPS: Record<string, Clip> = {
  idle: { dur: 2.6, loop: true, keys: [{ t: 0, pose: IDLE }, { t: 0.5, pose: IDLE2 }, { t: 1, pose: IDLE }] },
  guard: { dur: 0.18, loop: false, keys: [{ t: 0, pose: IDLE }, { t: 1, pose: GUARD }] },
  jab: {
    dur: 0.46,
    loop: false,
    keys: [
      { t: 0, pose: GUARD },
      { t: 0.3, pose: JAB_WIND },
      { t: 0.52, pose: JAB_HIT },
      { t: 0.68, pose: JAB_HIT },
      { t: 1, pose: GUARD },
    ],
  },
  cross: {
    dur: 0.56,
    loop: false,
    keys: [
      { t: 0, pose: GUARD },
      { t: 0.32, pose: CROSS_WIND },
      { t: 0.56, pose: CROSS_HIT },
      { t: 0.72, pose: CROSS_HIT },
      { t: 1, pose: GUARD },
    ],
  },
  kick: {
    dur: 0.62,
    loop: false,
    keys: [
      { t: 0, pose: GUARD },
      { t: 0.34, pose: KICK_UP },
      { t: 0.52, pose: KICK_HIT },
      { t: 0.66, pose: KICK_HIT },
      { t: 1, pose: GUARD },
    ],
  },
  hurt: { dur: 0.34, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.25, pose: HURT }, { t: 1, pose: GUARD }] },
  jump: {
    dur: 0.86,
    loop: false,
    keys: [
      { t: 0, pose: GUARD },
      { t: 0.18, pose: JUMP_CROUCH },
      { t: 0.42, pose: JUMP_UP },
      { t: 0.66, pose: JUMP_TUCK },
      { t: 0.84, pose: JUMP_LAND },
      { t: 1, pose: GUARD },
    ],
  },
};

// 攻击动作在「命中时刻」的进度（用于结算伤害）
const HIT_AT: Record<string, number> = { jab: 0.52, cross: 0.56, kick: 0.52 };

/* ---------------- 正向运动学 ---------------- */

interface Pts {
  pelvis: { x: number; y: number };
  chest: { x: number; y: number };
  head: { x: number; y: number };
  elbowB: { x: number; y: number };
  handB: { x: number; y: number };
  elbowF: { x: number; y: number };
  handF: { x: number; y: number };
  kneeB: { x: number; y: number };
  footB: { x: number; y: number };
  kneeF: { x: number; y: number };
  footF: { x: number; y: number };
}

const fk = (p: Pose): Pts => {
  const chest = { x: Math.sin(p.lean) * L.spine, y: -Math.cos(p.lean) * L.spine };
  const headAng = p.lean + p.head;
  const head = {
    x: chest.x + Math.sin(headAng) * (L.neck + L.headR),
    y: chest.y - Math.cos(headAng) * (L.neck + L.headR),
  };
  const arm = (u: number, f: number) => {
    const a1 = p.lean * 0.35 + u;
    const elbow = { x: chest.x + Math.sin(a1) * L.upperArm, y: chest.y + Math.cos(a1) * L.upperArm };
    const a2 = a1 + f;
    const hand = { x: elbow.x + Math.sin(a2) * L.foreArm, y: elbow.y + Math.cos(a2) * L.foreArm };
    return { elbow, hand };
  };
  const leg = (u: number, f: number) => {
    const knee = { x: Math.sin(u) * L.thigh, y: Math.cos(u) * L.thigh };
    const a2 = u + f;
    const foot = { x: knee.x + Math.sin(a2) * L.shin, y: knee.y + Math.cos(a2) * L.shin };
    return { knee, foot };
  };
  const b = arm(p.armUB, p.armLB);
  const f2 = arm(p.armUF, p.armLF);
  const lb = leg(p.legUB, p.legLB);
  const lf = leg(p.legUF, p.legLF);
  return {
    pelvis: { x: 0, y: 0 },
    chest,
    head,
    elbowB: b.elbow,
    handB: b.hand,
    elbowF: f2.elbow,
    handF: f2.hand,
    kneeB: lb.knee,
    footB: lb.foot,
    kneeF: lf.knee,
    footF: lf.foot,
  };
};

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpPose = (a: Pose, b: Pose, k: number): Pose => ({
  lean: lerp(a.lean, b.lean, k),
  head: lerp(a.head, b.head, k),
  armUB: lerp(a.armUB, b.armUB, k),
  armLB: lerp(a.armLB, b.armLB, k),
  armUF: lerp(a.armUF, b.armUF, k),
  armLF: lerp(a.armLF, b.armLF, k),
  legUB: lerp(a.legUB, b.legUB, k),
  legLB: lerp(a.legLB, b.legLB, k),
  legUF: lerp(a.legUF, b.legUF, k),
  legLF: lerp(a.legLF, b.legLF, k),
  lift: lerp(a.lift, b.lift, k),
});

const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const easeOutBack = (k: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2);
};

const sampleClip = (clip: Clip, t: number): Pose => {
  const tt = clip.loop ? t % 1 : Math.min(0.9999, Math.max(0, t));
  const keys = clip.keys;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (tt >= a.t && tt <= b.t) {
      const span = b.t - a.t || 1;
      const k = (tt - a.t) / span;
      // 攻击帧用 easeOutBack 让出拳更「脆」
      const e = b.pose === JAB_HIT || b.pose === CROSS_HIT || b.pose === KICK_HIT ? easeOutBack(k) : easeInOut(k);
      return lerpPose(a.pose, b.pose, e);
    }
  }
  return keys[keys.length - 1].pose;
};

/* ---------------- 物理倒地（Verlet + 距离约束） ---------------- */

interface RP {
  x: number;
  y: number;
  px: number;
  py: number;
}

const RIG_LINKS: [string, string][] = [
  ['pelvis', 'chest'],
  ['chest', 'head'],
  ['chest', 'elbowB'],
  ['elbowB', 'handB'],
  ['chest', 'elbowF'],
  ['elbowF', 'handF'],
  ['pelvis', 'kneeB'],
  ['kneeB', 'footB'],
  ['pelvis', 'kneeF'],
  ['kneeF', 'footF'],
  // 稳定用的软约束，避免整个人瘫成一团
  ['chest', 'kneeB'],
  ['chest', 'kneeF'],
];

/* ---------------- 主体 ---------------- */

export function initFightBand(): void {
  const canvas = document.getElementById('fight-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COLORS = ['#DD0100', '#225095', '#FAC901', '#DE0C62', '#9ACD32', '#FB923C'];
  const rand = (a: number, b: number) => a + Math.random() * (b - a);

  type State = 'idle' | 'jab' | 'cross' | 'kick' | 'hurt' | 'jump' | 'ko';

  interface Fighter {
    x: number;
    dir: number;
    color: string;
    hp: number;
    maxHp: number;
    state: State;
    clipT: number;
    clipDur: number;
    pose: Pose;
    didHit: boolean;
    knock: number;
    flash: number;
    cool: number;
    koTime: number;
    ragdoll: Record<string, RP> | null;
    links: { a: string; b: string; len: number }[];
    partner: number;
    phase: number;
  }

  interface Spark {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    max: number;
    color: string;
  }

  let W = 0;
  let H = 0;
  let fighters: Fighter[] = [];
  let sparks: Spark[] = [];
  let shake = 0;
  let rafId = 0;
  let last = 0;
  let visible = true;

  const groundY = () => H - 16;

  const newFighter = (i: number): Fighter => ({
    x: 0,
    dir: 1,
    color: COLORS[i % COLORS.length],
    hp: 100,
    maxHp: 100,
    state: 'idle',
    clipT: 0,
    clipDur: CLIPS.idle.dur,
    pose: { ...IDLE },
    didHit: false,
    knock: 0,
    flash: 0,
    cool: rand(0.6, 2.2),
    koTime: 0,
    ragdoll: null,
    links: [],
    partner: i % 2 === 0 ? i + 1 : i - 1,
    phase: rand(0, 10),
  });

  const makeFighters = (count: number) => {
    fighters = [];
    for (let i = 0; i < count; i++) fighters.push(newFighter(i));
    if (count % 2 !== 0) fighters[count - 1].partner = -1;
  };

  const layout = () => {
    const n = fighters.length;
    const pairs = Math.max(1, Math.floor(n / 2));
    const slot = W / pairs;
    for (let p = 0; p < pairs; p++) {
      const cx = slot * (p + 0.5);
      const gap = Math.min(92, slot * 0.4);
      const a = fighters[p * 2];
      const b = fighters[p * 2 + 1];
      if (a) {
        a.x = cx - gap / 2;
        a.dir = 1;
      }
      if (b) {
        b.x = cx + gap / 2;
        b.dir = -1;
      }
    }
    if (n % 2 === 1) {
      fighters[n - 1].x = W - 40;
      fighters[n - 1].dir = -1;
    }
  };

  const spawnSpark = (x: number, y: number, color: string, n = 7) => {
    for (let i = 0; i < n; i++) {
      const a = rand(-Math.PI, Math.PI);
      const sp = rand(50, 170);
      sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 50, life: 0, max: rand(0.2, 0.45), color });
    }
  };

  const playClip = (f: Fighter, name: string) => {
    const clip = CLIPS[name];
    if (!clip) return;
    f.state = name as State;
    f.clipT = 0;
    f.clipDur = clip.dur;
    f.didHit = false;
  };

  // 把当前姿势转成 Verlet 粒子，进入瘫倒状态
  const startRagdoll = (f: Fighter) => {
    const pts = fk(f.pose);
    const base = groundPose(f, pts);
    const map: Record<string, RP> = {};
    for (const k of Object.keys(pts) as (keyof Pts)[]) {
      const w = base[k];
      map[k] = { x: w.x, y: w.y, px: w.x - f.dir * 1.6, py: w.y - 1.2 };
    }
    const links = RIG_LINKS.map(([a, b]) => ({
      a,
      b,
      len: Math.hypot(map[a].x - map[b].x, map[a].y - map[b].y),
    }));
    f.ragdoll = map;
    f.links = links;
    f.state = 'ko';
    f.koTime = 0;
  };

  // 计算某个姿势在世界坐标下的各关节位置
  // 注意：lift（腾空高度）属于 Pose，不在 FK 结果里，要从 f.pose 取
  const groundPose = (f: Fighter, pts: Pts) => {
    const lowest = Math.max(pts.footB.y, pts.footF.y);
    const dy = groundY() - lowest - (f.pose.lift || 0);
    const out = {} as Record<keyof Pts, { x: number; y: number }>;
    for (const k of Object.keys(pts) as (keyof Pts)[]) {
      const p = pts[k];
      out[k] = { x: f.x + f.dir * p.x + f.knock, y: dy + p.y };
    }
    return out;
  };

  const stepRagdoll = (f: Fighter, dt: number) => {
    const rd = f.ragdoll;
    if (!rd) return;
    const g = 1500;
    const damp = 0.992;
    for (const k of Object.keys(rd)) {
      const p = rd[k];
      const vx = (p.x - p.px) * damp;
      const vy = (p.y - p.py) * damp;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + g * dt * dt;
    }
    // 距离约束迭代
    for (let iter = 0; iter < 5; iter++) {
      for (const l of f.links) {
        const a = rd[l.a];
        const b = rd[l.b];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.0001;
        const diff = ((d - l.len) / d) * 0.5;
        a.x += dx * diff;
        a.y += dy * diff;
        b.x -= dx * diff;
        b.y -= dy * diff;
      }
      // 地面碰撞
      const gy = groundY();
      for (const k of Object.keys(rd)) {
        const p = rd[k];
        if (p.y > gy) {
          p.y = gy;
          // 摩擦
          p.px = p.x + (p.px - p.x) * 0.55;
        }
      }
    }
  };

  const update = (dt: number) => {
    for (const f of fighters) {
      f.knock *= 0.85;
      f.flash = Math.max(0, f.flash - dt * 5);

      if (f.state === 'ko') {
        f.koTime += dt;
        stepRagdoll(f, dt);
        if (f.koTime > 2.4) {
          // 复活：满血站起
          f.hp = f.maxHp;
          f.ragdoll = null;
          f.state = 'idle';
          f.clipT = 0;
          f.clipDur = CLIPS.idle.dur;
          f.pose = { ...IDLE };
          f.cool = rand(0.7, 1.8);
        }
        continue;
      }

      f.clipT += dt;
      const clip = CLIPS[f.state] ?? CLIPS.idle;
      const prog = f.clipDur > 0 ? f.clipT / f.clipDur : 1;
      const target = sampleClip(clip, prog);

      // 高速率插值：既保留动作力度，又不会跳帧
      const k = 1 - Math.exp(-dt * 32);
      f.pose = lerpPose(f.pose, target, k);

      // 命中结算
      const hitAt = HIT_AT[f.state];
      if (hitAt !== undefined && !f.didHit && prog >= hitAt) {
        f.didHit = true;
        const tgt = fighters[f.partner];
        if (tgt && tgt.state !== 'ko') {
          const dmg = Math.round(rand(9, 18) * (f.state === 'cross' ? 1.3 : 1));
          tgt.hp = Math.max(0, tgt.hp - dmg);
          tgt.flash = 1;
          tgt.knock = f.dir * 8;
          shake = f.state === 'kick' ? 5 : 4;
          const pts = fk(tgt.pose);
          const wp = groundPose(tgt, pts);
          const at = f.state === 'kick' ? wp.kneeF : wp.chest;
          spawnSpark(at.x, at.y - 4, tgt.color);
          if (tgt.hp <= 0) {
            spawnSpark(at.x, at.y - 4, '#FAC901', 12);
            startRagdoll(tgt);
            continue;
          }
          playClip(tgt, 'hurt');
        }
      }

      // 动作结束回到待机
      if (!clip.loop && prog >= 1) {
        f.state = 'idle';
        f.clipT = 0;
        f.clipDur = CLIPS.idle.dur;
        f.didHit = false;
        f.cool = rand(0.5, 1.6);
      }

      // 待机时决定下一步干什么
      if (f.state === 'idle') {
        f.cool -= dt;
        if (f.cool <= 0) {
          const tgt = fighters[f.partner];
          if (!tgt || tgt.state === 'ko') {
            f.cool = rand(0.4, 1.0);
          } else {
            const r = Math.random();
            playClip(f, r < 0.45 ? 'jab' : r < 0.8 ? 'cross' : r < 0.92 ? 'kick' : 'jump');
          }
        }
      }
    }

    for (const s of sparks) {
      s.life += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 340 * dt;
    }
    sparks = sparks.filter((s) => s.life < s.max);
    shake *= 0.84;
  };

  /* ---------------- 绘制 ---------------- */

  const seg = (a: { x: number; y: number }, b: { x: number; y: number }, w: number) => {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = w;
    ctx.stroke();
  };

  const dot = (p: { x: number; y: number }, r: number) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.fill();
  };

  const drawBody = (pts: Record<string, { x: number; y: number }>, color: string, faceDir: number) => {
    const dark = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = dark;
    ctx.fillStyle = dark;

    // 后侧手脚：稍淡一点，形成前后层次
    ctx.globalAlpha *= 0.65;
    seg(pts.pelvis, pts.kneeB, 4.5);
    seg(pts.kneeB, pts.footB, 4.5);
    dot(pts.footB, 2.6);
    seg(pts.chest, pts.elbowB, 4.2);
    seg(pts.elbowB, pts.handB, 4.2);
    dot(pts.handB, 2.6);

    ctx.globalAlpha /= 0.65;

    // 躯干 + 头
    seg(pts.pelvis, pts.chest, 6);
    ctx.beginPath();
    ctx.arc(pts.head.x, pts.head.y, L.headR, 0, TAU);
    ctx.fill();
    // 眼睛（朝面向方向）
    ctx.save();
    ctx.globalAlpha *= 0.9;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    dot({ x: pts.head.x + faceDir * 2.4, y: pts.head.y - 1.4 }, 1.9);
    ctx.restore();
    ctx.fillStyle = dark;

    // 前侧手脚
    seg(pts.chest, pts.elbowF, 4.6);
    seg(pts.elbowF, pts.handF, 4.6);
    dot(pts.handF, 2.9);
    seg(pts.pelvis, pts.kneeF, 5);
    seg(pts.kneeF, pts.footF, 5);
    dot(pts.footF, 3);
  };

  const drawFighter = (f: Fighter) => {
    const color = f.flash > 0.2 ? '#FFFFFF' : f.color;

    // 影子
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    const sx = f.x + f.knock;
    ctx.ellipse(sx, groundY() + 2, 13, 3.2, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.save();
    if (f.state === 'ko' && f.ragdoll) {
      const rd = f.ragdoll;
      const world: Record<string, { x: number; y: number }> = {};
      for (const k of Object.keys(rd)) world[k] = { x: rd[k].x, y: rd[k].y };
      drawBody(world, color, f.dir);
    } else {
      const pts = fk(f.pose);
      const world = groundPose(f, pts);
      drawBody(world, color, f.dir);
    }
    ctx.restore();

    // 血条
    if (f.state !== 'ko') {
      const bw = 24;
      const bx = f.x + f.knock - bw / 2;
      const by = groundY() - 76;
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(bx, by, bw, 3);
      ctx.fillStyle = f.hp > 40 ? f.color : '#DD0100';
      ctx.fillRect(bx, by, (bw * f.hp) / f.maxHp, 3);
    }
  };

  const render = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dpr = canvas.width / Math.max(1, W);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (shake > 0.2) ctx.translate(rand(-shake, shake) * 0.4, rand(-shake, shake) * 0.4);

    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, groundY() + 0.5);
    ctx.lineTo(W, groundY() + 0.5);
    ctx.stroke();

    // 同一排站在一条地面线上，按从左到右的顺序绘制即可
    fighters.forEach(drawFighter);

    for (const s of sparks) {
      ctx.globalAlpha = Math.max(0, 1 - s.life / s.max);
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x - 1.5, s.y - 1.5, 3.4, 3.4);
    }
    ctx.globalAlpha = 1;
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const want = W < 640 ? 2 : 4;
    if (fighters.length !== want) makeFighters(want);
    layout();
    render();
  };

  const loop = (ts: number) => {
    rafId = requestAnimationFrame(loop);
    if (!last) last = ts;
    const dt = Math.min(0.05, (ts - last) / 1000);
    last = ts;
    if (!visible || reduceMotion) return;
    update(dt);
    render();
  };

  resize();
  window.addEventListener('resize', () => {
    window.clearTimeout((window as any).__fightResize);
    (window as any).__fightResize = window.setTimeout(resize, 150);
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((e) => (visible = e[0]?.isIntersecting ?? true), { threshold: 0 }).observe(canvas);
  }
  if (!reduceMotion) rafId = requestAnimationFrame(loop);
  window.addEventListener('pagehide', () => cancelAnimationFrame(rafId));
}
