/**
 * 首页「小人打架」—— 骨骼动画 + 空间命中 + 自主战斗
 *
 * 设计要点（对应上一版的问题）：
 *   1. 造型：不再是细线火柴人，改用锥形胶囊四肢 + 描边 + 头发/拳头/脚掌细节
 *   2. 命中：不是"隔空扣血"。出拳时用 FK 算出拳头真实世界坐标，
 *      只有在拳头真正碰到对手躯干时才判定命中；够不着就是挥空（whiff）
 *   3. 交互：被打的一方有 block 格挡 / hurtLight 轻击后仰 / hurtHeavy 重击弯腰 /
 *      knockdown 倒地 / getup 起身 一整套反应，且被打会真的被击退
 *   4. 自主：每个小人由 BehaviourController 做决策（进退/进攻/格挡/闪避），
 *      不再是固定轮流出手
 *   5. 接口：window.takinolFight.setController(fn) 可把决策交给外部（将来接 AI API）。
 *      默认用本地启发式 AI；只有页面真的被人看到时才跑（IntersectionObserver + 标签页可见性）
 */

/* ============================================================
 * 1. 骨架定义
 * ============================================================ */

const L = {
  spine: 17,
  neck: 2,
  headR: 7.5,
  upperArm: 10.5,
  foreArm: 10.5,
  thigh: 14,
  shin: 14,
};

const TAU = Math.PI * 2;

export interface Pose {
  lean: number;
  head: number;
  armUB: number;
  armLB: number;
  armUF: number;
  armLF: number;
  legUB: number;
  legLB: number;
  legUF: number;
  legLF: number;
  lift: number;
}

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

interface Pt {
  x: number;
  y: number;
}

export interface Joints {
  pelvis: Pt;
  chest: Pt;
  head: Pt;
  shoulderB: Pt;
  elbowB: Pt;
  handB: Pt;
  shoulderF: Pt;
  elbowF: Pt;
  handF: Pt;
  hipB: Pt;
  kneeB: Pt;
  footB: Pt;
  hipF: Pt;
  kneeF: Pt;
  footF: Pt;
}

/** 正向运动学：由关节角度算出各关节点坐标（骨盆在原点，y 向下为正） */
export const fk = (p: Pose): Joints => {
  const sl = Math.sin(p.lean);
  const cl = Math.cos(p.lean);
  const chest: Pt = { x: sl * L.spine, y: -cl * L.spine };
  const headAng = p.lean + p.head;
  const head: Pt = {
    x: chest.x + Math.sin(headAng) * (L.neck + L.headR),
    y: chest.y - Math.cos(headAng) * (L.neck + L.headR),
  };
  // 肩膀垂直于脊柱方向偏移一点，形成前后层次
  const px = cl * 2.6;
  const py = sl * 2.6;
  const shoulderF: Pt = { x: chest.x + px, y: chest.y + py };
  const shoulderB: Pt = { x: chest.x - px, y: chest.y - py };
  const hipF: Pt = { x: cl * 3, y: sl * 3 };
  const hipB: Pt = { x: -cl * 3, y: -sl * 3 };

  const arm = (s: Pt, u: number, f: number) => {
    const a1 = p.lean * 0.3 + u;
    const elbow: Pt = { x: s.x + Math.sin(a1) * L.upperArm, y: s.y + Math.cos(a1) * L.upperArm };
    const a2 = a1 + f;
    const hand: Pt = { x: elbow.x + Math.sin(a2) * L.foreArm, y: elbow.y + Math.cos(a2) * L.foreArm };
    return { elbow, hand };
  };
  const leg = (hip: Pt, u: number, f: number) => {
    const knee: Pt = { x: hip.x + Math.sin(u) * L.thigh, y: hip.y + Math.cos(u) * L.thigh };
    const a2 = u + f;
    const foot: Pt = { x: knee.x + Math.sin(a2) * L.shin, y: knee.y + Math.cos(a2) * L.shin };
    return { knee, foot };
  };

  const b = arm(shoulderB, p.armUB, p.armLB);
  const f2 = arm(shoulderF, p.armUF, p.armLF);
  const lb = leg(hipB, p.legUB, p.legLB);
  const lf = leg(hipF, p.legUF, p.legLF);

  return {
    pelvis: { x: 0, y: 0 },
    chest,
    head,
    shoulderB,
    elbowB: b.elbow,
    handB: b.hand,
    shoulderF,
    elbowF: f2.elbow,
    handF: f2.hand,
    hipB,
    kneeB: lb.knee,
    footB: lb.foot,
    hipF,
    kneeF: lf.knee,
    footF: lf.foot,
  };
};

/* ============================================================
 * 2. 姿势库
 * ============================================================ */

const IDLE_A = P({ lean: 0.05, armUB: 0.2, armLB: 0.35, armUF: -0.15, armLF: 0.3, legUB: -0.12, legLB: 0.1, legUF: 0.12, legLF: 0.05 });
const IDLE_B = P({ lean: 0.09, head: -0.05, armUB: 0.26, armLB: 0.4, armUF: -0.09, armLF: 0.35, legUB: -0.09, legLB: 0.08, legUF: 0.09, legLF: 0.06 });

/** 格斗架势：双手抬起护住面门 */
const GUARD = P({ lean: 0.15, head: -0.06, armUB: 1.0, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legLB: 0.2, legUF: 0.34, legLF: 0.12 });

