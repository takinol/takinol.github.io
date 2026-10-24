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
  /** 整体转身角度（弧度），用横向缩放模拟转体 */
  spin: number;
  /** 绕竖轴转体（弧度）：真正的三维转身 */
  yaw: number;
  /** 手臂深度外展（正=靠近镜头，负=远离镜头/身体外侧） */
  armUBD: number;
  armUFD: number;
  armLBD: number;
  armLFD: number;
  /** 腿部深度外展（后旋踢需要腿扫出平面） */
  legUBD: number;
  legUFD: number;
  legLBD: number;
  legLFD: number;
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
  spin: 0,
  yaw: 0,
  armUBD: 0,
  armUFD: 0,
  armLBD: 0,
  armLFD: 0,
  legUBD: 0,
  legUFD: 0,
  legLBD: 0,
  legLFD: 0,
  ...p,
});

interface Pt {
  x: number;
  y: number;
  /** 深度：负=远离镜头，正=靠近镜头 */
  z: number;
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
/** 正向运动学：由关节角度（含深度外展）算出关节的三维坐标 */
export const fk = (p: Pose, swap = false): Joints => {
  // 方向：a = 矢状面角度（0 表示朝下），d = 深度外展角（正=靠近镜头）
  const dir = (a: number, d: number): Pt => {
    const cd = Math.cos(d);
    return { x: Math.sin(a) * cd, y: Math.cos(a) * cd, z: Math.sin(d) };
  };
  const add = (o: Pt, d: Pt, len: number): Pt => ({
    x: o.x + d.x * len,
    y: o.y + d.y * len,
    z: o.z + d.z * len,
  });

  const chest: Pt = { x: Math.sin(p.lean) * L.spine, y: -Math.cos(p.lean) * L.spine, z: 0 };
  const headAng = p.lean + p.head;
  const head: Pt = {
    x: chest.x + Math.sin(headAng) * (L.neck + L.headR),
    y: chest.y - Math.cos(headAng) * (L.neck + L.headR),
    z: 0,
  };
  // 肩/髋向两侧错开深度，形成「近侧 / 远侧」层次
  const sx = Math.cos(p.lean) * 2.6;
  const sy = Math.sin(p.lean) * 2.6;
  const shoulderF: Pt = { x: chest.x + sx, y: chest.y + sy, z: 2.8 };
  const shoulderB: Pt = { x: chest.x - sx, y: chest.y - sy, z: -2.8 };
  const hipF: Pt = { x: Math.cos(p.lean) * 3, y: Math.sin(p.lean) * 3, z: 3 };
  const hipB: Pt = { x: -Math.cos(p.lean) * 3, y: -Math.sin(p.lean) * 3, z: -3 };

  const arm = (s: Pt, u: number, f: number, ud: number, fd: number) => {
    const a1 = p.lean * 0.3 + u;
    const elbow = add(s, dir(a1, ud), L.upperArm);
    const a2 = a1 + f;
    const hand = add(elbow, dir(a2, ud + fd), L.foreArm);
    return { elbow, hand };
  };
  const leg = (hip: Pt, u: number, f: number, ud: number, fd: number) => {
    const knee = add(hip, dir(u, ud), L.thigh);
    const foot = add(knee, dir(u + f, ud + fd), L.shin);
    return { knee, foot };
  };

  const b = arm(shoulderB, p.armUB, p.armLB, p.armUBD, p.armLBD);
  const f2 = arm(shoulderF, p.armUF, p.armLF, p.armUFD, p.armLFD);
  const lb = leg(hipB, p.legUB, p.legLB, p.legUBD, p.legLBD);
  const lf = leg(hipF, p.legUF, p.legLF, p.legUFD, p.legLFD);

  return {
    pelvis: { x: 0, y: 0, z: 0 },
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

/* ---------------- 拳法 ---------------- */

const JAB_WIND = P({ lean: 0.1, head: -0.06, armUB: 1.05, armLB: 2.0, armUF: 0.72, armLF: 2.15, legUB: -0.28, legLB: 0.2, legUF: 0.32, legLF: 0.1 });
const JAB_HIT = P({ lean: 0.3, head: -0.02, armUB: 0.9, armLB: 2.05, armUF: 1.62, armLF: 0.0, legUB: -0.42, legLB: 0.26, legUF: 0.5, legLF: 0.04 });

const CROSS_WIND = P({ lean: -0.14, head: -0.1, armUB: -1.05, armLB: 1.75, armUBD: -0.45, armUF: 1.0, armLF: 1.9, armUFD: 0.25, legUB: -0.18, legLB: 0.14, legUF: 0.26, legLF: 0.12, yaw: -0.32 });
const CROSS_HIT = P({ lean: 0.44, head: 0.08, armUB: 1.6, armLB: 0.02, armUBD: -0.12, armUF: 0.42, armLF: 1.98, armUFD: 0.3, legUB: -0.52, legLB: 0.32, legUF: 0.58, legLF: 0.02, yaw: 0.22 });

/** 摆拳（横拳）：手臂保持弯曲，末端走弧线 */
const HOOK_WIND = P({ lean: -0.1, head: -0.05, armUB: 0.9, armLB: 1.9, armUF: -0.35, armLF: 1.1, armUFD: -1.0, legUB: -0.24, legLB: 0.18, legUF: 0.3, legLF: 0.12, yaw: -0.2 });
const HOOK_HIT = P({ lean: 0.34, head: 0.1, armUB: 0.95, armLB: 1.95, armUF: 1.45, armLF: 1.2, armUFD: 0.45, armLFD: 0.2, legUB: -0.46, legLB: 0.3, legUF: 0.5, legLF: 0.04, yaw: 0.26 });

/** 上勾拳（冲天拳）：先蹲，再蹬腿上冲 */
const UPPER_WIND = P({ lean: 0.34, head: 0.08, armUB: 0.1, armLB: 2.35, armUBD: -0.75, armUF: 0.85, armLF: 1.9, legUB: 0.4, legLB: -0.95, legUF: 0.45, legLF: -1.0, yaw: -0.15 });
const UPPER_HIT = P({ lean: 0.02, head: 0.16, armUB: 1.95, armLB: 0.22, armUBD: -0.3, armUF: 0.75, armLF: 1.85, legUB: -0.1, legLB: 0.06, legUF: 0.16, legLF: 0.04, yaw: 0.06 });

/** 肘击：前臂折死，用肘尖打 */
const ELBOW_WIND = P({ lean: 0.14, head: -0.04, armUB: 1.0, armLB: 2.1, armUF: 0.55, armLF: 2.4, armUFD: -0.6, legUB: -0.26, legLB: 0.2, legUF: 0.32, legLF: 0.1, yaw: -0.14 });
const ELBOW_HIT = P({ lean: 0.46, head: 0.08, armUB: 0.95, armLB: 2.05, armUF: 1.5, armLF: 2.42, armUFD: -0.12, legUB: -0.5, legLB: 0.3, legUF: 0.5, legLF: 0.04, yaw: 0.12 });

/* ---------------- 腿法 ---------------- */

/** 弹腿（屈伸性）：提膝后小腿弹出 */
const SNAP_UP = P({ lean: -0.1, head: -0.04, armUB: 0.7, armLB: 1.6, armUF: 0.95, armLF: 1.4, legUB: 0.1, legLB: 0.02, legUF: 0.92, legLF: -1.6 });
const SNAP_HIT = P({ lean: -0.22, head: -0.05, armUB: 0.35, armLB: 1.3, armUF: 0.6, armLF: 1.15, legUB: 0.14, legLB: 0.03, legUF: 1.26, legLF: 0.05 });

/** 正蹬：整条腿往前推直 */
const PUSH_UP = P({ lean: -0.12, head: -0.03, armUB: 0.8, armLB: 1.5, armUF: 1.0, armLF: 1.3, legUB: 0.1, legLB: 0.02, legUF: 0.95, legLF: -1.4 });
const PUSH_HIT = P({ lean: -0.32, head: -0.04, armUB: 0.2, armLB: 1.1, armUF: 0.4, armLF: 1.0, legUB: 0.14, legLB: 0.03, legUF: 1.36, legLF: 0.06 });

/** 侧踹：大幅后仰，腿平着蹬出去 */
const SIDE_UP = P({ lean: -0.36, head: -0.05, armUB: 0.4, armLB: 1.3, armUF: 0.6, armLF: 1.2, legUB: 0.1, legLB: 0.02, legUF: 1.1, legLF: -1.3 });
const SIDE_HIT = P({ lean: -0.6, head: -0.08, armUB: -0.8, armLB: 0.6, armUF: -0.95, armLF: 0.7, legUB: 0.12, legLB: 0.03, legUF: 1.56, legLF: 0.02 });

/** 鞭腿（横扫）：腿摆到头部高度 */
const ROUND_UP = P({ lean: -0.24, head: -0.04, armUB: 0.55, armLB: 1.4, armUF: 0.9, armLF: 1.25, legUB: 0.1, legLB: 0.02, legUF: 1.5, legLF: -1.0 });
const ROUND_HIT = P({ lean: -0.5, head: -0.1, armUB: -0.35, armLB: 0.9, armUF: 0.3, armLF: 1.2, legUB: 0.12, legLB: 0.03, legUF: 2.15, legLF: 0.05 });

/** 下劈腿（挂面腿）：抬过头 → 狠狠下砸 */
const AXE_UP = P({ lean: -0.46, head: -0.1, armUB: 0.5, armLB: 1.2, armUF: 1.3, armLF: 0.9, legUB: 0.12, legLB: 0.03, legUF: 2.45, legLF: -0.15 });
const AXE_HIT = P({ lean: 0.22, head: 0.05, armUB: 0.1, armLB: 1.0, armUF: 0.35, armLF: 1.1, legUB: 0.1, legLB: 0.03, legUF: 0.95, legLF: 0.05 });

/** 后旋踢：以髋为轴转体一圈，后腿直摆甩出（spin 表示整体转身角度） */
const SPIN_TUCK = P({ lean: 0.16, head: -0.02, armUB: 0.75, armLB: 1.7, armUF: 1.1, armLF: 1.6, legUB: 1.0, legLB: -1.6, legUBD: 0.15, legUF: -0.12, legLF: 0.1, legUFD: 0, yaw: 0 });
const SPIN_MID = P({ lean: 0.1, head: 0.12, armUB: 0.6, armLB: 1.5, armUF: 1.0, armLF: 1.4, legUB: -0.9, legLB: -0.6, legUBD: -0.2, legUF: 0.15, legLF: 0.05, legUFD: 0, yaw: -3.14 });
const SPIN_KICK = P({ lean: -0.12, head: 0.18, armUB: -0.45, armLB: 0.8, armUF: 0.65, armLF: 0.9, legUB: -1.9, legLB: 0.05, legUBD: -0.25, legUF: 0.12, legLF: 0.04, legUFD: 0, yaw: -3.14 });
const SPIN_END = P({ lean: 0.1, head: -0.02, armUB: 1.0, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.28, legLB: 0.2, legUBD: 0, legUF: 0.32, legLF: 0.12, yaw: -6.28 });

/** 腾空飞踢：跳起来前冲踢 */
const FLY_CROUCH = P({ lean: 0.34, head: -0.1, armUB: -0.6, armLB: 0.8, armUF: -0.7, armLF: 0.9, legUB: 0.62, legLB: -1.35, legUF: 0.58, legLF: -1.6 });
const FLY_AIR = P({ lean: 0.16, head: 0.06, armUB: 0.9, armLB: 1.1, armUF: 1.1, armLF: 1.0, legUB: -0.2, legLB: 0.1, legUF: 1.52, legLF: 0.05, lift: 34 });
const FLY_LAND = P({ lean: 0.4, head: -0.14, armUB: -0.5, armLB: 0.95, armUF: -0.6, armLF: 1.0, legUB: 0.62, legLB: -1.3, legUF: 0.5, legLF: -1.4 });

/** 双飞脚：腾空剪腿，两脚先后各一击 */
const SCISSOR_CROUCH = P({ lean: 0.36, head: -0.1, armUB: -0.55, armLB: 0.85, armUF: -0.65, armLF: 0.95, legUB: 0.6, legLB: -1.3, legUF: 0.56, legLF: -1.5 });
const SCISSOR_A = P({ lean: 0.05, head: 0.05, armUB: 0.9, armLB: 1.2, armUF: 1.2, armLF: 1.1, legUB: -0.55, legLB: 0.15, legUF: 1.45, legLF: 0.05, lift: 30 });
const SCISSOR_B = P({ lean: 0.05, head: 0.05, armUB: 1.2, armLB: 1.1, armUF: 0.9, armLF: 1.2, legUB: 1.35, legLB: 0.05, legUF: -0.35, legLF: 0.15, lift: 30 });
const SCISSOR_LAND = P({ lean: 0.42, head: -0.14, armUB: -0.5, armLB: 0.9, armUF: -0.6, armLF: 1.0, legUB: 0.66, legLB: -1.35, legUF: 0.6, legLF: -1.45 });

/* ---------------- 反应 / 位移 ---------------- */

const HURT_LIGHT = P({ lean: -0.28, head: -0.6, armUB: -0.45, armLB: 0.9, armUF: -0.7, armLF: 1.05, legUB: -0.34, legLB: 0.28, legUF: 0.3, legLF: 0.14 });
const HURT_HEAVY = P({ lean: 0.45, head: 0.5, armUB: 0.35, armLB: 1.6, armUF: 0.15, armLF: 1.75, legUB: 0.3, legLB: -0.55, legUF: 0.42, legLF: -0.7 });
/** 被上勾拳打中：仰头 */
const HURT_UP = P({ lean: -0.42, head: -0.85, armUB: -0.7, armLB: 1.1, armUF: -0.9, armLF: 1.2, legUB: -0.3, legLB: 0.34, legUF: 0.34, legLF: 0.16 });

const JUMP_CROUCH = P({ lean: 0.34, head: -0.12, armUB: -0.65, armLB: 0.8, armUF: -0.75, armLF: 0.9, legUB: 0.62, legLB: -1.35, legUF: 0.58, legLF: -1.6 });
const JUMP_AIR = P({ lean: 0.1, head: 0.08, armUB: 1.6, armLB: 0.3, armUF: 1.75, armLF: 0.25, legUB: 0.8, legLB: -1.3, legUF: 0.95, legLF: -1.45, lift: 30 });
const JUMP_LAND = P({ lean: 0.4, head: -0.14, armUB: -0.55, armLB: 0.95, armUF: -0.65, armLF: 1.05, legUB: 0.7, legLB: -1.45, legUF: 0.64, legLF: -1.6 });

/** 踉跄：重心后倒，手臂张开保持平衡，一只脚向后撤 */
const STUMBLE = P({ lean: -0.24, head: -0.3, armUB: -0.65, armLB: 1.25, armUF: -0.45, armLF: 1.15, legUB: -0.5, legLB: 0.55, legUF: 0.4, legLF: 0.22 });
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

  // 拳法
  jab: { dur: 0.4, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.26, pose: JAB_WIND }, { t: 0.48, pose: JAB_HIT }, { t: 0.62, pose: JAB_HIT }, { t: 1, pose: GUARD }] },
  cross: { dur: 0.66, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: CROSS_WIND }, { t: 0.44, pose: CROSS_WIND }, { t: 0.62, pose: CROSS_HIT }, { t: 0.76, pose: CROSS_HIT }, { t: 1, pose: GUARD }] },
  hook: { dur: 0.54, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: HOOK_WIND }, { t: 0.54, pose: HOOK_HIT }, { t: 0.7, pose: HOOK_HIT }, { t: 1, pose: GUARD }] },
  uppercut: { dur: 0.62, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: UPPER_WIND }, { t: 0.56, pose: UPPER_HIT }, { t: 0.72, pose: UPPER_HIT }, { t: 1, pose: GUARD }] },
  elbow: { dur: 0.44, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.28, pose: ELBOW_WIND }, { t: 0.5, pose: ELBOW_HIT }, { t: 0.66, pose: ELBOW_HIT }, { t: 1, pose: GUARD }] },

  // 腿法
  snapKick: { dur: 0.46, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: SNAP_UP }, { t: 0.5, pose: SNAP_HIT }, { t: 0.64, pose: SNAP_HIT }, { t: 1, pose: GUARD }] },
  pushKick: { dur: 0.54, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: PUSH_UP }, { t: 0.52, pose: PUSH_HIT }, { t: 0.68, pose: PUSH_HIT }, { t: 1, pose: GUARD }] },
  sideKick: { dur: 0.6, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.32, pose: SIDE_UP }, { t: 0.54, pose: SIDE_HIT }, { t: 0.7, pose: SIDE_HIT }, { t: 1, pose: GUARD }] },
  roundKick: { dur: 0.6, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.32, pose: ROUND_UP }, { t: 0.54, pose: ROUND_HIT }, { t: 0.7, pose: ROUND_HIT }, { t: 1, pose: GUARD }] },
  axeKick: { dur: 0.68, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: AXE_UP }, { t: 0.58, pose: AXE_HIT }, { t: 0.74, pose: AXE_HIT }, { t: 1, pose: GUARD }] },
  spinKick: { dur: 1.2, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.1, pose: SPIN_TUCK }, { t: 0.45, pose: SPIN_MID }, { t: 0.7, pose: SPIN_KICK }, { t: 0.84, pose: SPIN_KICK }, { t: 0.94, pose: GUARD }, { t: 1, pose: GUARD }] },
  flyKick: { dur: 0.82, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.18, pose: FLY_CROUCH }, { t: 0.44, pose: FLY_AIR }, { t: 0.62, pose: FLY_AIR }, { t: 0.82, pose: FLY_LAND }, { t: 1, pose: GUARD }] },
  scissorKick: { dur: 0.92, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.16, pose: SCISSOR_CROUCH }, { t: 0.38, pose: SCISSOR_A }, { t: 0.58, pose: SCISSOR_B }, { t: 0.78, pose: SCISSOR_LAND }, { t: 1, pose: GUARD }] },

  // 反应 / 位移
  hurtLight: { dur: 0.3, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.22, pose: HURT_LIGHT }, { t: 1, pose: GUARD }] },
  hurtHeavy: { dur: 0.5, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.24, pose: HURT_HEAVY }, { t: 1, pose: GUARD }] },
  hurtUp: { dur: 0.48, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.22, pose: HURT_UP }, { t: 1, pose: GUARD }] },
  jump: { dur: 0.8, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.16, pose: JUMP_CROUCH }, { t: 0.4, pose: JUMP_AIR }, { t: 0.64, pose: JUMP_AIR }, { t: 0.82, pose: JUMP_LAND }, { t: 1, pose: GUARD }] },
  stumble: { dur: 0.34, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: STUMBLE }, { t: 1, pose: GUARD }] },
  getup: { dur: 0.62, loop: false, keys: [{ t: 0, pose: GETUP_KNEEL }, { t: 1, pose: IDLE_A }] },
};