/** 格挡：双臂抬高收紧 */
const BLOCK = P({ lean: -0.05, head: 0.12, armUB: 1.35, armLB: 2.3, armUF: 1.4, armLF: 2.35, legUB: -0.34, legLB: 0.26, legUF: 0.36, legLF: 0.14 });

const JAB_WIND = P({ lean: 0.1, head: -0.06, armUB: 1.05, armLB: 2.0, armUF: 0.72, armLF: 2.15, legUB: -0.28, legLB: 0.2, legUF: 0.32, legLF: 0.1 });
const JAB_HIT = P({ lean: 0.3, head: -0.02, armUB: 0.9, armLB: 2.05, armUF: 1.62, armLF: 0.0, legUB: -0.42, legLB: 0.26, legUF: 0.5, legLF: 0.04 });

const CROSS_WIND = P({ lean: -0.04, head: -0.07, armUB: 0.55, armLB: 2.3, armUF: 1.05, armLF: 1.9, legUB: -0.22, legLB: 0.16, legUF: 0.28, legLF: 0.12 });
const CROSS_HIT = P({ lean: 0.42, head: 0.05, armUB: 1.62, armLB: 0.02, armUF: 0.52, armLF: 1.95, legUB: -0.5, legLB: 0.3, legUF: 0.56, legLF: 0.02 });

const KICK_UP = P({ lean: -0.2, head: -0.05, armUB: 0.75, armLB: 1.7, armUF: 0.95, armLF: 1.5, legUB: 0.14, legLB: 0.02, legUF: 1.05, legLF: -1.55 });
const KICK_HIT = P({ lean: -0.4, head: -0.08, armUB: 0.2, armLB: 1.3, armUF: 0.45, armLF: 1.2, legUB: 0.18, legLB: 0.04, legUF: 1.58, legLF: 0.02 });

/** 轻击后仰：头猛地一甩 */
const HURT_LIGHT = P({ lean: -0.28, head: -0.6, armUB: -0.45, armLB: 0.9, armUF: -0.7, armLF: 1.05, legUB: -0.34, legLB: 0.28, legUF: 0.3, legLF: 0.14 });
/** 重击：弓身缩起来 */
const HURT_HEAVY = P({ lean: 0.45, head: 0.5, armUB: 0.35, armLB: 1.6, armUF: 0.15, armLF: 1.75, legUB: 0.3, legLB: -0.55, legUF: 0.42, legLF: -0.7 });

const JUMP_CROUCH = P({ lean: 0.34, head: -0.12, armUB: -0.65, armLB: 0.8, armUF: -0.75, armLF: 0.9, legUB: 0.62, legLB: -1.35, legUF: 0.58, legLF: -1.6 });
const JUMP_AIR = P({ lean: 0.1, head: 0.08, armUB: 1.6, armLB: 0.3, armUF: 1.75, armLF: 0.25, legUB: 0.8, legLB: -1.3, legUF: 0.95, legLF: -1.45, lift: 30 });
const JUMP_LAND = P({ lean: 0.4, head: -0.14, armUB: -0.55, armLB: 0.95, armUF: -0.65, armLF: 1.05, legUB: 0.7, legLB: -1.45, legUF: 0.64, legLF: -1.6 });

/** 起身：跪姿 → 站起 */
const GETUP_KNEEL = P({ lean: 0.55, head: 0.15, armUB: 0.7, armLB: 1.4, armUF: 0.9, armLF: 1.2, legUB: 1.5, legLB: -2.4, legUF: 0.35, legLF: -1.5 });

interface Clip {
  dur: number;
  loop: boolean;
  keys: { t: number; pose: Pose }[];
}

const CLIPS: Record<string, Clip> = {
  idle: { dur: 2.4, loop: true, keys: [{ t: 0, pose: IDLE_A }, { t: 0.5, pose: IDLE_B }, { t: 1, pose: IDLE_A }] },
  guard: { dur: 0.16, loop: false, keys: [{ t: 0, pose: IDLE_A }, { t: 1, pose: GUARD }] },
  block: { dur: 0.16, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 1, pose: BLOCK }] },
  jab: { dur: 0.42, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.28, pose: JAB_WIND }, { t: 0.5, pose: JAB_HIT }, { t: 0.64, pose: JAB_HIT }, { t: 1, pose: GUARD }] },
  cross: { dur: 0.54, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: CROSS_WIND }, { t: 0.54, pose: CROSS_HIT }, { t: 0.7, pose: CROSS_HIT }, { t: 1, pose: GUARD }] },
  kick: { dur: 0.6, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.32, pose: KICK_UP }, { t: 0.5, pose: KICK_HIT }, { t: 0.62, pose: KICK_HIT }, { t: 1, pose: GUARD }] },
  hurtLight: { dur: 0.32, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.22, pose: HURT_LIGHT }, { t: 1, pose: GUARD }] },
  hurtHeavy: { dur: 0.52, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.25, pose: HURT_HEAVY }, { t: 1, pose: GUARD }] },
  jump: { dur: 0.8, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.16, pose: JUMP_CROUCH }, { t: 0.4, pose: JUMP_AIR }, { t: 0.64, pose: JUMP_AIR }, { t: 0.82, pose: JUMP_LAND }, { t: 1, pose: GUARD }] },
  getup: { dur: 0.62, loop: false, keys: [{ t: 0, pose: GETUP_KNEEL }, { t: 1, pose: IDLE_A }] },
};

/** 招式命中判定的进度（0~1）与伤害 */
const ATTACKS: Record<string, { hitAt: number; dmg: [number, number]; reach: number }> = {
  jab: { hitAt: 0.5, dmg: [7, 12], reach: 1 },
  cross: { hitAt: 0.54, dmg: [12, 19], reach: 1.05 },
  kick: { hitAt: 0.5, dmg: [14, 22], reach: 1.25 },
};

const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const easeOutBack = (k: number) => 1 + 2.7 * Math.pow(k - 1, 3) + 1.7 * Math.pow(k - 1, 2);

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

const sampleClip = (clip: Clip, t: number): Pose => {
  const tt = clip.loop ? ((t % 1) + 1) % 1 : Math.min(0.9999, Math.max(0, t));
  const keys = clip.keys;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (tt >= a.t && tt <= b.t) {
      const span = b.t - a.t || 1;
      const k = (tt - a.t) / span;
      const punchy = b.pose === JAB_HIT || b.pose === CROSS_HIT || b.pose === KICK_HIT;
      return lerpPose(a.pose, b.pose, punchy ? easeOutBack(k) : easeInOut(k));
    }
  }
  return keys[keys.length - 1].pose;
};

/** 走路：用相位生成真实的迈步（前后腿反相摆动） */
const walkPose = (phase: number, speed = 1): Pose => {
  const s = Math.sin(phase * TAU);
  const c = Math.cos(phase * TAU);
  return P({
    lean: 0.12 + Math.abs(s) * 0.04,
    head: -0.04,
    armUB: 0.35 - s * 0.5 * speed,
    armLB: 0.9,
    armUF: 0.9 + s * 0.35 * speed,
    armLF: 1.5,
    legUB: -s * 0.62 * speed,
    legLB: 0.25 + Math.max(0, -c) * 0.75,
    legUF: s * 0.62 * speed,
    legLF: 0.25 + Math.max(0, c) * 0.75,
  });
};

/* ============================================================
 * 3. 行为决策（自主 AI，可被外部替换）
 * ============================================================ */

export type Decision = 'approach' | 'retreat' | 'jab' | 'cross' | 'kick' | 'jump' | 'block' | 'wait';

export interface FightSnapshot {
  self: { hp: number; x: number; state: string; distance: number };
  opponent: { hp: number; x: number; state: string; windingUp: boolean };
}

export type FightController = (snap: FightSnapshot) => Decision | null;

let externalController: FightController | null = null;

/** 供将来接 AI：window.takinolFight.setController(fn) */
export function setController(fn: FightController | null): void {
  externalController = fn;
}

/* ============================================================
 * 4. 引擎
 * ============================================================ */

const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Root {
  x: number;
  vx: number;
  facing: number;
  scale: number;
  top: number; // 头顶相对骨盆的高度（造型相关）
}