type StrikePart = 'handF' | 'handB' | 'elbowF' | 'kneeF' | 'footF' | 'footB';

interface AtkHit {
  at: number;
  dmg: [number, number];
  reach: number;
  /** 不写就用招式的默认部位 */
  part?: StrikePart;
}

interface Atk {
  part: StrikePart;
  hits: AtkHit[];
  hitstop: number;
  /** 打中后对手用哪种反应 */
  react: 'light' | 'heavy' | 'up';
  /** 出招期间的前冲速度 */
  forward?: number;
  /** 只在近距离才出（肘/膝） */
  close?: boolean;
  /** 远距离突进（飞踢/旋踢） */
  far?: boolean;
}

const ATTACKS: Record<string, Atk> = {
  jab: { part: 'handF', hits: [{ at: 0.48, dmg: [7, 12], reach: 1, knock: 150 }], hitstop: 0.045, react: 'light' },
  cross: { part: 'handB', hits: [{ at: 0.54, dmg: [12, 19], reach: 1.05, knock: 230 }], hitstop: 0.06, react: 'heavy' },
  hook: { part: 'handF', hits: [{ at: 0.54, dmg: [13, 20], reach: 1.02, knock: 210 }], hitstop: 0.06, react: 'light' },
  uppercut: { part: 'handB', hits: [{ at: 0.56, dmg: [16, 25], reach: 1.0, knock: 180 }], hitstop: 0.075, react: 'up', close: true, forward: 55 },
  elbow: { part: 'elbowF', hits: [{ at: 0.5, dmg: [14, 22], reach: 1.05, knock: 170 }], hitstop: 0.07, react: 'heavy', close: true, forward: 85 },

  snapKick: { part: 'footF', hits: [{ at: 0.5, dmg: [11, 18], reach: 1.2, knock: 260 }], hitstop: 0.055, react: 'light' },
  pushKick: { part: 'footF', hits: [{ at: 0.52, dmg: [14, 21], reach: 1.3, knock: 340 }], hitstop: 0.065, react: 'heavy' },
  sideKick: { part: 'footF', hits: [{ at: 0.54, dmg: [18, 27], reach: 1.35, knock: 430 }], hitstop: 0.08, react: 'heavy' },
  roundKick: { part: 'footF', hits: [{ at: 0.54, dmg: [16, 24], reach: 1.3, knock: 300 }], hitstop: 0.075, react: 'heavy' },
  axeKick: { part: 'footF', hits: [{ at: 0.58, dmg: [17, 26], reach: 1.2, knock: 240 }], hitstop: 0.075, react: 'heavy' },
  spinKick: { part: 'footB', hits: [{ at: 0.72, dmg: [22, 33], reach: 1.4, knock: 500 }], hitstop: 0.095, react: 'heavy', far: true },
  flyKick: { part: 'footF', hits: [{ at: 0.48, dmg: [18, 27], reach: 1.3, knock: 380 }], hitstop: 0.08, react: 'heavy', forward: 150, far: true },
  scissorKick: {
    part: 'footF',
    hits: [
      { at: 0.38, dmg: [9, 15], reach: 1.2, knock: 120 },
      { at: 0.58, dmg: [12, 19], reach: 1.2, knock: 260, part: 'footB' },
    ],
    hitstop: 0.06,
    react: 'heavy',
    forward: 90,
    far: true,
  },
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
  spin: lerp(a.spin, b.spin, k),
  yaw: lerp(a.yaw, b.yaw, k),
  armUBD: lerp(a.armUBD, b.armUBD, k),
  armUFD: lerp(a.armUFD, b.armUFD, k),
  armLBD: lerp(a.armLBD, b.armLBD, k),
  armLFD: lerp(a.armLFD, b.armLFD, k),
  legUBD: lerp(a.legUBD, b.legUBD, k),
  legUFD: lerp(a.legUFD, b.legUFD, k),
  legLBD: lerp(a.legLBD, b.legLBD, k),
  legLFD: lerp(a.legLFD, b.legLFD, k),
});