export function initFightBand(): void {
  const canvas = document.getElementById('fight-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SKINS = [
    { body: '#DD0100', trim: '#FFF1EA', dark: '#8E0000' },
    { body: '#225095', trim: '#E9F1FF', dark: '#12305C' },
    { body: '#FAC901', trim: '#3A2E00', dark: '#B08D00' },
    { body: '#DE0C62', trim: '#FFE9F2', dark: '#91063F' },
    { body: '#7CB518', trim: '#F1FFE0', dark: '#4C720C' },
    { body: '#FB923C', trim: '#2A1500', dark: '#B4631B' },
  ];

  type State = 'idle' | 'walk' | 'approach' | 'retreat' | 'block' | 'jab' | 'cross' | 'kick' | 'jump' | 'hurtLight' | 'hurtHeavy' | 'down' | 'getup';

  interface Fighter {
    x: number;
    facing: number;
    hp: number;
    maxHp: number;
    state: State;
    clipT: number;
    clipDur: number;
    pose: Pose;
    didHit: boolean;
    flash: number;
    bob: number;
    stun: number;
    cool: number;
    walkPhase: number;
    partner: number;
    skin: (typeof SKINS)[number];
    scale: number;
    aggression: number;
    guardChance: number;
    preferDist: number;
    downTimer: number;
    ragdoll: Record<string, Pt & { px: number; py: number }> | null;
    links: { a: string; b: string; len: number }[];
    getupFade: number;
    lastDecision: number;
    emote: string | null;
    kb: number;
    minX: number;
    maxX: number;
  }

  interface Spark {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    max: number;
    color: string;
    size: number;
    kind: 'hit' | 'block' | 'dust';
  }

  let W = 0;
  let H = 0;
  let fighters: Fighter[] = [];
  let sparks: Spark[] = [];
  let shake = 0;
  let hitstop = 0; // 命中定格剩余时间（秒）
  let rafId = 0;
  let last = 0;
  let visible = false;
  let tabVisible = document.visibilityState !== 'hidden';

  const groundY = () => H - 14;

  const mk = (i: number, skin: (typeof SKINS)[number]): Fighter => ({
    x: 0,
    facing: 1,
    hp: 100,
    maxHp: 100,
    state: 'idle',
    clipT: 0,
    clipDur: CLIPS.idle.dur,
    pose: { ...IDLE_A },
    didHit: false,
    flash: 0,
    bob: rand(0, 10),
    stun: 0,
    cool: rand(0.4, 1.6),
    walkPhase: rand(0, 1),
    partner: i % 2 === 0 ? i + 1 : i - 1,
    skin,
    scale: rand(0.94, 1.06),
    aggression: rand(0.45, 0.95),
    guardChance: rand(0.35, 0.75),
    preferDist: rand(29, 34),
    downTimer: 0,
    ragdoll: null,
    links: [],
    getupFade: 0,
    lastDecision: 0,
    emote: null,
    kb: 0,
    minX: 20,
    maxX: 9999,
  });

  const makeFighters = (count: number) => {
    fighters = [];
    const pool = [...SKINS].sort(() => Math.random() - 0.5);
    for (let i = 0; i < count; i++) fighters.push(mk(i, pool[i % pool.length]));
    if (count % 2 !== 0) fighters[count - 1].partner = -1;
  };

  /** 两个一组摆在一格里，彼此站在交战距离上 */
  const layout = () => {
    const n = fighters.length;
    const pairs = Math.max(1, Math.floor(n / 2));
    const slot = W / pairs;
    for (let p = 0; p < pairs; p++) {
      const cx = slot * (p + 0.5);

      const half = slot / 2 - 16;
      const a = fighters[p * 2];
      const b = fighters[p * 2 + 1];
      if (a) {

        a.x = cx - a.preferDist / 2;

        a.facing = 1;

        a.minX = cx - half;

        a.maxX = cx + half;

      }
      if (b) {

        b.x = cx + b.preferDist / 2;

        b.facing = -1;

        b.minX = cx - half;

        b.maxX = cx + half;

      }
    }
  };

  const spawn = (x: number, y: number, color: string, kind: Spark['kind'], n = 7, power = 1) => {
    for (let i = 0; i < n; i++) {
      const a = rand(-Math.PI, Math.PI);
      const sp = rand(40, 150) * power;
      sparks.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 45 * power,
        life: 0,
        max: kind === 'dust' ? rand(0.3, 0.55) : rand(0.16, 0.32),
        color,
        size: kind === 'dust' ? rand(1.6, 3) : rand(1.6, 3.4),
        kind,
      });
    }
  };

  /* ---------- 姿态与坐标 ---------- */

  const place = (f: Fighter) => {
    const j = fk(f.pose);
    const lowFeet = Math.max(j.footB.y, j.footF.y);
    const dy = groundY() - lowFeet - f.pose.lift - (1 - f.scale) * 20;
    const out = {} as Record<keyof Joints, Pt>;
    for (const k of Object.keys(j) as (keyof Joints)[]) {
      out[k] = { x: f.x + f.facing * j[k].x * f.scale, y: dy + j[k].y * f.scale };
    }
    return { world: out, dy };
  };

  /** 拳头到对手躯干的距离（判定是否真的打到了） */
  const contactCheck = (attacker: Fighter, target: Fighter, reachMul: number): { hit: boolean; at: Pt } => {
    const aw = place(attacker).world;
    const tw = place(target).world;
    const fist = attacker.state === 'kick' ? aw.footF : aw.handF;
    const fistReach = reachMul;
    // 目标躯干当成一条线段（骨盆↔胸腔），算拳头到它的距离
    const a = tw.pelvis;
    const b = tw.chest;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    let t = ((fist.x - a.x) * vx + (fist.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + vx * t;
    const cy = a.y + vy * t;
    const d = Math.hypot(fist.x - cx, fist.y - cy);
    return { hit: d <= 9 * fistReach * target.scale, at: { x: cx, y: cy } };
  };

  /* ---------- 状态切换 ---------- */

  const setState = (f: Fighter, s: State, dur?: number) => {
    f.state = s;
    f.clipT = 0;
    f.clipDur = dur ?? CLIPS[s]?.dur ?? 0.3;
    f.didHit = false;
  };

  const startRagdoll = (f: Fighter) => {
    const w = place(f).world;
    const rd: Fighter['ragdoll'] = {};
    for (const k of Object.keys(w) as (keyof Joints)[]) {
      rd[k] = { x: w[k].x, y: w[k].y, px: w[k].x - f.facing * 2.2, py: w[k].y - 1.4 };
    }
    const links = (
      [
        ['pelvis', 'chest'],
        ['chest', 'head'],
        ['shoulderB', 'chest'],
        ['shoulderB', 'elbowB'],
        ['elbowB', 'handB'],
        ['shoulderF', 'chest'],
        ['shoulderF', 'elbowF'],
        ['elbowF', 'handF'],
        ['hipB', 'pelvis'],
        ['hipB', 'kneeB'],
        ['kneeB', 'footB'],
        ['hipF', 'pelvis'],
        ['hipF', 'kneeF'],
        ['kneeF', 'footF'],
        ['chest', 'kneeB'],
        ['chest', 'kneeF'],
      ] as [string, string][]
    ).map(([a, b]) => ({ a, b, len: Math.hypot(rd[a].x - rd[b].x, rd[a].y - rd[b].y) }));
    f.ragdoll = rd;
    f.links = links;
    f.state = 'down';
    f.downTimer = 0;
    f.getupFade = 0;
  };

  /* ---------- 决策 ---------- */

  const snapshot = (f: Fighter, opp: Fighter | undefined): FightSnapshot => ({
    self: { hp: f.hp, x: f.x, state: f.state, distance: opp ? Math.abs(opp.x - f.x) : 999 },
    opponent: {
      hp: opp?.hp ?? 100,
      x: opp?.x ?? 0,
      state: opp?.state ?? 'idle',
      windingUp: !!opp && (opp.state === 'jab' || opp.state === 'cross' || opp.state === 'kick') && opp.clipT < opp.clipDur * 0.35,
    },
  });

  /** 本地启发式 AI：会走位、会格挡、残血会退、偶尔跳闪 */
  const heuristic = (snap: FightSnapshot, f: Fighter): Decision => {
    const d = snap.self.distance;
    const oppWinding = snap.opponent.windingUp;

    // 对手要打过来了：优先格挡
    if (oppWinding && d < f.preferDist + 22 && Math.random() < f.guardChance) return 'block';
    // 太远：靠近
    if (d > f.preferDist + 9) return 'approach';
    // 残血谨慎：偶尔退开
    if (f.hp < 32 && Math.random() < 0.35) return 'retreat';
    // 贴太近：拉开一点
    if (d < f.preferDist - 8) return Math.random() < 0.5 ? 'retreat' : 'wait';
    // 在攻击距离内：按性格出招
    if (f.cool <= 0) {
      const r = Math.random();
      const agg = f.aggression;
      if (r < 0.34 + agg * 0.2) return 'jab';
      if (r < 0.6 + agg * 0.2) return 'cross';
      if (r < 0.78 + agg * 0.15) return 'kick';
      if (r < 0.9) return 'jump';
      return 'block';
    }
    return 'wait';
  };

  const decide = (f: Fighter, opp: Fighter | undefined): Decision => {
    if (!opp) return 'wait';
    const snap = snapshot(f, opp);
    if (externalController) {
      try {
        const d = externalController(snap);
        if (d) return d;
      } catch {
        /* 外部控制器出错就退回本地 AI */
      }
    }
    return heuristic(snap, f);
  };

  const applyDecision = (f: Fighter, opp: Fighter | undefined, d: Decision) => {
    switch (d) {
      case 'approach':
        setState(f, 'approach', 0);
        break;
      case 'retreat':
        setState(f, 'retreat', rand(0.28, 0.5));
        break;
      case 'block':
        setState(f, 'block');
        f.cool = Math.max(f.cool, 0.25);
        break;
      case 'jab':
      case 'cross':
      case 'kick':
      case 'jump':
        setState(f, d);
        f.cool = rand(0.35, 0.9);
        if (opp) f.facing = opp.x >= f.x ? 1 : -1;
        break;
      case 'wait':
        setState(f, 'idle');
        break;
    }
  };

  /* ---------- 每帧更新 ---------- */

  const stepRagdoll = (f: Fighter, dt: number) => {
    const rd = f.ragdoll;
    if (!rd) return;
    const g = 1700;
    for (const k of Object.keys(rd)) {
      const p = rd[k];
      const vx = (p.x - p.px) * 0.99;
      const vy = (p.y - p.py) * 0.99;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + g * dt * dt;
    }
    for (let it = 0; it < 6; it++) {
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
      const gy = groundY();
      for (const k of Object.keys(rd)) {
        const p = rd[k];
        if (p.y > gy) {
          p.y = gy;
          p.px = p.x + (p.px - p.x) * 0.5;
        }
      }
    }
  };

  const update = (dt: number) => {
    // 命中定格（hitstop）：人物瞬间冻结几帧，打击感来自这里
    if (hitstop > 0) {
      hitstop -= dt;
      for (const s of sparks) {
        s.life += dt;
        s.x += s.vx * dt * 0.35;
        s.y += s.vy * dt * 0.35;
        s.vy += 260 * dt;
      }
      sparks = sparks.filter((s) => s.life < s.max);
      shake *= 0.86;
      return;
    }

    for (const f of fighters) {
      f.bob += dt;

      f.flash = Math.max(0, f.flash - dt * 4.5);

      if (f.kb !== 0) {

        f.x += f.kb * dt;

        f.kb *= Math.exp(-dt * 9);

        if (Math.abs(f.kb) < 3) f.kb = 0;

        f.x = Math.max(f.minX, Math.min(f.maxX, f.x));

      }

      /* --- 倒地 --- */
      if (f.state === 'down') {
        f.downTimer += dt;
        stepRagdoll(f, dt);
        if (f.downTimer > 1.3) {
          // 起身：从倒地位置切到跪姿再站起
          f.ragdoll = null;
          f.hp = f.maxHp;
          f.getupFade = 0;
          setState(f, 'getup');
          f.cool = rand(0.5, 1.0);
        }
        continue;
      }
      if (f.state === 'getup') {
        f.getupFade = Math.min(1, f.getupFade + dt * 5);
      }

      /* --- 受击硬直 --- */
      if (f.stun > 0) f.stun = Math.max(0, f.stun - dt);

      const opp = fighters[f.partner];

      /* --- 走路 / 走位 --- */
      if (f.state === 'approach' || f.state === 'retreat') {
        const target = opp ? opp.x : f.x;
        const d = Math.abs(target - f.x);
        f.facing = target >= f.x ? 1 : -1;
        f.clipT += dt;

        if (f.state === 'approach' && d > f.preferDist && f.clipT < 3.5) {
          f.x += f.facing * 54 * dt;
          f.walkPhase += dt * 1.9;
          f.pose = lerpPose(f.pose, walkPose(f.walkPhase), 1 - Math.exp(-dt * 22));
        } else if (f.state === 'retreat' && f.clipT < f.clipDur) {
          // 后撤是短暂的规避动作，不是一直逃跑
          f.x -= f.facing * 42 * dt;
          f.walkPhase += dt * 1.6;
          f.pose = lerpPose(f.pose, walkPose(f.walkPhase, -0.85), 1 - Math.exp(-dt * 22));
        } else {
          setState(f, 'idle');
          f.cool = Math.max(f.cool, rand(0.12, 0.45));
        }
        // 限制在自己那半格场地内，不会跑出画面或穿过对手
        f.x = Math.max(f.minX, Math.min(f.maxX, f.x));
        continue;
      }

      /* --- 播放动画片段 --- */
      f.clipT += dt;
      const clip = CLIPS[f.state] ?? CLIPS.idle;
      const prog = f.clipDur > 0 ? f.clipT / f.clipDur : 1;
      const targetPose = sampleClip(clip, prog);
      f.pose = lerpPose(f.pose, targetPose, 1 - Math.exp(-dt * 30));

      /* --- 攻击命中判定（真·空间碰撞） --- */
      const atk = ATTACKS[f.state];
      if (atk && !f.didHit && prog >= atk.hitAt) {
        f.didHit = true;
        if (opp && opp.state !== 'down') {
          const { hit, at } = contactCheck(f, opp, atk.reach);
          if (hit) {
            const [lo, hi] = atk.dmg;
            const blocking = opp.state === 'block';
            let dmg = Math.round(rand(lo, hi) * (blocking ? 0.22 : 1));
            opp.hp = Math.max(0, opp.hp - dmg);
            shake = Math.max(shake, blocking ? 2 : f.state === 'kick' ? 6 : 4);

            if (blocking) {
              // 格挡：蓝白火花、小退、不掉太多血、不进硬直
              spawn(at.x, at.y, '#9AD9FF', 'block', 6, 0.8);
              opp.kb = f.facing * 90;
              f.kb = -f.facing * 60;
              hitstop = 0.03;
            } else {
              opp.flash = 1;
              // 真的被击退：位置移动 + 后仰
              opp.kb = f.facing * (f.state === 'kick' ? 320 : f.state === 'cross' ? 230 : 150);
              hitstop = 0.055;
              spawn(at.x, at.y, opp.skin.trim, 'hit', f.state === 'kick' ? 10 : 7, f.state === 'kick' ? 1.3 : 1);
              if (opp.hp <= 0) {
                spawn(at.x, at.y, '#FAC901', 'hit', 14, 1.6);
                startRagdoll(opp);
                continue;
              }
              // 重量级招式 / 残血 → 重击弯腰；否则轻击后仰
              const heavy = dmg >= 15 || opp.hp < 30;
              setState(opp, heavy ? 'hurtHeavy' : 'hurtLight');
              opp.stun = heavy ? 0.42 : 0.2;
              opp.cool = Math.max(opp.cool, 0.3);
            }
          } else {
            // 挥空：拳头没碰到，给一点"空气"提示
            spawn(at.x + f.facing * 14, at.y, 'rgba(120,120,120,0.5)', 'dust', 3, 0.4);
          }
        }
      }

      /* --- 片段播完 --- */
      if (!clip.loop && prog >= 1) {
        setState(f, 'idle');
        f.cool = Math.max(f.cool, rand(0.25, 0.8));
      }

      /* --- 待机时做决策 --- */
      if (f.state === 'idle') {
        f.cool -= dt;
        f.lastDecision += dt;
        if (f.cool <= 0 && f.stun <= 0 && f.lastDecision > 0.1) {
          f.lastDecision = 0;
          applyDecision(f, opp, decide(f, opp));
        }
      }
    }

    for (const s of sparks) {
      s.life += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += (s.kind === 'dust' ? 120 : 420) * dt;
      if (s.kind === 'dust') s.vx *= 0.94;
    }
    sparks = sparks.filter((s) => s.life < s.max);
    shake *= 0.82;
  };

  /* ---------- 绘制 ---------- */

  const OUTLINE = 'rgba(26,19,14,0.66)';

  const capsule = (a: Pt, b: Pt, ra: number, rb: number, fill: string) => {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath();
    ctx.arc(a.x, a.y, ra, ang + Math.PI / 2, ang + Math.PI * 1.5, false);
    ctx.arc(b.x, b.y, rb, ang - Math.PI / 2, ang + Math.PI / 2, false);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  /** 带描边的锥形肢体：近端粗、远端细（Spine/DragonBones 里「部件 + 关节圆」的做法） */
  const limb = (a: Pt, b: Pt, ra: number, rb: number, fill: string) => {
    capsule(a, b, ra + 1.3, rb + 1.3, OUTLINE);
    capsule(a, b, ra, rb, fill);
  };

  const disc = (p: Pt, r: number, fill: string) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.fillStyle = fill;
    ctx.fill();
  };

  /** 关节头：圆形覆盖，让弯折处不出现缺口 */
  const jointCap = (p: Pt, r: number, fill: string) => {
    disc(p, r + 1.25, OUTLINE);
    disc(p, r, fill);
  };

  /** 躯干：宽肩窄腰的曲线轮廓，而不是方块 */
  const torsoShape = (pelvis: Pt, chest: Pt, k: number, fill: string) => {
    const dx = chest.x - pelvis.x;
    const dy = chest.y - pelvis.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const wHip = 7.0 * k;
    const wWaist = 5.7 * k;
    const wChest = 8.4 * k;
    const wShoulder = 9.2 * k;
    const at = (t: number, w: number, side: number): Pt => ({
      x: pelvis.x + ux * len * t + nx * w * side,
      y: pelvis.y + uy * len * t + ny * w * side,
    });
    const pts = [
      at(-0.05, wHip, -1),
      at(0.3, wWaist, -1),
      at(0.7, wChest, -1),
      at(1.04, wShoulder, -1),
      at(1.16, wShoulder * 0.72, -1),
      at(1.16, wShoulder * 0.72, 1),
      at(1.04, wShoulder, 1),
      at(0.7, wChest, 1),
      at(0.3, wWaist, 1),
      at(-0.05, wHip, 1),
    ];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2.6;
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  /** 头：椭圆头骨 + 头发块 + 表情（受伤时变成 ›‹ 眼） */
  const headShape = (head: Pt, k: number, body: string, trim: string, expr: 'normal' | 'hurt' | 'down') => {
    const rx = L.headR * k;
    const ry = (L.headR + 0.8) * k;
    ctx.beginPath();
    ctx.ellipse(head.x, head.y, rx + 1.5, ry + 1.5, 0, 0, TAU);
    ctx.fillStyle = OUTLINE;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(head.x, head.y, rx, ry, 0, 0, TAU);
    ctx.fillStyle = body;
    ctx.fill();
    // 头发：覆盖上半部，带斜刘海缺口
    ctx.beginPath();
    ctx.ellipse(head.x, head.y - ry * 0.3, rx + 0.8, ry * 0.86, 0, Math.PI * 0.99, Math.PI * 2.01);
    ctx.lineTo(head.x + rx * 0.62, head.y - ry * 0.06);
    ctx.lineTo(head.x + rx * 0.1, head.y - ry * 0.3);
    ctx.closePath();
    ctx.fillStyle = trim;
    ctx.fill();

    const ex = head.x + rx * 0.16;
    const ey = head.y + ry * 0.06;
    const gap = rx * 0.36;
    if (expr === 'normal') {
      disc({ x: ex + gap, y: ey }, Math.max(1.3, rx * 0.19), '#1b1512');
      disc({ x: ex - gap * 0.95, y: ey }, Math.max(1.3, rx * 0.19), '#1b1512');
    } else {
      ctx.strokeStyle = '#1b1512';
      ctx.lineWidth = Math.max(1.2, rx * 0.16);
      ctx.lineCap = 'round';
      for (const s of [1, -1]) {
        const cx = ex + gap * s;
        ctx.beginPath();
        ctx.moveTo(cx - rx * 0.16, ey - ry * 0.14);
        ctx.lineTo(cx + rx * 0.16, ey);
        ctx.lineTo(cx - rx * 0.16, ey + ry * 0.14);
        ctx.stroke();
      }
    }
    if (expr !== 'normal') {
      ctx.save();
      ctx.globalAlpha *= 0.5;
      disc({ x: head.x + rx * 0.55, y: head.y + ry * 0.42 }, rx * 0.22, '#e8556d');
      ctx.restore();
    }
  };

  /** 拳头：球 + 拇指小凸起 */
  const fist = (p: Pt, k: number, fill: string) => {
    jointCap(p, 3.3 * k, fill);
    disc({ x: p.x - 1.4 * k, y: p.y + 1.7 * k }, 1.5 * k, fill);
  };

  /** 鞋：沿小腿方向伸出的楔形 */
  const shoe = (foot: Pt, knee: Pt, k: number, fill: string) => {
    const ang = Math.atan2(foot.y - knee.y, foot.x - knee.x) + Math.PI / 2;
    const tx = Math.cos(ang);
    const ty = Math.sin(ang);
    const L1 = 5.6 * k;
    const L2 = 2.8 * k;
    const pts: Pt[] = [
      { x: foot.x - tx * L2 * 0.4, y: foot.y - ty * L2 * 0.4 },
      { x: foot.x + tx * L1, y: foot.y + ty * L1 },
      { x: foot.x + tx * L1 * 0.9, y: foot.y + ty * L1 * 0.9 + 2.4 * k },
      { x: foot.x - tx * L2 * 0.2, y: foot.y + 2.6 * k },
    ];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.9;
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  /** 整具身体：按深度顺序分层绘制（远肢 → 躯干 → 头 → 近肢） */
  const drawFigure = (
    get: (k: string) => Pt,
    k: number,
    body: string,
    trim: string,
    dark: string,
    expr: 'normal' | 'hurt' | 'down'
  ) => {
    const pelvis = get('pelvis');
    const chest = get('chest');
    const head = get('head');

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 远侧（暗色，形成前后层次）
    ctx.save();
    ctx.globalAlpha *= 0.78;
    limb(get('hipB'), get('kneeB'), 5.2 * k, 4.2 * k, dark);
    jointCap(get('kneeB'), 4.2 * k, dark);
    limb(get('kneeB'), get('footB'), 4.0 * k, 3.2 * k, dark);
    shoe(get('footB'), get('kneeB'), k, dark);
    limb(get('shoulderB'), get('elbowB'), 4.3 * k, 3.5 * k, dark);
    jointCap(get('elbowB'), 3.5 * k, dark);
    limb(get('elbowB'), get('handB'), 3.4 * k, 3.0 * k, dark);
    fist(get('handB'), k, dark);
    ctx.restore();

    // 躯干 + 腰带
    torsoShape(pelvis, chest, k, body);
    const dx = chest.x - pelvis.x;
    const dy = chest.y - pelvis.y;
    const dl = Math.hypot(dx, dy) || 1;
    const nx = -dy / dl;
    const ny = dx / dl;
    const bw = 6.4 * k;
    const bcx = pelvis.x + dx * 0.26;
    const bcy = pelvis.y + dy * 0.26;
    capsule({ x: bcx + nx * bw, y: bcy + ny * bw }, { x: bcx - nx * bw, y: bcy - ny * bw }, 2.0 * k, 2.0 * k, trim);

    // 脖子
    const neckA: Pt = { x: chest.x + (chest.x - pelvis.x) * 0.14, y: chest.y + (chest.y - pelvis.y) * 0.14 };
    limb(neckA, { x: head.x, y: head.y + L.headR * k * 0.65 }, 3.4 * k, 3.2 * k, dark);

    // 头
    headShape(head, k, body, trim, expr);

    // 近侧腿
    limb(get('hipF'), get('kneeF'), 5.8 * k, 4.6 * k, body);
    jointCap(get('kneeF'), 4.6 * k, body);
    limb(get('kneeF'), get('footF'), 4.4 * k, 3.4 * k, body);
    shoe(get('footF'), get('kneeF'), k, body);

    // 近侧手臂 + 拳头
    limb(get('shoulderF'), get('elbowF'), 4.8 * k, 3.9 * k, body);
    jointCap(get('elbowF'), 3.9 * k, body);
    limb(get('elbowF'), get('handF'), 3.8 * k, 3.2 * k, body);
    fist(get('handF'), k, body);
  };

  const drawFighter = (f: Fighter) => {
    const flashing = f.flash > 0.25;
    const body = flashing ? '#FFFFFF' : f.skin.body;
    const trim = flashing ? '#F4F4F4' : f.skin.trim;
    const dark = flashing ? '#E8E8E8' : f.skin.dark;
    const expr: 'normal' | 'hurt' | 'down' =
      f.state === 'down' ? 'down' : f.state === 'hurtLight' || f.state === 'hurtHeavy' || flashing ? 'hurt' : 'normal';

    const sh = Math.max(0.4, 1 - f.pose.lift / 40);
    ctx.save();
    ctx.globalAlpha = 0.14 * sh;
    ctx.beginPath();
    ctx.ellipse(f.x, groundY() + 1, 15 * sh * f.scale, 3.4 * sh, 0, 0, TAU);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();

    // 受击挤压：横向张开、纵向压扁
    const sq = Math.min(1, f.flash);
    ctx.save();
    if (sq > 0.02) {
      const baseY = groundY();
      ctx.translate(f.x, baseY);
      ctx.scale(1 + sq * 0.12, 1 - sq * 0.14);
      ctx.translate(-f.x, -baseY);
    }

    const alpha = f.state === 'getup' ? Math.max(0.02, f.getupFade) : 1;
    ctx.save();
    ctx.globalAlpha = alpha;

    if (f.state === 'down' && f.ragdoll) {
      const rd = f.ragdoll;
      drawFigure(
        (key) => ({ x: (rd[key] as Pt).x, y: (rd[key] as Pt).y }),
        f.scale,
        body,
        trim,
        dark,
        'down'
      );
    } else {
      const { world } = place(f);
      drawFigure((key) => world[key as keyof Joints], f.scale, body, trim, dark, expr);
    }
    ctx.restore();
    ctx.restore();

    if (f.state !== 'down') {
      const w = 26;
      const bx = f.x - w / 2;
      const by = groundY() - 84;
      ctx.fillStyle = 'rgba(0,0,0,0.13)';
      ctx.fillRect(bx - 1, by - 1, w + 2, 4.6);
      ctx.fillStyle = f.hp > 45 ? f.skin.body : '#DD0100';
      ctx.fillRect(bx, by, (w * f.hp) / f.maxHp, 2.8);
    }
  };

  const render = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dpr = canvas.width / Math.max(1, W);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (shake > 0.15) ctx.translate(rand(-shake, shake) * 0.45, rand(-shake, shake) * 0.35);

    ctx.strokeStyle = 'rgba(0,0,0,0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, groundY() + 0.5);
    ctx.lineTo(W, groundY() + 0.5);
    ctx.stroke();

    fighters.forEach(drawFighter);

    for (const s of sparks) {
      const k = 1 - s.life / s.max;
      ctx.globalAlpha = Math.max(0, k);
      ctx.fillStyle = s.color;
      const sz = s.size * (s.kind === 'dust' ? 1 + (1 - k) : k);
      ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  };

  /* ---------- 生命周期 ---------- */

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const want = W < 620 ? 2 : 4;
    if (fighters.length !== want) makeFighters(want);
    layout();
    render();
  };

  const loop = (ts: number) => {
    rafId = requestAnimationFrame(loop);
    if (!last) last = ts;
    const dt = Math.min(0.05, (ts - last) / 1000);
    last = ts;
    // 只有「真的被人看着」才跑：在视口内 + 标签页可见 + 没开减少动效
    if (reduceMotion || !visible || !tabVisible) return;
    update(dt);
    render();
  };

  resize();
  window.addEventListener('resize', () => {
    window.clearTimeout((window as any).__fightResize);
    (window as any).__fightResize = window.setTimeout(resize, 140);
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((e) => (visible = e[0]?.isIntersecting ?? false), { threshold: 0.15 }).observe(canvas);
  } else {
    visible = true;
  }
  document.addEventListener('visibilitychange', () => {
    tabVisible = document.visibilityState !== 'hidden';
  });

  if (!reduceMotion) rafId = requestAnimationFrame(loop);
  window.addEventListener('pagehide', () => cancelAnimationFrame(rafId));

  // 对外接口（将来接 AI API 用）
  (window as any).takinolFight = {
    setController,
    /** 读取当前战况，方便外部 AI 参考 */
    snapshot: () =>
      fighters.map((f) => ({
        hp: f.hp,
        x: Math.round(f.x),
        state: f.state,
        facing: f.facing,
        opponent: f.partner,
      })),
    /** 结束外部控制，回到本地 AI */
    reset: () => setController(null),
  };
}