/** 出拳/出腿的「命中帧」用 easeOutBack，让动作更脆 */
const PUNCHY = new Set<Pose>([
  JAB_HIT, CROSS_HIT, HOOK_HIT, UPPER_HIT, ELBOW_HIT,
  SNAP_HIT, PUSH_HIT, SIDE_HIT, ROUND_HIT, AXE_HIT,
  SPIN_KICK, FLY_AIR, SCISSOR_A, SCISSOR_B,
]);
const sampleClip = (clip: Clip, t: number): Pose => {
  const tt = clip.loop ? ((t % 1) + 1) % 1 : Math.min(0.9999, Math.max(0, t));
  const keys = clip.keys;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (tt >= a.t && tt <= b.t) {
      const span = b.t - a.t || 1;
      const k = (tt - a.t) / span;
      const punchy = PUNCHY.has(b.pose);
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

export type Decision =
  | 'approach'
  | 'retreat'
  | 'block'
  | 'wait'
  | 'jump'
  | 'jab'
  | 'cross'
  | 'hook'
  | 'uppercut'
  | 'elbow'
  | 'snapKick'
  | 'pushKick'
  | 'sideKick'
  | 'roundKick'
  | 'axeKick'
  | 'spinKick'
  | 'flyKick'
  | 'scissorKick';

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

export interface FightOptions {
  /** 画布元素 id，默认 fight-canvas */
  canvasId?: string;
  /** 演示模式：按顺序逐个播放招式并标注 */
  demo?: boolean;
}

export function initFightBand(opts: FightOptions = {}): void {
  const canvas = document.getElementById(opts.canvasId ?? 'fight-canvas') as HTMLCanvasElement | null;
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

  type State =
    | 'idle'
    | 'walk'
    | 'approach'
    | 'retreat'
    | 'block'
    | 'jump'
    | 'down'
    | 'getup'
    | 'hurtLight'
    | 'hurtHeavy'
    | 'hurtUp'
    | 'stumble'
    | 'jab'
    | 'cross'
    | 'hook'
    | 'uppercut'
    | 'elbow'
    | 'snapKick'
    | 'pushKick'
    | 'sideKick'
    | 'roundKick'
    | 'axeKick'
    | 'spinKick'
    | 'flyKick'
    | 'scissorKick';

  interface Fighter {
    x: number;
    facing: number;
    hp: number;
    maxHp: number;
    state: State;
    clipT: number;
    clipDur: number;
    pose: Pose;
    hitDone: boolean[];
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
    /** 被击后的踉跄剩余时间 */
    stagger: number;
    /** 当前哪只手臂在镜头近侧（防闪烁的滞后量） */
    armFront: 'B' | 'F';
    /** 体型：游侠（瘦高带剑）或战士（宽厚） */
    build: 'ranger' | 'warrior';
    /** 无敌帧剩余时间（闪避用） */
    invuln: number;
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
    hitDone: [],
    flash: 0,
    bob: rand(0, 10),
    stun: 0,
    cool: rand(0.4, 1.6),
    walkPhase: rand(0, 1),
    partner: i % 2 === 0 ? i + 1 : i - 1,
    skin,
    scale: (i % 2 === 0 ? rand(0.88, 0.95) : rand(1.0, 1.08)),
    build: (i % 2 === 0 ? 'warrior' : 'ranger') as 'warrior' | 'ranger',
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
    stagger: 0,
    armFront: 'F',
    build: 'warrior',
    invuln: 0,
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

  // 透视焦距：越大越接近正交投影，越小透视越强
  const FOCAL = 320;

  const place = (f: Fighter) => {
    const j = fk(f.pose, f.facing < 0);
    const lowFeet = Math.max(j.footB.y, j.footF.y);
    const dy = groundY() - lowFeet - f.pose.lift - (1 - f.scale) * 20;
    const yaw = f.pose.yaw || 0;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const out = {} as Record<keyof Joints, Pt>;
    for (const k of Object.keys(j) as (keyof Joints)[]) {
      const q = j[k];
      // 绕竖轴转体（真三维转身，不是翻面）
      const x1 = q.x * cy + q.z * sy;
      const z1 = -q.x * sy + q.z * cy;
      // 透视：离镜头越远越小
      const persp = Math.max(0.9, Math.min(1.1, FOCAL / (FOCAL + z1)));
      out[k] = {
        x: f.x + f.facing * x1 * f.scale * persp,
        y: dy + q.y * f.scale * persp,
        z: z1,
      };
    }
    return { world: out, dy };
  };

  /** 拳头到对手躯干的距离（判定是否真的打到了） */
  const contactCheck = (attacker: Fighter, target: Fighter, reachMul: number, part: StrikePart): { hit: boolean; at: Pt } => {
    const aw = place(attacker).world;
    const tw = place(target).world;
    const fist = aw[part as keyof Joints];
    const fistReach = reachMul;
    // 目标躯干当成一条线段（骨盆↔胸腔），算拳头到它的距离
    // 受击盒：骨盆 → 头（含躯干和头，打头/上勾拳都算命中）
    const a = tw.pelvis;
    const b = tw.head;
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
    // 起跳同时进入闪避无敌帧
    if (s === 'jump') f.invuln = 0.34;
    f.state = s;
    f.clipT = 0;
    f.clipDur = dur ?? CLIPS[s]?.dur ?? 0.3;
    f.hitDone = [];
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

  const ATTACK_KEYS = Object.keys(ATTACKS);

  /** 按距离筛选可用招式，再按「伤害越高权重越低」加权随机 */
  const pickAttack = (f: Fighter, d: number): Decision => {
    const pool = ATTACK_KEYS.filter((k) => {
      const a = ATTACKS[k];
      if (a.close && d > 36) return false;
      if (a.far && d < 28) return false;
      if (!a.close && !a.far && d > 56) return false;
      return true;
    });
    const list = pool.length ? pool : ['jab'];
    const weights = list.map((k) => {
      const a = ATTACKS[k];
      const power = a.hits.reduce((s, h) => s + (h.dmg[0] + h.dmg[1]) / 2, 0);
      // 重招概率低一些；连击招式再打个折
      return Math.max(0.3, 24 / power) * (a.hits.length > 1 ? 0.75 : 1);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < list.length; i++) {
      r -= weights[i];
      if (r <= 0) return list[i] as Decision;
    }
    return list[0] as Decision;
  };
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
    // 在攻击距离内：按距离 + 性格加权选招
    if (f.cool <= 0) {
      // 偶尔跳开闪避
      if (Math.random() < 0.12) return 'jump';
      return pickAttack(f, d);
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
      case 'jump':
        setState(f, 'jump');
        f.cool = rand(0.4, 0.9);
        break;
      case 'wait':
        setState(f, 'idle');
        break;
      default: {
        // 其余都是 ATTACKS 里的招式
        const name = d as string;
        if (ATTACKS[name]) {
          setState(f, name as State);
          f.cool = rand(0.3, 0.85);
          if (opp) f.facing = opp.x >= f.x ? 1 : -1;
        } else {
          setState(f, 'idle');
        }
        break;
      }
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

  /** 两人之间保持最小间距，防止飞踢冲过头穿模重叠 */
  const keepDistance = (f: Fighter) => {
    const opp = fighters[f.partner];
    if (!opp) return;
    const minGap = 19 * Math.max(f.scale, opp.scale);
    const dx = f.x - opp.x;
    if (Math.abs(dx) < minGap) {
      const s = dx === 0 ? (f.facing >= 0 ? -1 : 1) : Math.sign(dx);
      f.x = opp.x + s * minGap;
      f.x = Math.max(f.minX, Math.min(f.maxX, f.x));
    }
  };
  /* ---------- 演示模式：逐个播放每个招式并标注 ---------- */

  interface DemoEntry {
    key: string;
    name: string;
    kind: 'attack' | 'react' | 'jump' | 'ko';
  }

  const DEMO_LIST: DemoEntry[] = [
    { key: 'jab', name: '① 刺拳 Jab（前手直拳）', kind: 'attack' },
    { key: 'cross', name: '② 后手直拳 Cross（转体冲拳）', kind: 'attack' },
    { key: 'hook', name: '③ 摆拳 Hook（横拳走弧线）', kind: 'attack' },
    { key: 'uppercut', name: '④ 上勾拳 Uppercut（冲天拳）', kind: 'attack' },
    { key: 'elbow', name: '⑤ 肘击 Elbow（肘尖近身）', kind: 'attack' },
    { key: 'snapKick', name: '⑥ 弹腿 Snap Kick（提膝弹出）', kind: 'attack' },
    { key: 'pushKick', name: '⑦ 正蹬 Push Kick（整腿前推）', kind: 'attack' },
    { key: 'sideKick', name: '⑧ 侧踹 Side Kick（后仰平蹬）', kind: 'attack' },
    { key: 'roundKick', name: '⑨ 鞭腿 Round Kick（横扫到头部）', kind: 'attack' },
    { key: 'axeKick', name: '⑩ 下劈腿 Axe Kick（抬过头再下砸）', kind: 'attack' },
    { key: 'spinKick', name: '⑪ 后旋踢 Spinning Kick（转体一圈）', kind: 'attack' },
    { key: 'flyKick', name: '⑫ 腾空飞踢 Flying Kick（跳起前冲）', kind: 'attack' },
    { key: 'scissorKick', name: '⑬ 双飞脚 Scissor Kick（两段连击）', kind: 'attack' },
    { key: 'hurtLight', name: '⑭ 受击·轻（头猛后仰）', kind: 'react' },
    { key: 'hurtHeavy', name: '⑮ 受击·重（弓身缩起）', kind: 'react' },
    { key: 'hurtUp', name: '⑯ 受击·下巴（仰头踉跄）', kind: 'react' },
    { key: 'block', name: '⑰ 格挡 Block（双臂收紧）', kind: 'react' },
    { key: 'jump', name: '⑱ 跳跃 Jump（起跳闪避）', kind: 'jump' },
    { key: 'ko', name: '⑲ 倒地 → 起身 KO & Get Up', kind: 'ko' },
  ];

  let demoIdx = 0;
  let demoTimer = 0;
  let demoPaused = false;
  let demoSlow = false;

  const demoDur = (e: DemoEntry) => {
    if (e.kind === 'attack') return (CLIPS[e.key]?.dur ?? 0.6) + 0.65;
    if (e.kind === 'react') return (CLIPS[e.key]?.dur ?? 0.4) + 0.55;
    if (e.kind === 'ko') return 3.0;
    return 1.3;
  };

  const startDemoEntry = (i: number) => {
    if (!opts.demo) return;
    const n = DEMO_LIST.length;
    demoIdx = ((i % n) + n) % n;
    demoTimer = 0;
    const e = DEMO_LIST[demoIdx];
    const a = fighters[0];
    const d = fighters[1];
    if (!a || !d) return;

    // 每次演示都回到同样的站位与姿势，方便逐个对比
    const cx = W / 2;
    a.x = cx - 30;
    a.facing = 1;
    a.kb = 0;
    a.hp = a.maxHp;
    a.ragdoll = null;
    a.pose = { ...GUARD };
    a.state = 'idle';
    a.clipT = 0;
    a.clipDur = CLIPS.idle.dur;

    d.x = cx + 30;
    d.facing = -1;
    d.kb = 0;
    d.hp = d.maxHp;
    d.ragdoll = null;
    d.pose = { ...GUARD };
    d.state = 'idle';
    d.clipT = 0;
    d.clipDur = CLIPS.idle.dur;

    if (e.kind === 'attack') {
      setState(a, e.key as State);
    } else if (e.kind === 'react') {
      setState(d, e.key as State);
    } else if (e.kind === 'jump') {
      setState(a, 'jump');
    } else if (e.kind === 'ko') {
      d.hp = 0;
      startRagdoll(d);
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

    // 演示模式：自动切到下一个招式，并保持防守方不死
    if (opts.demo) {
      demoTimer += dt * (demoSlow ? 0.35 : 1);
      const dd = fighters[1];
      if (dd && dd.state !== 'down' && dd.state !== 'getup') dd.hp = dd.maxHp;
      if (!demoPaused && demoTimer > demoDur(DEMO_LIST[demoIdx])) startDemoEntry(demoIdx + 1);
    }

    for (const f of fighters) {
      f.bob += dt;

      f.flash = Math.max(0, f.flash - dt * 4.5);
      if (f.invuln > 0) f.invuln = Math.max(0, f.invuln - dt);

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

      /* --- 攻击命中判定（真·空间碰撞，支持多段打击） --- */
      const atk = ATTACKS[f.state];
      if (atk) {
        // 出招期间的前冲（飞踢、双飞脚等会真的扑过来）
        if (atk.forward && prog < 0.62) {
          f.x += f.facing * atk.forward * dt;
          f.x = Math.max(f.minX, Math.min(f.maxX, f.x));
        }
        for (let hi = 0; hi < atk.hits.length; hi++) {
          const h = atk.hits[hi];
          if (f.hitDone[hi] || prog < h.at) continue;
          f.hitDone[hi] = true;
          if (!opp || opp.state === 'down') continue;
          // 对方在闪避无敌帧内 -> 打空
          if (opp.invuln > 0) {
            spawn(opp.x - f.facing * 8, groundY() - 36, 'rgba(120,200,255,0.75)', 'dust', 5, 0.55);
            continue;
          }

          const { hit, at } = contactCheck(f, opp, h.reach, h.part ?? atk.part);
          if (!hit) {
            // 够不着 = 挥空
            spawn(at.x + f.facing * 12, at.y, 'rgba(120,120,120,0.45)', 'dust', 3, 0.4);
            continue;
          }

          const blocking = opp.state === 'block';
          const dmg = Math.round(rand(h.dmg[0], h.dmg[1]) * (blocking ? 0.22 : 1));
          opp.hp = Math.max(0, opp.hp - dmg);
          shake = Math.max(shake, blocking ? 2 : h.knock > 320 ? 6 : 4);

          if (blocking) {
            spawn(at.x, at.y, '#9AD9FF', 'block', 6, 0.8);
            opp.kb = f.facing * 90;
            f.kb = -f.facing * 60;
            hitstop = Math.max(hitstop, 0.03);
            continue;
          }

          opp.flash = 1;
          opp.kb = f.facing * h.knock;
          hitstop = Math.max(hitstop, atk.hitstop);
          spawn(at.x, at.y, opp.skin.trim, 'hit', h.knock > 320 ? 11 : 7, h.knock > 320 ? 1.35 : 1);

          if (opp.hp <= 0) {
            spawn(at.x, at.y, '#FAC901', 'hit', 14, 1.6);
            startRagdoll(opp);
            break;
          }

          // 按招式决定对手的反应姿态
          opp.stagger = atk.react === 'light' ? 0.22 : 0.4;
          setState(opp, atk.react === 'up' ? 'hurtUp' : atk.react === 'heavy' ? 'hurtHeavy' : 'hurtLight');
          opp.stun = atk.react === 'light' ? 0.2 : atk.react === 'up' ? 0.5 : 0.42;
          opp.cool = Math.max(opp.cool, 0.3);
        }
      }

      /* --- 片段播完：被击后先踉跄后退，再回架势 --- */
      if (!clip.loop && prog >= 1) {
        if (f.stagger > 0 && (f.state === 'hurtLight' || f.state === 'hurtHeavy' || f.state === 'hurtUp')) {
          f.stagger = 0;
          setState(f, 'stumble');
          f.cool = Math.max(f.cool, 0.3);
        } else {
          setState(f, 'idle');
          f.cool = Math.max(f.cool, rand(0.25, 0.8));
        }
        if (f.cool <= 0 && f.stun <= 0 && f.lastDecision > 0.1) {
          f.lastDecision = 0;
          applyDecision(f, opp, decide(f, opp));
        }
      }
    }

    // 位置约束：不许穿模
    for (const f of fighters) keepDistance(f);

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

  const disc = (p: Pt, r: number, fill: string) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.fillStyle = fill;
    ctx.fill();
  };

  const ell = (p: Pt, rx: number, ry: number, rot: number, fill: string) => {
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rx, ry, rot, 0, TAU);
    ctx.fillStyle = fill;
    ctx.fill();
  };

  /** 带描边的锥形肢体 */
  const limb = (a: Pt, b: Pt, ra: number, rb: number, fill: string) => {
    capsule(a, b, ra + 1.3, rb + 1.3, OUTLINE);
    capsule(a, b, ra, rb, fill);
  };

  /** 关节头：圆形覆盖，弯折处不留缺口 */
  const jointCap = (p: Pt, r: number, fill: string) => {
    disc(p, r + 1.25, OUTLINE);
    disc(p, r, fill);
  };

  /** 躯干：宽肩窄腰的曲线轮廓 */
  const torsoShape = (pelvis: Pt, chest: Pt, k: number, fill: string) => {
    const dx = chest.x - pelvis.x;
    const dy = chest.y - pelvis.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const wHip = 7.0 * k;
    const wWaist = 5.6 * k;
    const wChest = 8.6 * k;
    const wShoulder = 9.4 * k;
    const at = (t: number, w: number, side: number): Pt => ({
      x: pelvis.x + ux * len * t + nx * w * side,
      y: pelvis.y + uy * len * t + ny * w * side,
      z: 0,
    });
    const pts = [
      at(-0.05, wHip, -1),
      at(0.3, wWaist, -1),
      at(0.68, wChest, -1),
      at(1.02, wShoulder, -1),
      at(1.14, wShoulder * 0.7, -1),
      at(1.14, wShoulder * 0.7, 1),
      at(1.02, wShoulder, 1),
      at(0.68, wChest, 1),
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

  /** 鞋：脚尖必须朝向「面向」的一侧（facing） */
  const shoe = (foot: Pt, facing: number, k: number, fill: string) => {
    const fx = facing; // 只往面向方向伸
    const heelX = foot.x - fx * 2.6 * k;
    const toeX = foot.x + fx * 6.2 * k;
    const top = foot.y - 1.6 * k;
    const bot = foot.y + 3.4 * k;
    ctx.beginPath();
    ctx.moveTo(heelX, top + 1.2 * k);
    ctx.lineTo(toeX - fx * 1.2 * k, top);
    ctx.quadraticCurveTo(toeX + fx * 0.6 * k, foot.y + 0.4 * k, toeX - fx * 1.6 * k, bot);
    ctx.lineTo(heelX, bot);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.9;
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  /** 手：手掌 + 拇指 + 指节（不再是圆点） */
  const hand = (p: Pt, k: number, fill: string, facing: number) => {
    const palmR = 3.2 * k;
    disc(p, palmR + 1.3, OUTLINE);
    ell({ x: p.x, y: p.y, z: 0 }, palmR * 1.02, palmR * 0.9, 0, fill);
    // 拇指（朝着身体一侧）
    ell({ x: p.x - facing * 1.5 * k, y: p.y + 1.9 * k, z: 0 }, 1.6 * k, 1.3 * k, 0.5, fill);
    // 指节线
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 0.9 * k;
    ctx.beginPath();
    ctx.moveTo(p.x + facing * 0.6 * k, p.y - 1.8 * k);
    ctx.lineTo(p.x + facing * 2.2 * k, p.y - 0.6 * k);
    ctx.moveTo(p.x + facing * 0.2 * k, p.y + 0.2 * k);
    ctx.lineTo(p.x + facing * 2.4 * k, p.y + 1.1 * k);
    ctx.stroke();
  };

  /** 头：颅骨 + 下颌 + 耳朵 + 头发 + 五官，朝向由 facing 决定 */
  const headShape = (
    head: Pt,
    k: number,
    body: string,
    trim: string,
    expr: 'normal' | 'hurt' | 'down',
    side: number,
    faceCam: number
  ) => {
    const rx = L.headR * k;
    const ry = (L.headR + 0.6) * k;

    // 脖子先垫一层（避免下巴和身体之间露空）
    ell({ x: head.x - side * rx * 0.1, y: head.y + ry * 0.95, z: 0 }, rx * 0.5, ry * 0.45, 0, OUTLINE);

    // 后脑勺朝镜头：整头头发，只露耳朵
    if (faceCam < -0.55) {
      ell({ x: head.x, y: head.y - ry * 0.06, z: 0 }, rx + 1.5, ry + 1.5, 0, OUTLINE);
      ctx.beginPath();
      ctx.ellipse(head.x, head.y - ry * 0.06, rx, ry, 0, 0, TAU);
      ctx.fillStyle = trim;
      ctx.fill();
      ell({ x: head.x - side * rx * 0.86, y: head.y + ry * 0.04, z: 0 }, rx * 0.24, ry * 0.3, 0, body);
      return;
    }

    // 正脸朝镜头：两只眼睛、鼻子中线、居中嘴
    if (faceCam > 0.55) {
      ell({ x: head.x, y: head.y - ry * 0.06, z: 0 }, rx + 1.5, ry + 1.5, 0, OUTLINE);
      ell({ x: head.x, y: head.y - ry * 0.06, z: 0 }, rx, ry, 0, body);
      // 头发只盖顶部
      ctx.beginPath();
      ctx.ellipse(head.x, head.y - ry * 0.34, rx * 1.02, ry * 0.8, 0, Math.PI * 0.92, Math.PI * 2.08);
      ctx.closePath();
      ctx.fillStyle = trim;
      ctx.fill();
      // 两只眼睛
      ell({ x: head.x - rx * 0.34, y: head.y + ry * 0.02, z: 0 }, rx * 0.17, ry * 0.18, 0, '#FFFFFF');
      ell({ x: head.x + rx * 0.34, y: head.y + ry * 0.02, z: 0 }, rx * 0.17, ry * 0.18, 0, '#FFFFFF');
      disc({ x: head.x - rx * 0.34, y: head.y + ry * 0.02, z: 0 }, Math.max(0.9, rx * 0.1), '#1b1512');
      disc({ x: head.x + rx * 0.34, y: head.y + ry * 0.02, z: 0 }, Math.max(0.9, rx * 0.1), '#1b1512');
      // 鼻子（小竖线）
      ctx.strokeStyle = '#1b1512';
      ctx.lineWidth = Math.max(0.9, rx * 0.1);
      ctx.beginPath();
      ctx.moveTo(head.x, head.y + ry * 0.12);
      ctx.lineTo(head.x, head.y + ry * 0.28);
      ctx.stroke();
      // 嘴
      ctx.beginPath();
      if (expr === 'normal') {
        ctx.moveTo(head.x - rx * 0.22, head.y + ry * 0.5);
        ctx.lineTo(head.x + rx * 0.22, head.y + ry * 0.5);
      } else {
        ell({ x: head.x, y: head.y + ry * 0.5, z: 0 }, rx * 0.16, ry * 0.14, 0, '#5a1f24');
      }
      ctx.stroke();
      return;
    }

    // 侧脸（side = 脸朝哪一侧）
    ell({ x: head.x, y: head.y - ry * 0.06, z: 0 }, rx + 1.5, ry + 1.5, 0, OUTLINE);
    ell({ x: head.x, y: head.y - ry * 0.06, z: 0 }, rx, ry, 0, body);
    // 下颌 / 下巴
    ell({ x: head.x + side * rx * 0.3, y: head.y + ry * 0.5, z: 0 }, rx * 0.58, ry * 0.46, 0, body);
    // 耳朵
    ell({ x: head.x - side * rx * 0.86, y: head.y + ry * 0.04, z: 0 }, rx * 0.24, ry * 0.3, 0, body);
    // 头发：覆盖颅骨上半与后脑
    ctx.beginPath();
    ctx.ellipse(head.x - side * rx * 0.16, head.y - ry * 0.34, rx * 1.04, ry * 0.86, 0, Math.PI * 0.98, Math.PI * 2.06);
    ctx.closePath();
    ctx.fillStyle = trim;
    ctx.fill();
    // 刘海
    ctx.beginPath();
    ctx.moveTo(head.x - side * rx * 0.2, head.y - ry * 0.9);
    ctx.quadraticCurveTo(head.x + side * rx * 0.75, head.y - ry * 0.7, head.x + side * rx * 0.42, head.y - ry * 0.05);
    ctx.quadraticCurveTo(head.x + side * rx * 0.1, head.y - ry * 0.4, head.x - side * rx * 0.2, head.y - ry * 0.9);
    ctx.fillStyle = trim;
    ctx.fill();
    // 眼睛
    const eyeX = head.x + side * rx * 0.46;
    const eyeY = head.y + ry * 0.02;
    if (expr === 'normal') {
      ell({ x: eyeX, y: eyeY, z: 0 }, rx * 0.2, ry * 0.19, 0, '#FFFFFF');
      disc({ x: eyeX + side * rx * 0.05, y: eyeY, z: 0 }, Math.max(0.9, rx * 0.11), '#1b1512');
      ctx.strokeStyle = '#1b1512';
      ctx.lineWidth = Math.max(1, rx * 0.12);
      ctx.beginPath();
      ctx.moveTo(eyeX - side * rx * 0.24, eyeY - ry * 0.3);
      ctx.lineTo(eyeX + side * rx * 0.24, eyeY - ry * 0.24);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#1b1512';
      ctx.lineWidth = Math.max(1.2, rx * 0.15);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(eyeX - side * rx * 0.2, eyeY - ry * 0.16);
      ctx.lineTo(eyeX + side * rx * 0.2, eyeY);
      ctx.lineTo(eyeX - side * rx * 0.2, eyeY + ry * 0.16);
      ctx.stroke();
    }
    // 鼻子
    ell({ x: head.x + side * rx * 0.8, y: head.y + ry * 0.22, z: 0 }, rx * 0.14, ry * 0.13, 0, body);
    // 嘴
    ctx.strokeStyle = '#1b1512';
    ctx.lineWidth = Math.max(0.9, rx * 0.1);
    ctx.beginPath();
    if (expr === 'normal') {
      ctx.moveTo(head.x + side * rx * 0.36, head.y + ry * 0.5);
      ctx.lineTo(head.x + side * rx * 0.72, head.y + ry * 0.48);
    } else {
      ell({ x: head.x + side * rx * 0.52, y: head.y + ry * 0.5, z: 0 }, rx * 0.16, ry * 0.14, 0, '#5a1f24');
    }
    ctx.stroke();
  };

  const drawFigure = (
    get: (k: string) => Pt,
    k: number,
    body: string,
    trim: string,
    dark: string,
    expr: 'normal' | 'hurt' | 'down',
    facing: number,
    camFace: number,
    gear: 'ranger' | 'warrior',
    side: number,
    torsoScale: number
  ) => {
    const pelvis = get('pelvis');
    const chest = get('chest');
    const head = get('head');

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const depthAlpha = (z: number) => Math.max(0.85, Math.min(1.0, 0.9 + (z + 14) * 0.006));

    const zB = (get('elbowB').z || 0) + (get('handB').z || 0);
    const zF = (get('elbowF').z || 0) + (get('handF').z || 0);
    const backArmIsFarther = zB <= zF;

    const drawArm = (which: 'B' | 'F', base: string) => {
      const s = get(which === 'B' ? 'shoulderB' : 'shoulderF');
      const e = get(which === 'B' ? 'elbowB' : 'elbowF');
      const h = get(which === 'B' ? 'handB' : 'handF');
      ctx.save();
      ctx.globalAlpha *= depthAlpha(((e.z || 0) + (h.z || 0)) / 2);
      limb(s, e, 4.5 * k, 3.7 * k, base);
      jointCap(e, 3.7 * k, base);
      limb(e, h, 3.5 * k, 3.0 * k, base);
      hand(h, k, base, facing);
      ctx.restore();
    };

    const drawLeg = (which: 'B' | 'F', base: string) => {
      const hip = get(which === 'B' ? 'hipB' : 'hipF');
      const knee = get(which === 'B' ? 'kneeB' : 'kneeF');
      const foot = get(which === 'B' ? 'footB' : 'footF');
      ctx.save();
      ctx.globalAlpha *= depthAlpha(((knee.z || 0) + (foot.z || 0)) / 2);
      limb(hip, knee, (which === 'B' ? 5.0 : 5.6) * k, (which === 'B' ? 4.0 : 4.5) * k, base);
      jointCap(knee, (which === 'B' ? 4.0 : 4.5) * k, base);
      limb(knee, foot, (which === 'B' ? 3.8 : 4.2) * k, 3.2 * k, base);
      shoe(foot, facing, k, base);
      ctx.restore();
    };

    drawArm(backArmIsFarther ? 'B' : 'F', dark);
    drawLeg('B', dark);

    torsoShape(pelvis, chest, k * torsoScale, body);

    // 腰带
    const dx = chest.x - pelvis.x;
    const dy = chest.y - pelvis.y;
    const dl = Math.hypot(dx, dy) || 1;
    const nx = -dy / dl;
    const ny = dx / dl;
    const bw = 6.4 * k;
    const bcx = pelvis.x + dx * 0.26;
    const bcy = pelvis.y + dy * 0.26;
    capsule({ x: bcx + nx * bw, y: bcy + ny * bw, z: 0 }, { x: bcx - nx * bw, y: bcy - ny * bw, z: 0 }, 2.0 * k, 2.0 * k, trim);

    // 脖子
    const neckA: Pt = { x: chest.x + (chest.x - pelvis.x) * 0.1, y: chest.y + (chest.y - pelvis.y) * 0.1, z: 0 };
    limb(neckA, { x: head.x - facing * 3 * k, y: head.y + L.headR * k * 0.7, z: 0 }, 3.5 * k, 3.2 * k, dark);

    headShape(head, k, body, trim, expr, side, camFace);

    // 装备：游侠背剑 + 围巾；战士肩甲
    if (gear === 'ranger') {
      const sB = get('shoulderB');
      const hB = get('hipB');
      const dxg = sB.x - hB.x;
      const dyg = sB.y - hB.y;
      const lg = Math.hypot(dxg, dyg) || 1;
      const ux = dxg / lg;
      const uy = dyg / lg;
      // 剑鞘
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 3.4 * k;
      ctx.beginPath();
      ctx.moveTo(sB.x - ux * 3, sB.y - uy * 3);
      ctx.lineTo(hB.x + ux * 1.5, hB.y + uy * 1.5);
      ctx.stroke();
      // 剑柄
      ctx.strokeStyle = trim;
      ctx.lineWidth = 2.2 * k;
      ctx.beginPath();
      ctx.moveTo(sB.x + ux * 1.5, sB.y + uy * 1.5);
      ctx.lineTo(sB.x + ux * 9, sB.y + uy * 9);
      ctx.stroke();
      // 围巾
      ctx.fillStyle = trim;
      ctx.beginPath();
      ctx.moveTo(neckA.x, neckA.y - 1 * k);
      ctx.lineTo(neckA.x - facing * 7 * k, neckA.y + 3 * k);
      ctx.lineTo(neckA.x - facing * 2 * k, neckA.y + 6 * k);
      ctx.closePath();
      ctx.fill();
    } else {
      // 战士肩甲
      jointCap(get('shoulderF'), 4.6 * k, trim);
      jointCap(get('shoulderB'), 4.6 * k, trim);
    }

    drawLeg('F', body);
    drawArm(backArmIsFarther ? 'F' : 'B', body);
  };


  const drawFighter = (f: Fighter) => {
    const flashing = f.flash > 0.25;
    const body = flashing ? '#FFFFFF' : f.skin.body;
    const trim = flashing ? '#F4F4F4' : f.skin.trim;
    const dark = flashing ? '#E8E8E8' : f.skin.dark;
    const expr: 'normal' | 'hurt' | 'down' =
      f.state === 'down' ? 'down' : f.state === 'hurtLight' || f.state === 'hurtHeavy' || flashing ? 'hurt' : 'normal';

    // 体型：战士更宽（宽度放大），游侠更瘦
    const bulk = f.build === 'warrior' ? 1.22 : 0.84;
    const yaw = f.pose.yaw || 0;
    const faceCam = -Math.sin(yaw);
    const side = Math.cos(yaw) >= 0 ? f.facing : -f.facing;
    const torsoScale = 0.55 + 0.45 * Math.abs(Math.cos(yaw));
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

    // 转体（后旋踢等）：用横向缩放模拟身体转过来，cos 为负时自动镜像
    const spin = f.pose.spin || 0;
    if (Math.abs(spin) > 0.01) {
      const pw = place(f).world.pelvis;
      const sx = Math.cos(spin);
      ctx.translate(pw.x, pw.y);
      ctx.scale(sx >= 0 ? Math.max(0.08, sx) : Math.min(-0.08, sx), 1);
      ctx.translate(-pw.x, -pw.y);
    }
    const alpha = f.state === 'getup' ? Math.max(0.02, f.getupFade) : 1;
    ctx.save();
    ctx.globalAlpha = alpha;

    if (f.state === 'down' && f.ragdoll) {
      const rd = f.ragdoll;
      drawFigure(
        (key) => ({ x: (rd[key] as Pt).x, y: (rd[key] as Pt).y }),
        f.scale * bulk,
        body,
        trim,
        dark,
        'down',
        f.facing,
        faceCam,
        f.build,
        side,
        torsoScale
      );
    } else {
      const { world } = place(f);
      drawFigure((key) => world[key as keyof Joints], f.scale * bulk, body, trim, dark, expr, f.facing, faceCam, f.build, side, torsoScale);
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

    // 演示模式：顶部显示当前招式名与序号
    if (opts.demo) {
      const e = DEMO_LIST[demoIdx];
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = 'bold 15px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(20,16,12,0.78)';
      ctx.fillText(`${demoIdx + 1} / ${DEMO_LIST.length}   ${e.name}`, W / 2, 24);
      ctx.font = '11px ui-monospace, "Cascadia Mono", monospace';
      ctx.fillStyle = 'rgba(20,16,12,0.42)';
      ctx.fillText('← → 逐个查看 · 空格 暂停 · S 慢放', W / 2, 41);
      ctx.restore();
    }
  };

  /* ---------- 生命周期 ---------- */

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const want = opts.demo ? 2 : W < 620 ? 2 : 4;
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
  if (opts.demo) startDemoEntry(0);
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

  // 演示模式的键盘控制
  if (opts.demo) {
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowRight') {
        startDemoEntry(demoIdx + 1);
        ev.preventDefault();
      } else if (ev.key === 'ArrowLeft') {
        startDemoEntry(demoIdx - 1);
        ev.preventDefault();
      } else if (ev.key === ' ') {
        demoPaused = !demoPaused;
        ev.preventDefault();
      } else if (ev.key === 's' || ev.key === 'S') {
        demoSlow = !demoSlow;
      }
    });
  }
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
    /** 演示模式控制 */
    demo: {
      list: DEMO_LIST.map((e, i) => ({ i, key: e.key, name: e.name })),
      go: (i: number) => startDemoEntry(i),
      pause: (v?: boolean) => {
        demoPaused = v ?? !demoPaused;
        return demoPaused;
      },
      slow: (v?: boolean) => {
        demoSlow = v ?? !demoSlow;
        return demoSlow;
      },
      get idx() {
        return demoIdx;
      },
      get paused() {
        return demoPaused;
      },
      get slowOn() {
        return demoSlow;
      },
    },
  };
}
