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

const IDLE_A = P({ lean: 0.05, armUB: 0.2, armLB: 0.35, armUF: -0.15, armLF: 0.3, legUB: -0.12, legLB: 0, legUF: 0.12, legLF: 0.05 });
const IDLE_B = P({ lean: 0.09, head: -0.05, armUB: 0.26, armLB: 0.4, armUF: -0.09, armLF: 0.35, legUB: -0.09, legLB: 0, legUF: 0.09, legLF: 0.06 });

/** 格斗架势：双手抬起护住面门 */
const GUARD = P({ lean: 0.15, head: -0.06, armUB: 1.0, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legLB: 0, legUF: 0.34, legLF: 0.12 });

/** 格挡：双臂抬高收紧 */
const BLOCK = P({ lean: -0.05, head: 0.12, armUB: 1.5, armLB: 2.5, armUF: 1.55, armLF: 2.55, legUB: -0.34, legLB: 0, legUF: 0.36, legLF: 0.14 });

/* ---------------- 拳法 ---------------- */

const JAB_WIND = P({ lean: 0.1, head: -0.06, armUB: 1.05, armLB: 2.0, armUF: 0.72, armLF: 2.15, legUB: -0.28, legLB: 0, legUF: 0.32, legLF: 0.1 });
const JAB_HIT = P({ lean: 0.3, head: -0.02, armUB: 0.9, armLB: 2.05, armUF: 1.62, armLF: 0.0, legUB: -0.42, legLB: 0, legUF: 0.5, legLF: 0.04 });

const CROSS_WIND = P({ lean: -0.14, head: -0.1, armUB: -1.05, armLB: 1.75, armUBD: -0.45, armUF: 1.0, armLF: 1.9, armUFD: 0.25, legUB: -0.18, legLB: 0, legUF: 0.26, legLF: 0, yaw: -0.32 });
const CROSS_HIT = P({ lean: 0.32, head: 0.08, armUB: 1.72, armLB: 0.02, armUBD: -0.12, armUF: 0.42, armLF: 1.98, armUFD: 0.3, legUB: -0.52, legLB: 0, legUF: 0.58, legLF: 0, yaw: 0.34 });

/** 摆拳（横拳）：手臂保持弯曲，末端走弧线 */
const HOOK_WIND = P({ lean: -0.1, head: -0.05, armUB: 0.9, armLB: 1.9, armUF: -0.35, armLF: 1.1, armUFD: -1.0, legUB: -0.24, legLB: 0, legUF: 0.3, legLF: 0, yaw: -0.2 });
const HOOK_HIT = P({ lean: 0.34, head: 0.1, armUB: 0.95, armLB: 1.95, armUF: 1.62, armLF: 1.05, armUFD: 0.45, armLFD: 0.2, legUB: -0.46, legLB: 0, legUF: 0.5, legLF: 0, yaw: 0.26 });

/** 上勾拳（冲天拳）：先蹲，再蹬腿上冲 */
const UPPER_WIND = P({ lean: 0.34, head: 0.08, armUB: 0.1, armLB: 2.35, armUBD: -0.75, armUF: 0.85, armLF: 1.9, legUB: 0.4, legLB: -0.95, legUF: 0.45, legLF: -1.0, yaw: -0.15 });
const UPPER_HIT = P({ lean: 0.02, head: 0.16, armUB: 1.95, armLB: 0.22, armUBD: -0.3, armUF: 0.75, armLF: 1.85, legUB: -0.1, legLB: 0, legUF: 0.16, legLF: 0, yaw: 0.06 });

/** 肘击：前臂折死，用肘尖打 */
const ELBOW_WIND = P({ lean: 0.14, head: -0.04, armUB: 1.0, armLB: 2.1, armUF: 0.55, armLF: 2.4, armUFD: -0.6, legUB: -0.26, legLB: 0, legUF: 0.32, legLF: 0, yaw: -0.14 });
const ELBOW_HIT = P({ lean: 0.46, head: 0.08, armUB: 0.95, armLB: 2.05, armUF: 1.5, armLF: 2.42, armUFD: -0.12, legUB: -0.5, legLB: 0, legUF: 0.5, legLF: 0, yaw: 0.12 });

/* ---------------- 腿法 ---------------- */

/** 弹腿（屈伸性）：提膝后小腿弹出 */
const SNAP_UP = P({ lean: -0.1, head: -0.04, armUB: 0.7, armLB: 1.6, armUF: 0.95, armLF: 1.4, legUB: 0.1, legLB: 0, legUF: 0.92, legLF: -1.6 });
const SNAP_HIT = P({ lean: -0.22, head: -0.05, armUB: 0.35, armLB: 1.3, armUF: 0.6, armLF: 1.15, legUB: 0.14, legLB: 0, legUF: 1.26, legLF: 0.05 });

/** 正蹬：整条腿往前推直 */
const PUSH_UP = P({ lean: -0.12, head: -0.03, armUB: 0.8, armLB: 1.5, armUF: 1.0, armLF: 1.3, legUB: 0.1, legLB: 0, legUF: 0.95, legLF: -1.4 });
const PUSH_HIT = P({ lean: -0.32, head: -0.04, armUB: 0.2, armLB: 1.1, armUF: 0.4, armLF: 1.0, legUB: 0.14, legLB: 0, legUF: 1.36, legLF: 0.06 });

/** 侧踹：大幅后仰，腿平着蹬出去 */
const SIDE_UP = P({ lean: -0.36, head: -0.05, armUB: 0.4, armLB: 1.3, armUF: 0.6, armLF: 1.2, legUB: 0.1, legLB: 0, legUF: 1.1, legLF: -1.3 });
const SIDE_HIT = P({ lean: -0.6, head: -0.08, armUB: -0.8, armLB: 0.6, armUF: -0.95, armLF: 0.7, legUB: 0.12, legLB: 0, legUF: 1.56, legLF: 0.02 });

/** 鞭腿（横扫）：腿摆到头部高度，用深度外展做出「从外侧抡进来」的弧线 */
const ROUND_UP = P({ lean: -0.24, head: -0.04, armUB: 0.55, armLB: 1.4, armUF: 0.9, armLF: 1.25, legUB: 0.1, legLB: 0, legUF: 1.5, legLF: -1.0, legUFD: -0.35 });
const ROUND_HIT = P({ lean: -0.5, head: -0.1, armUB: -0.35, armLB: 0.9, armUF: 0.3, armLF: 1.2, legUB: 0.12, legLB: 0, legUF: 1.95, legLF: 0.05, legUFD: 0.35 });

/** 下劈腿（挂面腿）：抬过头 → 狠狠下砸 */
const AXE_UP = P({ lean: -0.46, head: -0.1, armUB: 0.5, armLB: 1.2, armUF: 1.3, armLF: 0.9, legUB: 0.12, legLB: 0, legUF: 2.45, legLF: -0.15 });
const AXE_HIT = P({ lean: 0.3, head: 0.05, armUB: 0.1, armLB: 1.0, armUF: 0.35, armLF: 1.1, legUB: 0.1, legLB: 0, legUF: 1.15, legLF: 0.05 });

/**
 * 后旋踢：绕支撑脚转体一圈。
 * 物理链条 —— 蓄力提膝 → 身体转起来（腿收着，转动惯量小才转得快）
 * → 转到半圈时腿甩成水平并绷直（角动量甩到脚上）
 * → 身体继续转，把这条绷直的腿「扫」过对手 → 收势落地。
 * 关键：腿扫出去之后自身角度不再变化，是身体继续转带着它走。
 */
const SPIN_TUCK = P({ lean: 0.18, head: -0.02, armUB: 0.75, armLB: 1.7, armUF: 1.1, armLF: 1.6, legUB: 1.0, legLB: -1.6, legUBD: 0.15, legUF: -0.12, legLF: 0, legUFD: 0, yaw: 0 });
/** 转体 1/4：身体刚开始转，腿仍收在身前（团身 = 转得快） */
const SPIN_TURN_A = P({ lean: 0.1, head: -1.55, armUB: 0.6, armLB: 1.5, armUF: 1.0, armLF: 1.4, legUB: 0.88, legLB: -1.65, legUBD: 0.2, legUF: -0.05, legLF: 0, legUFD: 0, yaw: 1.75 });
/** 转体 3/4：身体转到背面，腿开始打开、膝盖还没伸直 */
const SPIN_TURN_B = P({ lean: -0.02, head: -1.45, armUB: 0.1, armLB: 1.2, armUF: 0.5, armLF: 1.15, legUB: -0.8, legLB: -0.72, legUBD: -0.1, legUF: 0.04, legLF: 0, legUFD: 0, yaw: 2.62 });
/** 命中：身体正好转满半圈，腿已被甩成水平并绷直，脚扫到对手 */
const SPIN_KICK = P({ lean: -0.22, head: 0.18, armUB: -0.5, armLB: 0.8, armUF: 0.6, armLF: 0.9, legUB: -1.62, legLB: -0.05, legUBD: -0.25, legUF: 0.12, legLF: 0, legUFD: 0, yaw: 3.14 });
/** 扫过：身体继续转，腿保持绷直被带着扫过去（follow through） */
const SPIN_THROUGH = P({ lean: -0.32, head: 0.55, armUB: -0.78, armLB: 0.7, armUF: 0.35, armLF: 0.8, legUB: -1.62, legLB: -0.05, legUBD: -0.25, legUF: 0.16, legLF: 0, legUFD: 0, yaw: 4.35 });
const SPIN_END = P({ lean: 0.1, head: -0.02, armUB: 1.0, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.28, legLB: 0, legUBD: 0, legUF: 0.32, legLF: 0, yaw: 6.28 });

/** 腾空飞踢：跳起来前冲踢 */
const FLY_CROUCH = P({ lean: 0.34, head: -0.1, armUB: -0.6, armLB: 0.8, armUF: -0.7, armLF: 0.9, legUB: 0.62, legLB: -1.35, legUF: 0.58, legLF: -1.6 });
const FLY_AIR = P({ lean: -0.08, head: 0.06, armUB: 0.9, armLB: 1.1, armUF: 1.1, armLF: 1.0, legUB: -0.2, legLB: 0, legUF: 1.52, legLF: 0, lift: 22 });
const FLY_LAND = P({ lean: 0.4, head: -0.14, armUB: -0.5, armLB: 0.95, armUF: -0.6, armLF: 1.0, legUB: 0.62, legLB: -1.3, legUF: 0.5, legLF: -1.4 });

/** 双飞脚：腾空剪腿，两脚先后各一击 */
const SCISSOR_CROUCH = P({ lean: 0.36, head: -0.1, armUB: -0.55, armLB: 0.85, armUF: -0.65, armLF: 0.95, legUB: 0.6, legLB: -1.3, legUF: 0.56, legLF: -1.5 });
const SCISSOR_A = P({ lean: 0.05, head: 0.05, armUB: 0.9, armLB: 1.2, armUF: 1.2, armLF: 1.1, legUB: -0.55, legLB: 0, legUF: 1.45, legLF: 0, lift: 30 });
const SCISSOR_B = P({ lean: 0.05, head: 0.05, armUB: 1.2, armLB: 1.1, armUF: 0.9, armLF: 1.2, legUB: 1.35, legLB: 0, legUF: -0.35, legLF: 0, lift: 30 });
const SCISSOR_LAND = P({ lean: 0.42, head: -0.14, armUB: -0.5, armLB: 0.9, armUF: -0.6, armLF: 1.0, legUB: 0.66, legLB: -1.35, legUF: 0.6, legLF: -1.45 });

/* ---------------- 反应 / 位移 ---------------- */

const HURT_LIGHT = P({ lean: -0.28, head: -0.6, armUB: -0.45, armLB: 0.9, armUF: -0.7, armLF: 1.05, legUB: -0.34, legLB: 0, legUF: 0.3, legLF: 0.14 });
const HURT_HEAVY = P({ lean: 0.45, head: 0.5, armUB: 0.35, armLB: 1.6, armUF: 0.15, armLF: 1.75, legUB: 0.3, legLB: -0.55, legUF: 0.42, legLF: -0.7 });
/** 被上勾拳打中：仰头 */
const HURT_UP = P({ lean: -0.42, head: -0.85, armUB: -0.7, armLB: 1.1, armUF: -0.9, armLF: 1.2, legUB: -0.3, legLB: 0, legUF: 0.34, legLF: 0.16 });

const JUMP_CROUCH = P({ lean: 0.34, head: -0.12, armUB: -0.65, armLB: 0.8, armUF: -0.75, armLF: 0.9, legUB: 0.62, legLB: -1.35, legUF: 0.58, legLF: -1.6 });
const JUMP_AIR = P({ lean: 0.1, head: 0.08, armUB: 1.05, armLB: 1.5, armUF: 1.2, armLF: 1.45, legUB: 0.8, legLB: -1.3, legUF: 0.95, legLF: -1.45, lift: 30 });
const JUMP_LAND = P({ lean: 0.4, head: -0.14, armUB: -0.55, armLB: 0.95, armUF: -0.65, armLF: 1.05, legUB: 0.7, legLB: -1.45, legUF: 0.64, legLF: -1.6 });

/** 踉跄：重心后倒，手臂张开保持平衡，一只脚向后撤 */
const STUMBLE = P({ lean: -0.24, head: -0.3, armUB: -0.65, armLB: 1.25, armUF: -0.45, armLF: 1.15, legUB: -0.5, legLB: 0, legUF: 0.4, legLF: 0.22 });
const GETUP_KNEEL = P({ lean: 0.55, head: 0.15, armUB: 0.7, armLB: 1.4, armUF: 0.9, armLF: 1.2, legUB: 1.5, legLB: -2.4, legUF: 0.35, legLF: -1.5 });

interface Clip {
  dur: number;
  loop: boolean;
  keys: { t: number; pose: Pose }[];
}

/* ===== 武器专属招式姿势 ===== */
/** 突刺（长枪兵）：后坐蓄力 → 双臂持枪前送，弓步跟进 */
const THRUST_WIND = P({ lean: -0.12, head: 0.02, armUB: -0.5, armLB: 1.6, armUBD: 0.25, armUF: -0.4, armLF: 1.5, armUFD: 0.25, legUB: -0.4, legLB: 0, legUF: 0.5, legLF: 0, yaw: 0.15 });
const THRUST_HIT = P({ lean: 0.42, head: 0.04, armUB: 1.65, armLB: 0.02, armUBD: 0.1, armUF: 1.6, armLF: 0.05, armUFD: 0.1, legUB: -0.65, legLB: 0, legUF: 0.7, legLF: 0, yaw: 0.05 });
/** 抡砸（巨锤矮匠）：双臂举过头顶 → 全力下砸，腰胯下沉 */
const SMASH_UP = P({ lean: -0.28, head: -0.1, armUB: 2.6, armLB: 0.5, armUF: 2.4, armLF: 0.6, legUB: -0.3, legLB: 0, legUF: 0.4, legLF: 0 });
const SMASH_HIT = P({ lean: 0.5, head: 0.15, armUB: 0.5, armLB: 0.3, armUF: 0.4, armLF: 0.4, legUB: -0.7, legLB: 0, legUF: 0.75, legLF: 0 });
/** 盾击（盾卫）：盾后收 → 整体前撞，用盾面推 */
const BASH_WIND = P({ lean: -0.15, armUB: -0.3, armLB: 1.2, armUF: -0.3, armLF: 1.1, legUB: -0.3, legLB: 0, legUF: 0.4, legLF: 0 });
const BASH_HIT = P({ lean: 0.4, armUB: 1.5, armLB: 0.1, armUF: 1.5, armLF: 0.1, legUB: -0.6, legLB: 0, legUF: 0.65, legLF: 0 });
/** 连斩（双刀刺客）：左刃横扫 → 右刃回拉，两段贴脸快斩 */
const SLASH_A = P({ lean: 0.3, armUB: 1.7, armLB: 0.1, armUF: 1.4, armLF: 0.3, legUB: -0.5, legLB: 0, legUF: 0.6, legLF: 0 });
const SLASH_B = P({ lean: 0.35, armUB: 1.2, armLB: 0.4, armUF: 1.75, armLF: 0.05, legUB: -0.55, legLB: 0, legUF: 0.65, legLF: 0 });
/** 推掌（武僧）：整掌前推，短促干脆 */
const PALM_HIT = P({ lean: 0.35, armUB: 0.6, armLB: 1.2, armUF: 1.7, armLF: 0.05, legUB: -0.5, legLB: 0, legUF: 0.6, legLF: 0 });
/** 横扫（维京战斧）：斧拉到身后 → 大弧抡出 */
const SWING_WIND = P({ lean: -0.15, armUB: 1.9, armLB: 1.6, armUBD: 0.4, armUF: 1.5, armLF: 1.5, legUB: -0.3, legLB: 0, legUF: 0.45, legLF: 0 });
const SWING_HIT = P({ lean: 0.4, armUB: 0.4, armLB: 0.6, armUBD: -0.3, armUF: 1.7, armLF: 0.1, legUB: -0.6, legLB: 0, legUF: 0.7, legLF: 0 });
/** 拔刀斩（剑客/武士）：收刀侧身 → 一闪而出，快得看不清 */
const IAI_WIND = P({ lean: 0.12, head: 0.05, armUB: -0.7, armLB: 1.9, armUF: -0.6, armLF: 1.8, legUB: -0.55, legLB: 0, legUF: 0.62, legLF: 0, yaw: -0.35 });
const IAI_HIT = P({ lean: 0.5, head: 0.02, armUB: 1.8, armLB: -0.1, armUF: 1.7, armLF: 0, legUB: -0.7, legLB: 0, legUF: 0.78, legLF: 0, yaw: 0.3 });
/** 链锤抡击（链锤手）：链甩到身后 → 链抡出去砸 */
const FLAIL_WIND = P({ lean: -0.2, armUB: 2.0, armLB: 1.4, armUBD: 0.5, armUF: 1.2, armLF: 1.6, legUB: -0.35, legLB: 0, legUF: 0.5, legLF: 0, yaw: -0.3 });
const FLAIL_HIT = P({ lean: 0.45, armUB: 0.3, armLB: 0.5, armUBD: -0.4, armUF: 1.8, armLF: 0.1, legUB: -0.65, legLB: 0, legUF: 0.75, legLF: 0, yaw: 0.25 });
/** 机关重拳（机关师）：机关臂液压后收 → 活塞式击出 */
const GEAR_WIND = P({ lean: -0.18, armUB: -0.6, armLB: 1.7, armUBD: 0.2, armUF: 0.3, armLF: 1.6, legUB: -0.4, legLB: 0, legUF: 0.5, legLF: 0 });
const GEAR_HIT = P({ lean: 0.4, armUB: 1.75, armLB: 0, armUBD: 0.1, armUF: 0.5, armLF: 1.3, legUB: -0.6, legLB: 0, legUF: 0.7, legLF: 0 });
/** 瞄准（弩手/忍者）：双手端平，扣扳机帧发射 */
const AIM = P({ lean: 0.1, armUB: 1.5, armLB: 0.15, armUBD: 0.1, armUF: 1.55, armLF: 0.1, armUFD: 0.1, legUB: -0.45, legLB: 0, legUF: 0.55, legLF: 0 });
/** 飞镖起手（忍者）：手臂横拉到脑后 */
const SHURIKEN_WIND = P({ lean: 0.05, armUB: -0.8, armLB: 1.5, armUBD: 0.4, armUF: 1.4, armLF: 0.4, legUB: -0.35, legLB: 0, legUF: 0.45, legLF: 0 });

const CLIPS: Record<string, Clip> = {
  /* ===== 武器专属招式：每个流派自己的轨迹语言 ===== */
  thrust: { dur: 0.66, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.34, pose: THRUST_WIND }, { t: 0.52, pose: THRUST_HIT }, { t: 0.68, pose: THRUST_HIT }, { t: 1, pose: GUARD }] },
  smash: { dur: 0.8, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.36, pose: SMASH_UP }, { t: 0.56, pose: SMASH_HIT }, { t: 0.72, pose: SMASH_HIT }, { t: 1, pose: GUARD }] },
  bash: { dur: 0.6, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: BASH_WIND }, { t: 0.5, pose: BASH_HIT }, { t: 0.66, pose: BASH_HIT }, { t: 1, pose: GUARD }] },
  slash: { dur: 0.7, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.22, pose: SLASH_A }, { t: 0.38, pose: SLASH_A }, { t: 0.56, pose: SLASH_B }, { t: 0.7, pose: SLASH_B }, { t: 1, pose: GUARD }] },
  palm: { dur: 0.42, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.4, pose: PALM_HIT }, { t: 0.56, pose: PALM_HIT }, { t: 1, pose: GUARD }] },
  swing: { dur: 0.72, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.34, pose: SWING_WIND }, { t: 0.54, pose: SWING_HIT }, { t: 0.7, pose: SWING_HIT }, { t: 1, pose: GUARD }] },
  iai: { dur: 0.6, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.42, pose: IAI_WIND }, { t: 0.5, pose: IAI_HIT }, { t: 0.62, pose: IAI_HIT }, { t: 1, pose: GUARD }] },
  flailSwing: { dur: 0.85, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.4, pose: FLAIL_WIND }, { t: 0.58, pose: FLAIL_HIT }, { t: 0.74, pose: FLAIL_HIT }, { t: 1, pose: GUARD }] },
  gearPunch: { dur: 0.7, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.36, pose: GEAR_WIND }, { t: 0.54, pose: GEAR_HIT }, { t: 0.7, pose: GEAR_HIT }, { t: 1, pose: GUARD }] },
  bolt: { dur: 0.6, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: AIM }, { t: 0.48, pose: AIM }, { t: 0.62, pose: AIM }, { t: 1, pose: GUARD }] },
  shuriken: { dur: 0.5, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: SHURIKEN_WIND }, { t: 0.5, pose: AIM }, { t: 0.62, pose: AIM }, { t: 1, pose: GUARD }] },

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
  // 转体全程连续加速：0 → 半圈命中 → 继续扫过 → 转正落地
  spinKick: { dur: 1.1, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.1, pose: SPIN_TUCK }, { t: 0.26, pose: SPIN_TURN_A }, { t: 0.4, pose: SPIN_TURN_B }, { t: 0.5, pose: SPIN_KICK }, { t: 0.62, pose: SPIN_THROUGH }, { t: 0.86, pose: SPIN_END }, { t: 1, pose: SPIN_END }] },
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

/**
 * 装备流派：角色池按「剪影差异 + 武器轨迹 + 动态件类型」分化，
 * 而不是换皮。每个流派占一个打法生态位。
 */
type Gear =
  | 'swordsman' // 剑客：背剑，中距斩击
  | 'ranger' // 游侠：短弓 + 箭袋，远程牵制
  | 'shield' // 盾卫：圆盾 + 短剑，格挡反击
  | 'spear' // 长枪兵：长枪，直刺距离控制
  | 'dagger' // 双刀刺客：双短刀，高速连段
  | 'monk' // 武僧：念珠，拳脚连击
  | 'hammer' // 巨锤矮人：大锤，重砸破防
  | 'gunner' // 弩手：弩，远程爆发
  | 'ninja' // 忍者：飞镖投掷 + 烟遁
  | 'drunk' // 醉拳师：踉跄假动作 + 葫芦钟摆
  | 'viking' // 维京狂战士：战斧大弧 + 毛皮披肩
  | 'samurai' // 东方武士：拔刀斩 + 斗笠
  | 'flail' // 链锤手：分段刚性链
  | 'puppeteer'; // 机关师：机关臂 + 背箱

/**
 * 服装分层：L0 贴身衣（躯干外衣）→ L1 刚性装备（护肩）→ 袖/裤（覆盖四肢）→ L2 布片 → L3 挂件。
 * 骨骼只是骨架，真正让角色"像个穿衣服的人"靠这一层。
 */
interface Outfit {
  torso: 'robe' | 'armor' | 'tabard' | 'shirt' | 'kimono' | 'leather' | 'coat' | 'hauberk' | 'gearPlate';
  pauldron: 'none' | 'single' | 'double' | 'fur' | 'spiked' | 'gear';
  sleeve: 'tight' | 'wide' | 'rolled' | 'bandage' | 'metal';
  leg: 'pants' | 'skirt' | 'armored' | 'wrapped' | 'hakama' | 'kilt';
}

/**
 * 每个流派只保留 1 个主剪影装饰（远看能认人），动态件最多 2 类
 * （一类布片 + 一类小挂件）—— 再多就穿模且吃掉物理预算。
 */
interface GearSpec {
  silhouette: 'sword' | 'bow' | 'shield' | 'spear' | 'twinDagger' | 'beads' | 'hammer' | 'crossbow' | 'shuriken' | 'gourd' | 'axe' | 'katana' | 'flail' | 'gearArm';
  /** 布片动态件（L2 半刚性）：null = 不做 */
  cloth: 'cape2' | 'sash' | 'apron' | 'shoulderCape' | 'hoodTail' | 'haori' | 'kilt' | null;
  /** 挂件动态件（L3 柔性短挂件）：null = 不做 */
  trinket: 'beads' | 'tassel' | 'gourd' | 'ammo' | 'braid' | 'plume' | 'chain' | null;
  /** 体型倍率：矮壮 ~ 瘦削 */
  bulk: number;
  /** 武器是否握在手上（否则背/挂在身上） */
  weaponInHand: boolean;
  outfit: Outfit;
  /** AI 生态位：决定打法节奏 */
  behavior: 'zoner' | 'rusher' | 'turtle' | 'punisher' | 'trickster' | 'brawler';
  /** 流派专属招式（在通用拳脚之外额外解锁） */
  moves: string[];
}

const GEAR_SPEC: Record<Gear, GearSpec> = {
  swordsman: { silhouette: 'sword', cloth: 'sash', trinket: 'tassel', bulk: 1.05, weaponInHand: false, outfit: { torso: 'kimono', pauldron: 'single', sleeve: 'wide', leg: 'hakama' }, behavior: 'punisher', moves: ['iai'] },
  ranger: { silhouette: 'bow', cloth: 'hoodTail', trinket: null, bulk: 0.86, weaponInHand: true, outfit: { torso: 'leather', pauldron: 'none', sleeve: 'rolled', leg: 'pants' }, behavior: 'zoner', moves: ['bolt'] },
  shield: { silhouette: 'shield', cloth: 'cape2', trinket: null, bulk: 1.12, weaponInHand: true, outfit: { torso: 'armor', pauldron: 'double', sleeve: 'metal', leg: 'armored' }, behavior: 'turtle', moves: ['bash'] },
  spear: { silhouette: 'spear', cloth: null, trinket: 'tassel', bulk: 0.95, weaponInHand: true, outfit: { torso: 'hauberk', pauldron: 'single', sleeve: 'tight', leg: 'armored' }, behavior: 'zoner', moves: ['thrust'] },
  dagger: { silhouette: 'twinDagger', cloth: 'hoodTail', trinket: null, bulk: 0.88, weaponInHand: true, outfit: { torso: 'shirt', pauldron: 'none', sleeve: 'tight', leg: 'pants' }, behavior: 'rusher', moves: ['slash'] },
  monk: { silhouette: 'beads', cloth: 'sash', trinket: 'beads', bulk: 0.98, weaponInHand: false, outfit: { torso: 'robe', pauldron: 'none', sleeve: 'bandage', leg: 'wrapped' }, behavior: 'brawler', moves: ['palm'] },
  hammer: { silhouette: 'hammer', cloth: 'apron', trinket: 'braid', bulk: 1.18, weaponInHand: true, outfit: { torso: 'leather', pauldron: 'double', sleeve: 'rolled', leg: 'skirt' }, behavior: 'punisher', moves: ['smash'] },
  gunner: { silhouette: 'crossbow', cloth: 'shoulderCape', trinket: 'ammo', bulk: 0.92, weaponInHand: true, outfit: { torso: 'coat', pauldron: 'single', sleeve: 'tight', leg: 'pants' }, behavior: 'zoner', moves: ['bolt'] },
  ninja: { silhouette: 'shuriken', cloth: 'hoodTail', trinket: null, bulk: 0.9, weaponInHand: true, outfit: { torso: 'shirt', pauldron: 'none', sleeve: 'bandage', leg: 'wrapped' }, behavior: 'trickster', moves: ['shuriken'] },
  drunk: { silhouette: 'gourd', cloth: 'sash', trinket: 'gourd', bulk: 1.02, weaponInHand: false, outfit: { torso: 'robe', pauldron: 'none', sleeve: 'rolled', leg: 'pants' }, behavior: 'trickster', moves: ['palm', 'elbow'] },
  viking: { silhouette: 'axe', cloth: 'kilt', trinket: 'braid', bulk: 1.15, weaponInHand: true, outfit: { torso: 'leather', pauldron: 'fur', sleeve: 'rolled', leg: 'kilt' }, behavior: 'rusher', moves: ['swing'] },
  samurai: { silhouette: 'katana', cloth: 'haori', trinket: 'tassel', bulk: 1.0, weaponInHand: true, outfit: { torso: 'armor', pauldron: 'spiked', sleeve: 'wide', leg: 'hakama' }, behavior: 'punisher', moves: ['iai'] },
  flail: { silhouette: 'flail', cloth: 'kilt', trinket: 'chain', bulk: 1.08, weaponInHand: true, outfit: { torso: 'hauberk', pauldron: 'single', sleeve: 'metal', leg: 'armored' }, behavior: 'brawler', moves: ['flailSwing'] },
  puppeteer: { silhouette: 'gearArm', cloth: 'coat', trinket: null, bulk: 0.96, weaponInHand: true, outfit: { torso: 'gearPlate', pauldron: 'gear', sleeve: 'metal', leg: 'pants' }, behavior: 'trickster', moves: ['gearPunch'] },
};

/** 动态件质点：verlet 积分，跟随锚点做短幅摆动（不做长飘带） */
interface Dangle {
  x: number;
  y: number;
  px: number;
  py: number;
}

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
  /** 连招取消点：命中后过了这个片段进度就能直接接下一段（吃掉收招，连招才有连贯感） */
  cancelFrom?: number;
  /** 弹道招式：发射投射物（弩箭/飞镖），命中判定交给投射物而不是接触检测 */
  projectile?: 'bolt' | 'shuriken';
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
  // 命中时刻对齐「身体转满半圈、腿扫到位」那一帧；转身的同时向前突进才够得着
  spinKick: { part: 'footB', hits: [{ at: 0.5, dmg: [22, 33], reach: 1.4, knock: 500 }], hitstop: 0.16, react: 'heavy', far: true, forward: 110 },
  flyKick: { part: 'footF', hits: [{ at: 0.48, dmg: [18, 27], reach: 1.3, knock: 380 }], hitstop: 0.08, react: 'heavy', forward: 120, far: true },
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
  /* ===== 武器专属招式：距离/轨迹/节奏按流派分化 ===== */
  thrust: { part: 'handF', hits: [{ at: 0.52, dmg: [14, 22], reach: 1.75, knock: 260 }], hitstop: 0.07, react: 'heavy', forward: 130, far: true },
  smash: { part: 'handB', hits: [{ at: 0.56, dmg: [22, 34], reach: 1.25, knock: 480 }], hitstop: 0.15, react: 'heavy', close: true },
  bash: { part: 'handF', hits: [{ at: 0.5, dmg: [12, 19], reach: 1.15, knock: 330 }], hitstop: 0.08, react: 'heavy', close: true, forward: 80 },
  slash: {
    part: 'handF',
    hits: [
      { at: 0.38, dmg: [8, 13], reach: 1.1, knock: 120 },
      { at: 0.56, dmg: [10, 16], reach: 1.1, knock: 200, part: 'handB' },
    ],
    hitstop: 0.05,
    react: 'light',
    close: true,
    forward: 60,
  },
  palm: { part: 'handF', hits: [{ at: 0.4, dmg: [9, 14], reach: 1.15, knock: 200 }], hitstop: 0.04, react: 'light' },
  swing: { part: 'handB', hits: [{ at: 0.54, dmg: [20, 30], reach: 1.35, knock: 380 }], hitstop: 0.12, react: 'heavy' },
  iai: { part: 'handB', hits: [{ at: 0.5, dmg: [26, 38], reach: 1.6, knock: 420 }], hitstop: 0.14, react: 'heavy', far: true, forward: 120 },
  flailSwing: { part: 'handF', hits: [{ at: 0.58, dmg: [18, 28], reach: 1.5, knock: 350 }], hitstop: 0.1, react: 'heavy' },
  gearPunch: { part: 'handF', hits: [{ at: 0.54, dmg: [19, 29], reach: 1.1, knock: 300 }], hitstop: 0.1, react: 'heavy', close: true, forward: 70 },
  bolt: { part: 'handF', hits: [{ at: 0.48, dmg: [13, 20], reach: 1, knock: 220 }], hitstop: 0.05, react: 'light', projectile: 'bolt', far: true },
  shuriken: { part: 'handF', hits: [{ at: 0.5, dmg: [8, 13], reach: 1, knock: 140 }], hitstop: 0.04, react: 'light', projectile: 'shuriken', far: true },
};

/**
 * 每招专属打击特效的语言：拳是小爆点，腿是大扇形，重击配推镜，旋踢是360°环形破线。
 * 之前所有招共用一套方形火花，重拳和棉花拳头看起来一样——这里给每招定自己的参数。
 */
interface FxSpec {
  style: 'punch' | 'elbow' | 'kick' | 'heavy' | 'spin' | 'air';
  ring: number; // 冲击环最终半径
  wide: number; // 环线粗细
  lines: number; // 打击线条数
  len: number; // 打击线长度
  color: string; // 特效主色
  zoom: number; // 推镜量，0 = 不推
  dir: number; // 定向震屏强度
  sparksN: number; // 定向爆射粒子数
  spread: number; // 粒子锥形张开（弧度）
}

const FX_SPEC: Record<string, FxSpec> = {
  jab:         { style: 'punch', ring: 10, wide: 1.6, lines: 4,  len: 15, color: '#FFF7DE', zoom: 0,     dir: 1.0, sparksN: 5,  spread: 0.55 },
  cross:       { style: 'punch', ring: 16, wide: 2.2, lines: 7,  len: 21, color: '#FFE9A8', zoom: 0,     dir: 1.6, sparksN: 8,  spread: 0.6 },
  hook:        { style: 'punch', ring: 18, wide: 2.4, lines: 9,  len: 24, color: '#FFD88A', zoom: 0,     dir: 1.6, sparksN: 9,  spread: 0.9 },
  uppercut:    { style: 'heavy', ring: 21, wide: 2.8, lines: 10, len: 27, color: '#FFC46B', zoom: 0.022, dir: 2.2, sparksN: 11, spread: 1.0 },
  elbow:       { style: 'elbow', ring: 15, wide: 2.2, lines: 5,  len: 17, color: '#FFF0C0', zoom: 0,     dir: 1.5, sparksN: 7,  spread: 0.5 },
  snapKick:    { style: 'kick',  ring: 14, wide: 2.0, lines: 6,  len: 20, color: '#E8F2FF', zoom: 0,     dir: 1.4, sparksN: 7,  spread: 0.7 },
  pushKick:    { style: 'kick',  ring: 20, wide: 2.6, lines: 8,  len: 25, color: '#DCEBFF', zoom: 0,     dir: 2.0, sparksN: 10, spread: 0.65 },
  sideKick:    { style: 'heavy', ring: 27, wide: 3.4, lines: 12, len: 33, color: '#CFE4FF', zoom: 0.038, dir: 2.8, sparksN: 14, spread: 0.5 },
  roundKick:   { style: 'kick',  ring: 22, wide: 2.8, lines: 11, len: 28, color: '#E4EEFF', zoom: 0.018, dir: 2.2, sparksN: 11, spread: 1.1 },
  axeKick:     { style: 'heavy', ring: 24, wide: 3.0, lines: 7,  len: 22, color: '#FFD9A0', zoom: 0.03,  dir: 2.6, sparksN: 13, spread: 0.8 },
  spinKick:    { style: 'spin',  ring: 33, wide: 3.8, lines: 18, len: 39, color: '#FFE07A', zoom: 0.048, dir: 3.4, sparksN: 18, spread: Math.PI },
  flyKick:     { style: 'air',   ring: 26, wide: 3.0, lines: 13, len: 31, color: '#FFEBC0', zoom: 0.035, dir: 2.6, sparksN: 14, spread: 0.9 },
  scissorKick: { style: 'air',   ring: 19, wide: 2.4, lines: 9,  len: 25, color: '#FFF2CC', zoom: 0.022, dir: 2.0, sparksN: 10, spread: 1.0 },
  thrust:      { style: 'punch', ring: 14, wide: 2.0, lines: 6,  len: 26, color: '#DFF3E8', zoom: 0,     dir: 1.4, sparksN: 6,  spread: 0.3 },
  smash:       { style: 'heavy', ring: 30, wide: 3.6, lines: 12, len: 34, color: '#FFC46B', zoom: 0.045, dir: 3.2, sparksN: 16, spread: 1.3 },
  bash:        { style: 'heavy', ring: 22, wide: 3.0, lines: 7,  len: 22, color: '#CFE4FF', zoom: 0.02,  dir: 2.4, sparksN: 9,  spread: 0.5 },
  slash:       { style: 'punch', ring: 12, wide: 1.8, lines: 5,  len: 18, color: '#E8D9FF', zoom: 0,     dir: 1.2, sparksN: 6,  spread: 0.7 },
  palm:        { style: 'punch', ring: 12, wide: 1.8, lines: 4,  len: 16, color: '#FFF2D0', zoom: 0,     dir: 1.0, sparksN: 5,  spread: 0.5 },
  swing:       { style: 'spin',  ring: 28, wide: 3.2, lines: 12, len: 30, color: '#FFE07A', zoom: 0.03,  dir: 2.8, sparksN: 12, spread: 1.6 },
  iai:         { style: 'punch', ring: 24, wide: 2.6, lines: 14, len: 40, color: '#F2F6FF', zoom: 0.035, dir: 2.6, sparksN: 10, spread: 0.25 },
  flailSwing:  { style: 'spin',  ring: 26, wide: 3.0, lines: 10, len: 28, color: '#FFE07A', zoom: 0.028, dir: 2.6, sparksN: 11, spread: 1.4 },
  gearPunch:   { style: 'heavy', ring: 22, wide: 3.0, lines: 8,  len: 24, color: '#D8E6F5', zoom: 0.025, dir: 2.4, sparksN: 10, spread: 0.6 },
  bolt:        { style: 'punch', ring: 12, wide: 1.8, lines: 4,  len: 15, color: '#DFF3E8', zoom: 0,     dir: 1.2, sparksN: 5,  spread: 0.4 },
  shuriken:    { style: 'punch', ring: 10, wide: 1.6, lines: 4,  len: 13, color: '#DDE6F5', zoom: 0,     dir: 1.0, sparksN: 4,  spread: 0.5 },
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
  opponent: {
    hp: number;
    x: number;
    state: string;
    /** 对手正在起手（命中帧之前）——「他要打过来了」 */
    windingUp: boolean;
    /** 对手正在收招（命中帧之后）—— 可以抢进去打的破绽 */
    recovering: boolean;
    /** 对手这招的威胁半径（经验值，用于判断自己是否在其射程内） */
    threatRange: number;
    /** 对手剩余架势（0~100） */
    guard: number;
    /** 对手是否正处于破防硬直 */
    guardBreak: boolean;
  };
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
  /** 调试/截图用：无视口可见性门控，始终渲染 */
  forceVisible?: boolean;
  /** 演示模式下是否在 canvas 顶部画招式标题 HUD（图鉴等嵌入场景可关） */
  hud?: boolean;
  /** 无限模式：倒地后换下一个随机挑战者（默认开） */
  endless?: boolean;
  /** 持续显示姓名牌（设定模式用） */
  showNames?: boolean;
  /** 设定模式：指定左右角色（ROSTER 下标） */
  matchup?: { left: number; right: number };
  /** 参数覆盖：侵略性 / 格挡倾向 / 血量 */
  params?: { aggression?: number; guardChance?: number; hp?: number };
}

export function initFightBand(opts: FightOptions = {}): void {
  const canvas = document.getElementById(opts.canvasId ?? 'fight-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SKINS = [
    { body: '#DD0100', trim: '#FFF1EA', dark: '#8E0000' }, // 0 赤焰
    { body: '#225095', trim: '#E9F1FF', dark: '#12305C' }, // 1 疾风
    { body: '#FAC901', trim: '#3A2E00', dark: '#B08D00' }, // 2 金
    { body: '#DE0C62', trim: '#FFE9F2', dark: '#91063F' }, // 3 夜刃
    { body: '#7CB518', trim: '#F1FFE0', dark: '#4C720C' }, // 4 林影
    { body: '#FB923C', trim: '#2A1500', dark: '#B4631B' }, // 5 飞花
    { body: '#7C8AA0', trim: '#E7EEF7', dark: '#3E4A5C' }, // 6 铁壁盾卫（钢灰）
    { body: '#3F7D6E', trim: '#E4F5EF', dark: '#1F4A40' }, // 7 长枪兵（青苔绿）
    { body: '#4A3F6B', trim: '#EAE6F5', dark: '#241D3A' }, // 8 双刀刺客（暗紫）
    { body: '#C7763A', trim: '#F6E4CF', dark: '#7A3F16' }, // 9 武僧（袈裟橙）
    { body: '#8A6A3B', trim: '#F3E7CE', dark: '#4E3818' }, // 10 巨锤矮人（皮革棕）
    { body: '#5A5F7A', trim: '#E9ECF5', dark: '#2C3048' }, // 11 弩手（硝石灰）
    { body: '#2E3440', trim: '#DCE3EC', dark: '#171B22' }, // 12 忍者（暗夜黑蓝）
    { body: '#C9A227', trim: '#FFF6D8', dark: '#8A6D10' }, // 13 醉拳师（酒黄）
    { body: '#A83232', trim: '#F2E4D0', dark: '#6B1E1E' }, // 14 维京（血红毛皮）
    { body: '#34495E', trim: '#F5E9CE', dark: '#1B2B3A' }, // 15 武士（靛蓝）
    { body: '#6E7B8A', trim: '#E8ECF2', dark: '#3A4450' }, // 16 链锤手（铁灰）
    { body: '#3E8E7E', trim: '#DFF2EC', dark: '#1F5A50' }, // 17 机关师（铜绿）
  ];

  /**
   * 九人角色表：按「剪影差异 + 武器轨迹 + 动态件类型」分化，每人占一个打法生态位。
   *   build      装备流派（决定剪影主装饰与动态件）
   *   skin       配色
   *   aggression 进攻欲 / guardChance 格挡倾向 / preferDist 偏好距离
   */
  const ROSTER = [
    { name: '疾风剑客', build: 'swordsman' as const, skin: 1, aggression: 0.85, guardChance: 0.4, preferDist: 30 },
    { name: '林影游侠', build: 'ranger' as const, skin: 4, aggression: 0.6, guardChance: 0.35, preferDist: 33 },
    { name: '铁壁盾卫', build: 'shield' as const, skin: 6, aggression: 0.4, guardChance: 0.85, preferDist: 26 },
    { name: '青芒枪兵', build: 'spear' as const, skin: 7, aggression: 0.6, guardChance: 0.5, preferDist: 38 },
    { name: '双刃影客', build: 'dagger' as const, skin: 8, aggression: 1.0, guardChance: 0.25, preferDist: 24 },
    { name: '拂尘武僧', build: 'monk' as const, skin: 9, aggression: 0.8, guardChance: 0.45, preferDist: 27 },
    { name: '熔岩矮匠', build: 'hammer' as const, skin: 10, aggression: 0.65, guardChance: 0.3, preferDist: 28 },
    { name: '硝石弩手', build: 'gunner' as const, skin: 11, aggression: 0.5, guardChance: 0.4, preferDist: 40 },
    { name: '赤焰武人', build: 'swordsman' as const, skin: 0, aggression: 1.0, guardChance: 0.5, preferDist: 27 },
    { name: '暗影忍者', build: 'ninja' as const, skin: 12, aggression: 0.75, guardChance: 0.2, preferDist: 36 },
    { name: '醉卧仙', build: 'drunk' as const, skin: 13, aggression: 0.7, guardChance: 0.35, preferDist: 26 },
    { name: '血斧维京', build: 'viking' as const, skin: 14, aggression: 0.95, guardChance: 0.25, preferDist: 29 },
    { name: '月下武士', build: 'samurai' as const, skin: 15, aggression: 0.65, guardChance: 0.55, preferDist: 32 },
    { name: '铁链判官', build: 'flail' as const, skin: 16, aggression: 0.7, guardChance: 0.4, preferDist: 31 },
    { name: '齿轮机关师', build: 'puppeteer' as const, skin: 17, aggression: 0.6, guardChance: 0.45, preferDist: 30 },
  ];

  /** 把角色表里的设定套到一个斗士身上，并触发登场 */
  const applyRoster = (f: Fighter, r: (typeof ROSTER)[number]) => {
    f.name = r.name;
    f.build = r.build;
    f.skin = SKINS[r.skin];
    f.aggression = r.aggression;
    f.guardChance = r.guardChance;
    f.preferDist = r.preferDist;
    f.enterT = f.enterDur;
  };

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
    /** 承诺窗口：意图锁定剩余时间（防止每 0.1s 反悔抽搐） */
    intentLock: number;
    /** 反击窗口：格挡成功后短暂提升反击招权重 */
    counterWindow: number;
    /** 架势值（guard）：格挡会消耗，耗尽 → 破防大硬直。站架不动时缓慢回复 */
    guard: number;
    /** 破防硬直剩余时间：此时无法格挡且受伤加重 */
    guardBreak: number;
    /** 举盾已持续时间：不能一直举着，超时自动放下 */
    blockT: number;
    /** 连招窗口：命中后短暂提升快速招权重 */
    comboTimer: number;
    /** 当前连招步骤（null=不在连招中） */
    comboSteps: string[] | null;
    comboIndex: number;
    /** 待接的连招下一段：过了取消点才真正切换，收招被"取消"掉，连招才连贯 */
    pendingCombo: string | null;
    /** 角色姓名 */
    name: string;
    /** 登场动画剩余时间 */
    enterT: number;
    enterDur: number;
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
    /** 布料摆动（被击打时衣服会飘） */
    sway: number;
    /** 装备流派：决定剪影主装饰、武器轨迹与动态件类型 */
    build: Gear;
    /** 动态件 A：布片末端（披风/袈裟/围裙），跟随摆动 */
    cloth: Dangle;
    /** 动态件 B：小挂件末端（念珠/枪缨/弹药带），跟随摆动 */
    trinket: Dangle;
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

  /** 冲击环：命中瞬间从接触点向外爆开的环 */
  interface ImpactRing {
    x: number;
    y: number;
    r0: number;
    r1: number;
    life: number;
    max: number;
    color: string;
    wide: number;
  }
  /** 打击线（speed line）：沿打击方向放射的短线，表达「这一下有多快」 */
  interface SpeedLine {
    x: number;
    y: number;
    a: number;
    life: number;
    max: number;
    len: number;
    color: string;
    w: number;
  }

  let W = 0;
  let H = 0;
  let fighters: Fighter[] = [];
  let sparks: Spark[] = [];
  let popups: { x: number; y: number; text: string; life: number; max: number; color: string }[] = [];
  let shake = 0;
  let shakeDir = 0; // 定向震屏：画面沿打击方向的偏移量
  let hitstop = 0; // 命中定格剩余时间（秒）
  let zoom = 0; // zoom punch：重击瞬间推镜，>0 时画面整体放大
  let impactRings: ImpactRing[] = [];
  let speedLines: SpeedLine[] = [];
  /** 投射物（弩箭/飞镖）：弹道招式的命中载体 */
  interface Projectile {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    owner: number;
    kind: 'bolt' | 'shuriken';
    dmg: number;
    knock: number;
  }
  let projectiles: Projectile[] = [];
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
    scale: (i % 2 === 0 ? rand(0.98, 1.06) : rand(0.94, 1.02)),
    build: (i % 2 === 0 ? 'swordsman' : 'ranger') as Gear,
    cloth: { x: NaN, y: NaN, px: 0, py: 0 },
    trinket: { x: NaN, y: NaN, px: 0, py: 0 },
    aggression: rand(0.45, 0.95),
    guardChance: rand(0.35, 0.75),
    preferDist: rand(29, 34),
    intentLock: 0,
    counterWindow: 0,
    guard: 100,
    guardBreak: 0,
    blockT: 0,
    comboTimer: 0,
    comboSteps: null,
    comboIndex: 0,
    pendingCombo: null,
    name: '',
    enterT: 0,
    enterDur: 0.8,
    downTimer: 0,
    ragdoll: null,
    links: [],
    getupFade: 0,
    lastDecision: 0,
    emote: null,
    kb: 0,
    stagger: 0,
    armFront: 'F',
    sway: 0,
    invuln: 0,
    minX: 20,
    maxX: 9999,
  });

  const makeFighters = (count: number) => {
    fighters = [];
    for (let i = 0; i < count; i++) {
      const f = mk(i, SKINS[0]);
      const ridx = opts.matchup ? (i % 2 === 0 ? opts.matchup.left : opts.matchup.right) : i % ROSTER.length;
      applyRoster(f, ROSTER[((ridx % ROSTER.length) + ROSTER.length) % ROSTER.length]);
      if (opts.params?.aggression) f.aggression = opts.params.aggression;
      if (opts.params?.guardChance) f.guardChance = opts.params.guardChance;
      if (opts.params?.hp) { f.maxHp = opts.params.hp; f.hp = opts.params.hp; }
      // 登场错峰：同组第二个晚 0.8s 登场，避免姓名牌重叠
      if (i % 2 === 1) f.enterT = f.enterDur + 0.8;
      fighters.push(f);
    }
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

  /** 定向爆射：粒子沿打击方向呈锥形飞溅（四周均匀散开像烟花，不像挨打） */
  const spawnDirected = (x: number, y: number, color: string, n: number, power: number, facing: number, spread = 0.7) => {
    const base = facing > 0 ? 0 : Math.PI;
    for (let i = 0; i < n; i++) {
      const a = base + rand(-spread, spread);
      const sp = rand(70, 230) * power;
      sparks.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 55 * power,
        life: 0,
        max: rand(0.13, 0.28),
        color,
        size: rand(1.6, 3.6),
        kind: 'hit',
      });
    }
  };

  /** 按招式播专属打击特效：冲击环 + 打击线 + 定向火花 + 定向震屏 + 推镜
   *  phase：初始生命比例（0~1），定格检查时给 0.45 让环/线处于扩散中途更好看 */
  const burstFx = (key: string, x: number, y: number, facing: number, blocking: boolean, phase = 0) => {
    const fx = FX_SPEC[key];
    if (!fx) return;
    const col = blocking ? '#9AD9FF' : fx.color;
    const p = blocking ? 0.45 : 1; // 被格挡时特效强度打折

    // 冲击环：重击与旋踢额外加一圈更大更慢的外环
    impactRings.push({ x, y, r0: fx.ring * 0.22, r1: fx.ring * p, life: 0.2 * phase, max: 0.2, color: col, wide: fx.wide });
    if (!blocking && (fx.style === 'spin' || fx.style === 'heavy')) {
      impactRings.push({ x, y, r0: fx.ring * 0.3, r1: fx.ring * 1.55, life: 0.32 * phase, max: 0.32, color: col, wide: fx.wide * 0.45 });
    }

    // 打击线：旋踢是 360° 环形破线，其余沿打击方向放射
    const base = facing > 0 ? 0 : Math.PI;
    for (let i = 0; i < fx.lines; i++) {
      const a = fx.style === 'spin' ? rand(0, TAU) : base + rand(-0.95, 0.95);
      speedLines.push({ x, y, a, life: rand(0.07, 0.15) * phase, max: rand(0.07, 0.15), len: fx.len * rand(0.65, 1.3) * p, color: col, w: rand(1, 2.3) });
    }

    const pw = p * (fx.style === 'spin' || fx.style === 'heavy' ? 1.15 : 1);
    const n = Math.round(fx.sparksN * p);
    const sBase = facing > 0 ? 0 : Math.PI;
    for (let i = 0; i < n; i++) {
      const a = sBase + rand(-fx.spread, fx.spread);
      const sp = rand(70, 230) * pw;
      const life = rand(0.13, 0.28) * phase;
      sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 55 * pw, life, max: rand(0.13, 0.28), color: col, size: rand(1.6, 3.6), kind: 'hit' });
    }

    shake = Math.max(shake, fx.dir * (blocking ? 0.5 : 1));
    shakeDir = facing * fx.dir * (blocking ? 0.5 : 1);
    if (!blocking && fx.zoom > 0) zoom = Math.max(zoom, fx.zoom);
  };

  /**
   * 动态件（布片 / 挂件）单步推进：verlet 惯性 + 弹簧回锚点 + 重力 + 长度约束。
   * 只做短幅摆动 —— 武打角色不做长飘带（长围巾/长披风），否则穿模且吃物理预算。
   */
  const stepDangle = (d: Dangle, ax: number, ay: number, maxLen: number, stiff: number, grav: number) => {
    if (Number.isNaN(d.x)) {
      d.x = ax;
      d.y = ay;
      d.px = ax;
      d.py = ay;
      return;
    }
    const vx = (d.x - d.px) * 0.88;
    const vy = (d.y - d.py) * 0.88;
    d.px = d.x;
    d.py = d.y;
    d.x += vx + (ax - d.x) * stiff;
    d.y += vy + (ay - d.y) * stiff + grav;
    // 长度约束：末端不许离锚点太远，避免甩飞 / 穿进身体
    const dx = d.x - ax;
    const dy = d.y - ay;
    const len = Math.hypot(dx, dy) || 1;
    if (len > maxLen) {
      d.x = ax + (dx / len) * maxLen;
      d.y = ay + (dy / len) * maxLen;
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
    // 转身的轴是「支撑脚」：先把骨骼绕竖轴转，再整体平移把那只脚挪回原处。
    // 否则是绕骨盆自转，两只脚会在地上画大弧线滑行，看着像陀螺而不是转身。
    // 支撑脚 = 位置更低的那只脚（站立腿），踢出去的那条腿是抬起的一侧。
    const pivotKey: keyof Joints = j.footF.y >= j.footB.y ? 'footF' : 'footB';
    const pv = j[pivotKey];
    const shiftX = pv.x - (pv.x * cy + pv.z * sy);
    const shiftZ = pv.z - (-pv.x * sy + pv.z * cy);
    const out = {} as Record<keyof Joints, Pt>;
    for (const k of Object.keys(j) as (keyof Joints)[]) {
      const q = j[k];
      // 绕竖轴转体（真三维转身，不是翻面）
      const x1 = q.x * cy + q.z * sy + shiftX;
      const z1 = -q.x * sy + q.z * cy + shiftZ;
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
    f.pendingCombo = null; // 状态一变，待接的连招就作废（被打断 / 被菜单打岔）
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

  /** 招式的起手/命中/收招节奏（片段归一化进度） */
  const movePhase = (s: string) => {
    const a = ATTACKS[s];
    if (!a) return null;
    let first = 1;
    let last = 0;
    let reach = 1;
    for (const h of a.hits) {
      first = Math.min(first, h.at);
      last = Math.max(last, h.at);
      reach = Math.max(reach, h.reach);
    }
    return { first, last, reach };
  };

  const snapshot = (f: Fighter, opp: Fighter | undefined): FightSnapshot => {
    const ph = opp ? movePhase(opp.state) : null;
    const prog = opp && opp.clipDur > 0 ? opp.clipT / opp.clipDur : 0;
    return {
      self: { hp: f.hp, x: f.x, state: f.state, distance: opp ? Math.abs(opp.x - f.x) : 999 },
      opponent: {
        hp: opp?.hp ?? 100,
        x: opp?.x ?? 0,
        state: opp?.state ?? 'idle',
        // 起手：任意攻击招的命中帧之前 —— 这是「他要打过来了」的信号
        windingUp: !!ph && prog < ph.first * 0.9,
        // 收招：最后一个命中帧之后 —— 这是可以抢进去打的破绽
        recovering: !!ph && prog > ph.last + 0.05,
        // 威胁半径（经验换算）：对手这招大概能打多远
        threatRange: ph ? 30 * ph.reach : 24,
        /** 对手剩余架势（0~100，见底就能破防） */
        guard: opp?.guard ?? 100,
        /** 对手是否正处于破防硬直（此时挨打更疼） */
        guardBreak: (opp?.guardBreak ?? 0) > 0,
      },
    };
  };

  const ATTACK_KEYS = Object.keys(ATTACKS);

  /** 连招表：命中后按概率接下一段 */
  const COMBOS: { steps: string[]; chance: number }[] = [
    { steps: ['jab', 'cross', 'hook'], chance: 0.7 },
    { steps: ['snapKick', 'roundKick'], chance: 0.6 },
    { steps: ['hook', 'uppercut'], chance: 0.6 },
    { steps: ['pushKick', 'sideKick'], chance: 0.55 },
    { steps: ['jab', 'cross'], chance: 0.75 },
  ];

  /** 招式元数据：起手/收招（秒）+ 战术标签 */
  const MOVE_META: Record<string, { startup: number; recovery: number; breakGuard?: boolean; finisher?: boolean; fast?: boolean; counter?: boolean }> = {
    jab: { startup: 0.18, recovery: 0.2, fast: true, counter: true },
    cross: { startup: 0.3, recovery: 0.3 },
    hook: { startup: 0.28, recovery: 0.25 },
    uppercut: { startup: 0.32, recovery: 0.28 },
    elbow: { startup: 0.22, recovery: 0.2, counter: true },
    snapKick: { startup: 0.22, recovery: 0.2, fast: true, counter: true },
    pushKick: { startup: 0.28, recovery: 0.3, breakGuard: true },
    sideKick: { startup: 0.32, recovery: 0.32, finisher: true },
    roundKick: { startup: 0.3, recovery: 0.3 },
    axeKick: { startup: 0.34, recovery: 0.32, breakGuard: true },
    spinKick: { startup: 0.5, recovery: 0.4, finisher: true },
    flyKick: { startup: 0.4, recovery: 0.35, finisher: true },
    scissorKick: { startup: 0.3, recovery: 0.3 },
    /* ===== 武器专属招式元数据 ===== */
    thrust: { startup: 0.22, recovery: 0.2, counter: true },
    smash: { startup: 0.32, recovery: 0.3, breakGuard: true, finisher: true },
    bash: { startup: 0.2, recovery: 0.16, breakGuard: true },
    slash: { startup: 0.16, recovery: 0.2, fast: true },
    palm: { startup: 0.1, recovery: 0.1, fast: true, counter: true },
    swing: { startup: 0.26, recovery: 0.26, breakGuard: true },
    iai: { startup: 0.3, recovery: 0.2, finisher: true, counter: true, fast: true },
    flailSwing: { startup: 0.34, recovery: 0.3, breakGuard: true, finisher: true },
    gearPunch: { startup: 0.24, recovery: 0.24, breakGuard: true },
    bolt: { startup: 0.2, recovery: 0.18, fast: true },
    shuriken: { startup: 0.16, recovery: 0.14, fast: true },
  };

  /** 招式层：按距离筛选 + 效用函数打分 + 加权随机 */
  const pickAttack = (f: Fighter, d: number, opp: FightSnapshot['opponent'] | null): Decision => {
    const pool = ATTACK_KEYS.filter((k) => {
      const a = ATTACKS[k];
      if (a.close && d > 36) return false;
      if (a.far && d < 28) return false;
      if (!a.close && !a.far && d > 56) return false;
      return true;
    });
    // 流派专属招式入池且加权：本流的招牌该多用（枪兵多突刺、矮匠多抡砸）
    const spec = GEAR_SPEC[f.build];
    const own = (spec.moves ?? []).filter((k) => ATTACKS[k] && !pool.includes(k));
    const list = own.length || pool.length ? [...own, ...pool] : ['jab'];
    const weights = list.map((k) => {
      const a = ATTACKS[k];
      const meta = MOVE_META[k];
      const power = a.hits.reduce((s, h) => s + (h.dmg[0] + h.dmg[1]) / 2, 0);
      // 基础：伤害越高概率越低（重招稀有）；连击招再打折
      let w = Math.max(0.3, 24 / power) * (a.hits.length > 1 ? 0.75 : 1);
      if (spec.moves.includes(k)) w *= 1.9;

      // ---- 局面加权 ----
      const oppHurt = opp && (opp.state === 'hurtLight' || opp.state === 'hurtHeavy' || opp.state === 'hurtUp' || opp.state === 'stumble');
      const oppBlock = opp && opp.state === 'block';
      const oppLow = opp && opp.hp < 30;
      const selfLow = f.hp < 30;

      if (oppHurt && power >= 20) w *= 2.2;                       // 对手硬直 -> 重招追击
      if (oppBlock) w *= meta?.breakGuard ? 2.0 : 0.5;            // 对手格挡 -> 破防招加分，普通招减半
      if (opp && opp.guard < 58 && meta?.breakGuard) w *= 2.6;    // 对手架势见底 -> 猛砸破防
      if (opp?.guardBreak) w *= power >= 20 ? 2.4 : 1.6;          // 对手破防硬直 -> 狠狠打
      if (oppLow && meta?.finisher) w *= 2.5;                     // 对手残血 -> 终结技
      if (selfLow && meta?.fast) w *= 1.8;                        // 自己残血 -> 轻快招抢速度
      if (f.counterWindow > 0 && meta?.counter) w *= 3.0;         // 反击窗口 -> 反击招
      if (f.comboTimer > 0 && meta?.fast) w *= 1.5;               // 连招窗口 -> 快速招衔接
      if (a.close && d < 30) w *= 1.4;                            // 近身 -> 近招
      if (a.far && d >= 30) w *= 1.4;                             // 远距 -> 远招
      return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < list.length; i++) {
      r -= weights[i];
      if (r <= 0) return list[i] as Decision;
    }
    return list[0] as Decision;
  };

  /** 本地启发式 AI：走位 / 格挡 / 闪避 / 追击 / 残血撤退 / 按局面选招 */
  const HURT_STATES = ['hurtLight', 'hurtHeavy', 'hurtUp', 'stumble'];

  const heuristic = (snap: FightSnapshot, f: Fighter): Decision => {
    const d = snap.self.distance;
    const opp = snap.opponent;
    const oppWinding = opp.windingUp;
    // 我正站在对手这招够得到的范围里（+缓冲）
    const inThreat = d < opp.threatRange + 8;
    // 生态位节奏分化：盾卫蹲守、狂战扑脸、巧变流爱跳
    const behavior = GEAR_SPEC[f.build].behavior;
    if (behavior === 'trickster' && Math.random() < 0.07) return 'jump';
    // 破防硬直中举不起盾 —— 这时只能挨打或后撤
    const canBlock = f.guardBreak <= 0 && f.guard > 18;
    const guardUp = (v: number) => (canBlock ? 'block' : 'retreat');

    /* ① 感知对方起手 → 撤出他的射程（间合博弈：不硬吃，先拉开） */
    if (oppWinding && inThreat) {
      const r = Math.random();
      if (behavior === 'turtle') {
        if (r < 0.5) return guardUp(0);
        if (r < 0.78) return 'retreat';
      } else {
        if (r < 0.44) return 'retreat'; // 主动拉开距离
        if (r < 0.44 + f.guardChance * 0.42) return guardUp(0);
        if (r < 0.68) return 'jump';
        // 剩下 32%：不退反进，抢在他命中帧之前打断（读招成功）
        if (f.cool <= 0 && d < f.preferDist + 6) return pickAttack(f, d, opp);
      }
    }

    /* ② 对手在收招（招式已过命中帧）= 破绽 → 突进去打 */
    if (opp.recovering && f.cool <= 0) {
      if (d > f.preferDist + 4) return 'approach'; // 先进到射程（走位会加速冲刺）
      return pickAttack(f, d, opp);
    }

    /* ③ 对手在硬直/踉跄中：立刻追击（重招概率已由 pickAttack 拉高） */
    if (HURT_STATES.includes(opp.state) && d < f.preferDist + 8 && f.cool <= 0) {
      return pickAttack(f, d, opp);
    }
    if (behavior === 'rusher' && f.cool <= 0 && d < 46 && Math.random() < 0.3) return pickAttack(f, d, opp);

    /* ④ 间合试探（footsies）：站在对手射程边缘，进退交替寻找进场时机 */
    const edge = opp.threatRange + 10;
    if (!inThreat && d < edge + 16 && f.cool > 0) {
      // 冷却中不便出手 —— 在射程外一圈游走，忽远忽近
      return Math.random() < 0.45 + f.aggression * 0.2 ? 'approach' : 'retreat';
    }

    // 太远：靠近
    if (d > f.preferDist + 9) return 'approach';
    // 残血谨慎：偶尔退开
    if (f.hp < 32 && Math.random() < 0.35) return 'retreat';
    // 贴太近：拉开一点（避免两人黏在一起）
    if (d < f.preferDist - 8) return Math.random() < 0.6 ? 'retreat' : 'wait';
    // 在攻击距离内：按距离 + 性格 + 局面选招
    if (f.cool <= 0) {
      if (Math.random() < 0.1) return 'jump';
      return pickAttack(f, d, opp);
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
        // 破防中或架势见底：举不起盾，改成后撤
        if (f.guardBreak > 0 || f.guard <= 18) {
          setState(f, 'retreat', rand(0.3, 0.5));
          break;
        }
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
    // 任何一方正在出招 / 倒地时不做硬性分离，否则突进类招式会被卡住打不到
    if (ATTACKS[f.state] || ATTACKS[opp.state] || f.state === 'down' || f.state === 'stumble') return;
    // 站架时保持一个看得出来的间距，别两个人贴在一起
    const minGap = 25 * Math.max(f.scale, opp.scale);
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
    { key: 'thrust', name: '⑳ 突刺 Thrust（长枪直取）', kind: 'attack' },
    { key: 'smash', name: '㉑ 抡砸 Smash（大锤下劈）', kind: 'attack' },
    { key: 'bash', name: '㉒ 盾击 Bash（盾面推撞）', kind: 'attack' },
    { key: 'slash', name: '㉓ 连斩 Slash（双刃两段）', kind: 'attack' },
    { key: 'palm', name: '㉔ 推掌 Palm（整掌前送）', kind: 'attack' },
    { key: 'swing', name: '㉕ 横扫 Swing（战斧大弧）', kind: 'attack' },
    { key: 'iai', name: '㉖ 拔刀斩 Iai（居合一闪）', kind: 'attack' },
    { key: 'flailSwing', name: '㉗ 链锤 Flail（抡链砸击）', kind: 'attack' },
    { key: 'gearPunch', name: '㉘ 机关拳 Gear Punch（活塞重拳）', kind: 'attack' },
    { key: 'bolt', name: '㉙ 弩箭 Bolt（弹道射击）', kind: 'attack' },
    { key: 'shuriken', name: '㉚ 飞镖 Shuriken（旋转星镖）', kind: 'attack' },
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
    { key: 'idle', name: '待机 Idle（默认架势）', kind: 'react' },
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
    /* --- 动态件推进：布片挂肩背/腰，挂件挂胸/腰/头，随身体运动摆起来 --- */
    for (const f of fighters) {
      const spec = GEAR_SPEC[f.build];
      if (!spec.cloth && !spec.trinket) continue;
      const { world } = place(f);
      if (spec.cloth) {
        const a =
          spec.cloth === 'apron'
            ? world.hipB
            : spec.cloth === 'hoodTail'
              ? world.head
              : spec.cloth === 'shoulderCape'
                ? world.shoulderF
                : world.shoulderB;
        // 受击/挥招时给一点横向冲量，布片才"活"
        const kick = f.sway * f.facing * 0.9;
        stepDangle(f.cloth, a.x, a.y, 26 * f.scale, 0.2, 1.15 + kick);
      }
      if (spec.trinket) {
        const a =
          spec.trinket === 'beads' || spec.trinket === 'ammo'
            ? world.chest
            : spec.trinket === 'braid' || spec.trinket === 'plume'
              ? world.head
              : spec.trinket === 'chain' || f.build === 'spear'
                ? world.handF // 枪缨 / 链锤都跟着前手走
                : world.hipB;
        stepDangle(f.trinket, a.x, a.y, 14 * f.scale, 0.3, 1.0);
      }
    }

    /* --- 投射物推进：轻微下坠 + 与对手躯干碰撞 --- */
    projectiles = projectiles.filter((p) => {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 60 * dt;
      const target = fighters[p.owner === 0 ? 1 : 0];
      if (target && target.state !== 'down' && target.invuln <= 0) {
        const tw = place(target).world;
        if (Math.abs(p.x - tw.chest.x) < 11 * target.scale && p.y > tw.pelvis.y - 8 && p.y < tw.head.y + 8) {
          const blocking = target.state === 'block';
          const dmg = Math.round(p.dmg * (blocking ? 0.22 : 1));
          target.hp = Math.max(0, target.hp - dmg);
          popups.push({ x: p.x, y: p.y - 22, text: '-' + dmg, life: 0, max: 0.9, color: blocking ? '#6BA8D6' : '#E23B2E' });
          burstFx(p.kind === 'bolt' ? 'bolt' : 'shuriken', p.x, p.y, Math.sign(p.vx), blocking);
          if (!blocking) {
            target.flash = 1;
            target.kb = Math.sign(p.vx) * p.knock;
            target.sway = 0.55;
          }
          return false;
        }
      }
      return p.life < 1.2 && p.x > -40 && p.x < W + 40;
    });

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
      // 定格期间特效也放慢，保留"这一下很重"的余韵
      for (const r of impactRings) r.life += dt * 0.35;
      for (const l of speedLines) l.life += dt * 0.35;
      impactRings = impactRings.filter((r) => r.life < r.max);
      speedLines = speedLines.filter((l) => l.life < l.max);
    for (const p of popups) { p.life += dt; p.y -= 34 * dt; }
    popups = popups.filter((p) => p.life < p.max);
      shake *= 0.86;
      shakeDir *= 0.86;
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

      if (f.counterWindow > 0) f.counterWindow -= dt;
      // 架势：破防硬直中先不回复；举着盾回得慢，站架/走动回得快
      if (f.guardBreak > 0) {
        f.guardBreak = Math.max(0, f.guardBreak - dt);
        if (f.guardBreak === 0) f.guard = 52;
      } else {
        f.guard = Math.min(100, f.guard + (f.state === 'block' ? 7 : 24) * dt);
      }
      // 举盾有时限：不能一直举着当铁桶，超时自动放下并进入短暂冷却
      if (f.state === 'block') {
        f.blockT += dt;
        if (f.blockT > 0.6) {
          setState(f, 'idle');
          f.cool = Math.max(f.cool, 0.32);
          f.blockT = 0;
        }
      } else {
        f.blockT = 0;
      }
      if (f.enterT > 0) f.enterT = Math.max(0, f.enterT - dt);
      if (f.comboTimer > 0) f.comboTimer -= dt;
      if (f.comboTimer <= 0) { f.comboSteps = null; f.comboIndex = 0; }
      if (f.sway !== 0) {
        f.sway *= Math.exp(-dt * 7);
        if (Math.abs(f.sway) < 0.02) f.sway = 0;
      }
      if (f.kb !== 0) {
        f.x += f.kb * dt;
        // 衰减越慢 = 飞得越远（原来 -9 太快，打完几乎没位移）
        f.kb *= Math.exp(-dt * 5);
        if (Math.abs(f.kb) < 3) f.kb = 0;
        f.x = Math.max(f.minX, Math.min(f.maxX, f.x));
      }

      /* --- 倒地 --- */
      if (f.state === 'down') {
        f.downTimer += dt;
        stepRagdoll(f, dt);
        if (f.downTimer > 1.3) {
          if (opts.endless !== false) {
            // 无限模式：倒地后换下一个随机挑战者（登场动画 + 姓名）
            f.ragdoll = null;
            f.hp = f.maxHp;
            f.getupFade = 0;
            f.state = 
'idle'
;
            f.pose = { ...GUARD };
            f.clipT = 0;
            f.clipDur = CLIPS.idle.dur;
            f.cool = rand(0.6, 1.4);
            f.stagger = 0;
            applyRoster(f, ROSTER[Math.floor(Math.random() * ROSTER.length)]);
          } else {
            // 起身：从倒地位置切到跪姿再站起
            f.ragdoll = null;
            f.hp = f.maxHp;
            f.getupFade = 0;
            setState(f, 'getup');
            f.cool = rand(0.5, 1.0);
          }
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

        // 突进：对手正在收招（破绽）或自己刚刚打完想压上去时，脚步明显加快
        const oppPh = opp ? movePhase(opp.state) : null;
        const oppRec = !!oppPh && opp.clipDur > 0 && opp.clipT / opp.clipDur > oppPh.last + 0.05;
        const rush = oppRec || f.comboTimer > 0;
        if (f.state === 'approach' && d > f.preferDist && f.clipT < 3.5) {
          f.x += f.facing * (rush ? 104 : 54) * dt;
          f.walkPhase += dt * 1.9;
          f.pose = lerpPose(f.pose, walkPose(f.walkPhase), 1 - Math.exp(-dt * 22));
        } else if (f.state === 'retreat' && f.clipT < f.clipDur) {
          // 后撤是短暂的规避动作：要撤得干脆，一脚退出对手射程
          f.x -= f.facing * 72 * dt;
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
      // 演示模式暂停时冻结进度，让 seek() 能定格在某一帧
      if (!(opts.demo && demoPaused)) f.clipT += dt;
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

          // 弹道招式：不做接触判定，发射投射物（弩箭/飞镖），朝对手胸口做一次方向修正
          if (atk.projectile) {
            const aw = place(f).world;
            const src = aw[atk.part as keyof Joints];
            const tw = opp ? place(opp).world : null;
            projectiles.push({
              x: src.x + f.facing * 6,
              y: src.y,
              vx: f.facing * (atk.projectile === 'bolt' ? 330 : 290),
              vy: tw ? (tw.chest.y - src.y) * 1.4 : 0,
              life: 0,
              owner: fighters.indexOf(f),
              kind: atk.projectile,
              dmg: Math.round(rand(h.dmg[0], h.dmg[1])),
              knock: h.knock,
            });
            continue;
          }

          const { hit, at } = contactCheck(f, opp, h.reach, h.part ?? atk.part);
          if (!hit) {
            // 够不着 = 挥空
            spawn(at.x + f.facing * 12, at.y, 'rgba(120,120,120,0.45)', 'dust', 3, 0.4);
            continue;
          }

          // 架势值系统：格挡要付出代价，撑不住就破防（破防中无法格挡且挨打更疼）
          const meta0 = MOVE_META[f.state];
          const guarding = opp.state === 'block' && opp.guardBreak <= 0;
          const broken = opp.guardBreak > 0;
          const mul = guarding ? (meta0?.breakGuard ? 0.62 : 0.34) : broken ? 1.6 : 1;
          const dmg = Math.round(rand(h.dmg[0], h.dmg[1]) * mul);
          opp.hp = Math.max(0, opp.hp - dmg);
          popups.push({ x: at.x + rand(-6, 6), y: at.y - 26, text: '-' + dmg, life: 0, max: 0.9, color: guarding ? '#6BA8D6' : broken ? '#FFD24A' : '#E23B2E' });
          // 每招专属打击特效（取代原来所有招共用的一套方形火花）
          burstFx(f.state, at.x, at.y, f.facing, guarding);

          if (guarding) {
            // 格挡扣架势：重招、破防招扣得多
            const cost = (meta0?.breakGuard ? 36 : 23) * (h.knock > 300 ? 1.45 : 1);
            opp.guard -= cost;
            const broke = opp.guard <= 0;
            spawn(at.x, at.y, broke ? '#FFD24A' : '#9AD9FF', 'block', broke ? 13 : 6, broke ? 1.5 : 0.8);
            opp.kb = f.facing * (h.knock > 300 ? 180 : 135); // 格挡也会被压退，不是钉在原地
            opp.sway = 0.3;
            opp.counterWindow = 0.16;
            f.comboSteps = null;
            f.kb = -f.facing * 72;
            hitstop = Math.max(hitstop, 0.03);

            if (broke) {
              opp.guard = 0;
              opp.guardBreak = 0.8;
              setState(opp, 'stumble');
              shake = Math.max(shake, 7);
              zoom = Math.max(zoom, 0.035);
              impactRings.push({ x: at.x, y: at.y, r0: 6, r1: 46, life: 0, max: 0.34, color: '#FFD24A', wide: 3 });
              popups.push({ x: at.x, y: at.y - 44, text: 'GUARD BREAK', life: 0, max: 1.1, color: '#FFD24A' });
            }
            continue;
          }

          opp.flash = 1;
          opp.kb = f.facing * h.knock;
          opp.sway = h.knock > 320 ? 1 : 0.55;
          f.comboTimer = 0.45;
          hitstop = Math.max(hitstop, atk.hitstop);

          if (opp.hp <= 0) {
            spawn(at.x, at.y, '#FAC901', 'hit', 14, 1.6);
            startRagdoll(opp);
            break;
          }

          // 被打断：对手的连招清零
          opp.comboSteps = null;
          opp.comboIndex = 0;

          // 连招：命中后按连招表接下一段
          if (f.comboSteps) {
            const nextIdx = f.comboIndex + 1;
            if (nextIdx < f.comboSteps.length && Math.random() < 0.7) {
              f.comboIndex = nextIdx;
              f.cool = 0;
              f.intentLock = 0;
              f.pendingCombo = f.comboSteps[nextIdx]; // 等过了取消点再切，收招被"取消"掉
            } else {
              f.comboSteps = null;
              f.comboIndex = 0;
            }
          } else if (Math.random() < 0.45) {
            const c = COMBOS[Math.floor(Math.random() * COMBOS.length)];
            f.comboSteps = c.steps;
            f.comboIndex = 0;
            f.cool = 0;
            f.intentLock = 0;
            f.pendingCombo = c.steps[0];
          }

          // 按招式决定对手的反应姿态
          opp.stagger = atk.react === 'light' ? 0.22 : 0.4;
          setState(opp, atk.react === 'up' ? 'hurtUp' : atk.react === 'heavy' ? 'hurtHeavy' : 'hurtLight');
          opp.stun = atk.react === 'light' ? 0.2 : atk.react === 'up' ? 0.5 : 0.42;
          opp.cool = Math.max(opp.cool, 0.3);
        }
      }

      /* --- 连招取消窗口：命中后过了取消点就立刻接下一段，收招被"取消"掉 --- */
      if (atk && f.pendingCombo && prog >= (atk.cancelFrom ?? 0.78)) {
        const nx = f.pendingCombo;
        f.pendingCombo = null;
        f.cool = 0;
        setState(f, nx as State);
        continue;
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
      }

      /* --- 待机时做决策（自主模式下自动出手，演示模式下关闭） --- */
      if (!opts.demo && f.state === 'idle') {
        f.cool -= dt;
        f.lastDecision += dt;
        if (f.cool <= 0 && f.stun <= 0 && f.lastDecision > 0.1) {
          f.lastDecision = 0;
          applyDecision(f, opp, decide(f, opp));
        }
      }
    }

    // 位置约束：不许穿模
    for (const f of fighters) keepDistance(f);

    // 演示模式定格（逐帧检查）时，特效也一并冻结，方便截图对比
    if (!(opts.demo && demoPaused)) {
      for (const s of sparks) {
        s.life += dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += (s.kind === 'dust' ? 120 : 420) * dt;
        if (s.kind === 'dust') s.vx *= 0.94;
      }
      sparks = sparks.filter((s) => s.life < s.max);
      for (const r of impactRings) r.life += dt;
      for (const l of speedLines) l.life += dt;
      impactRings = impactRings.filter((r) => r.life < r.max);
      speedLines = speedLines.filter((l) => l.life < l.max);
      for (const p of popups) { p.life += dt; p.y -= 34 * dt; }
      popups = popups.filter((p) => p.life < p.max);
      shake *= 0.82;
      shakeDir *= 0.82;
      zoom *= 0.86;
      if (zoom < 0.002) zoom = 0;
    }
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
    // 只画同色圆盖，不再加描边，关节不外露
    disc(p, r * 0.9, fill);
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
    gear: Gear,
    side: number,
    torsoScale: number,
    sway: number,
    cloth: Dangle | null,
    trinket: Dangle | null
  ) => {
    const pelvis = get('pelvis');
    const chest = get('chest');
    const head = get('head');
    // 需要画在「近侧手臂之后」的刚性件（盾/锤/枪），否则会被手臂盖住
    const after: (() => void)[] = [];

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const depthAlpha = (z: number) => Math.max(0.85, Math.min(1.0, 0.9 + (z + 14) * 0.006));

    const zB = (get('elbowB').z || 0) + (get('handB').z || 0);
    const zF = (get('elbowF').z || 0) + (get('handF').z || 0);
    const backArmIsFarther = zB <= zF;
    const zLegB = (get('kneeB').z || 0) + (get('footB').z || 0);
    const zLegF = (get('kneeF').z || 0) + (get('footF').z || 0);
    const backLegIsFarther = zLegB <= zLegF;

    // 护具绑带：垂直于肢体方向画一条圆头粗线（护肘/护腕/护膝/靴口通用）
    const pad = (p: Pt, ang: number, w: number, lw: number, color: string) => {
      const px = Math.cos(ang + Math.PI / 2);
      const py = Math.sin(ang + Math.PI / 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x - px * w, p.y - py * w);
      ctx.lineTo(p.x + px * w, p.y + py * w);
      ctx.stroke();
    };

    /* ---------- 服装层：骨架只是骨头，这一层让它变成"穿衣服的人" ---------- */
    const o = GEAR_SPEC[gear].outfit;
    const SLEEVE_COL = o.sleeve === 'metal' ? '#8B5E3C' : o.sleeve === 'bandage' ? trim : dark;
    const LEG_COL = o.leg === 'armored' ? '#8B5E3C' : o.leg === 'wrapped' ? trim : dark;
    const COAT_COL = ['armor', 'hauberk', 'gearPlate', 'leather'].includes(o.torso) ? '#8B5E3C' : dark;

    /** 衣片：沿肢体铺一片有轮廓的布（梯形/喇叭/束口/缠布），比骨线宽一圈 */
    const garment = (a: Pt, b: Pt, w1: number, w2: number, type: Outfit['sleeve'], color: string) => {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const nx = Math.cos(ang + Math.PI / 2);
      const ny = Math.sin(ang + Math.PI / 2);
      const e = type === 'wide' ? w2 * 2.0 : type === 'rolled' ? w2 * 1.3 : type === 'bandage' ? w2 * 1.2 : w2 * 1.12;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(a.x + nx * w1, a.y + ny * w1);
      ctx.lineTo(b.x + nx * e, b.y + ny * e);
      if (type === 'bandage') {
        // 缠布：末端做出布条层叠的错口
        ctx.lineTo(b.x + nx * e * 0.35, b.y + ny * e * 0.35 + 2 * k);
        ctx.lineTo(b.x - nx * e * 0.35, b.y - ny * e * 0.35 + 2 * k);
      }
      ctx.lineTo(b.x - nx * e, b.y - ny * e);
      ctx.lineTo(a.x - nx * w1, a.y - ny * w1);
      ctx.closePath();
      ctx.fill();
    };

    /** 躯干外衣：按流派铺在躯干上（长袍/胸甲/罩袍/交领/皮甲/外套/锁甲/机关甲） */
    const drawTorsoGarment = () => {
      const dx = chest.x - pelvis.x;
      const dy = chest.y - pelvis.y;
      const dl = Math.hypot(dx, dy) || 1;
      const nx = -dy / dl;
      const ny = dx / dl;
      ctx.save();
      if (o.torso === 'robe' || o.torso === 'coat') {
        // 长袍 / 长外套：从胸包到膝上，下摆外扩（外套后摆更方）
        const hem = o.torso === 'coat' ? 20 : 17;
        ctx.fillStyle = COAT_COL;
        ctx.beginPath();
        ctx.moveTo(chest.x + nx * 7 * k, chest.y + ny * 7 * k);
        ctx.lineTo(chest.x - nx * 7 * k, chest.y - ny * 7 * k);
        ctx.lineTo(pelvis.x - nx * 11 * k, pelvis.y + hem * k);
        ctx.lineTo(pelvis.x + nx * 11 * k, pelvis.y + hem * k);
        ctx.closePath();
        ctx.fill();
        if (o.torso === 'coat') {
          // 外套开襟：前中一条竖缝 + 翻领
          ctx.strokeStyle = trim;
          ctx.lineWidth = 1.4 * k;
          ctx.beginPath();
          ctx.moveTo(chest.x + facing * 2 * k, chest.y + 3 * k);
          ctx.lineTo(pelvis.x + facing * 3 * k, pelvis.y + hem * k - 2 * k);
          ctx.stroke();
        }
      } else if (o.torso === 'armor' || o.torso === 'hauberk') {
        // 胸甲 / 锁甲：整块护胸 + 中缝 + 下缘弧
        ctx.fillStyle = COAT_COL;
        ctx.beginPath();
        ctx.moveTo(chest.x + nx * 8 * k, chest.y + ny * 8 * k - 2 * k);
        ctx.quadraticCurveTo(chest.x + nx * 9 * k, (chest.y + pelvis.y) / 2, pelvis.x + nx * 7 * k, pelvis.y);
        ctx.lineTo(pelvis.x - nx * 7 * k, pelvis.y);
        ctx.quadraticCurveTo(chest.x - nx * 9 * k, (chest.y + pelvis.y) / 2, chest.x - nx * 8 * k, chest.y + ny * 8 * k - 2 * k);
        ctx.closePath();
        ctx.fill();
        if (o.torso === 'hauberk') {
          // 锁甲：点阵纹理
          ctx.fillStyle = trim;
          for (let i = -2; i <= 2; i++) {
            for (let j = 0; j < 3; j++) {
              disc({ x: chest.x + nx * i * 3 * k + (dx / dl) * -j * 3.4 * k, y: chest.y + ny * i * 3 * k + (dy / dl) * -j * 3.4 * k, z: 0 }, 0.7 * k, trim);
            }
          }
        }
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1.2 * k;
        ctx.beginPath();
        ctx.moveTo(chest.x, chest.y + 2 * k);
        ctx.lineTo(pelvis.x, pelvis.y - 2 * k);
        ctx.stroke();
      } else if (o.torso === 'tabard') {
        // 罩袍：胸前一片长布，下摆方角
        ctx.fillStyle = COAT_COL;
        ctx.beginPath();
        ctx.moveTo(chest.x + nx * 5 * k, chest.y + ny * 5 * k);
        ctx.lineTo(chest.x - nx * 5 * k, chest.y + ny * 5 * k);
        ctx.lineTo(pelvis.x - nx * 6 * k, pelvis.y + 13 * k);
        ctx.lineTo(pelvis.x + nx * 6 * k, pelvis.y + 13 * k);
        ctx.closePath();
        ctx.fill();
      } else if (o.torso === 'kimono') {
        // 交领：左右两片叠合的 V 形衣襟
        ctx.fillStyle = trim;
        ctx.beginPath();
        ctx.moveTo(chest.x - nx * 6 * k, chest.y + ny * 6 * k - 3 * k);
        ctx.lineTo(chest.x + nx * 1 * k, chest.y + ny * 1 * k + 5 * k);
        ctx.lineTo(pelvis.x + nx * 5 * k, pelvis.y + 2 * k);
        ctx.lineTo(pelvis.x - nx * 5 * k, pelvis.y + 2 * k);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = COAT_COL;
        ctx.beginPath();
        ctx.moveTo(chest.x + nx * 6 * k, chest.y + ny * 6 * k - 3 * k);
        ctx.lineTo(chest.x - nx * 1 * k, chest.y - ny * 1 * k + 5 * k);
        ctx.lineTo(pelvis.x - nx * 6 * k, pelvis.y + 3 * k);
        ctx.lineTo(pelvis.x + nx * 6 * k, pelvis.y + 3 * k);
        ctx.closePath();
        ctx.fill();
      } else if (o.torso === 'leather') {
        // 皮甲：躯干描边 + 两条斜挎皮带
        ctx.strokeStyle = COAT_COL;
        ctx.lineWidth = 5.2 * k;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(chest.x + nx * 5 * k, chest.y + ny * 5 * k);
        ctx.lineTo(pelvis.x - nx * 4 * k, pelvis.y + 1 * k);
        ctx.stroke();
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1.6 * k;
        ctx.beginPath();
        ctx.moveTo(chest.x + nx * 5 * k, chest.y + ny * 5 * k);
        ctx.lineTo(pelvis.x - nx * 4 * k, pelvis.y + 1 * k);
        ctx.stroke();
      } else if (o.torso === 'gearPlate') {
        // 机关甲：分块钢板 + 铆钉 + 腰侧齿轮
        ctx.fillStyle = COAT_COL;
        ctx.fillRect(chest.x - 6 * k, chest.y - 2 * k, 12 * k, 10 * k);
        ctx.fillStyle = trim;
        for (let i = 0; i < 4; i++) {
          disc({ x: chest.x - 4.5 * k + i * 3 * k, y: chest.y - 0.5 * k, z: 0 }, 0.8 * k, trim);
        }
        // 齿轮（旋转动画，不占物理预算）
        const gr = 3.2 * k;
        const ga = performance.now() * 0.002;
        ctx.strokeStyle = '#C9A227';
        ctx.lineWidth = 1.3 * k;
        ctx.beginPath();
        ctx.arc(pelvis.x + facing * 7 * k, pelvis.y + 1 * k, gr, 0, TAU);
        ctx.stroke();
        for (let i = 0; i < 6; i++) {
          const a = ga + (i / 6) * TAU;
          ctx.beginPath();
          ctx.moveTo(pelvis.x + facing * 7 * k + Math.cos(a) * gr, pelvis.y + 1 * k + Math.sin(a) * gr);
          ctx.lineTo(pelvis.x + facing * 7 * k + Math.cos(a) * (gr + 1.4 * k), pelvis.y + 1 * k + Math.sin(a) * (gr + 1.4 * k));
          ctx.stroke();
        }
      } else {
        // shirt：贴身衣，只加领口与下摆
        ctx.strokeStyle = trim;
        ctx.lineWidth = 2.0 * k;
        ctx.beginPath();
        ctx.moveTo(chest.x - nx * 5 * k, chest.y + ny * 5 * k);
        ctx.lineTo(chest.x + nx * 5 * k, chest.y + ny * 5 * k);
        ctx.stroke();
      }

      /* 下装延伸：裙/战裙/袴 —— 盖住大腿根，让下半身有体积 */
      if (o.leg === 'skirt' || o.leg === 'kilt' || o.leg === 'hakama') {
        const drop = o.leg === 'hakama' ? 22 : o.leg === 'kilt' ? 14 : 16;
        const spread = o.leg === 'hakama' ? 14 : 12;
        ctx.fillStyle = o.leg === 'kilt' ? COAT_COL : LEG_COL;
        ctx.beginPath();
        ctx.moveTo(pelvis.x - nx * 8 * k, pelvis.y - 1 * k);
        ctx.lineTo(pelvis.x + nx * 8 * k, pelvis.y - 1 * k);
        ctx.lineTo(pelvis.x + nx * spread * k, pelvis.y + drop * k);
        if (o.leg === 'kilt') {
          // 短裙下摆做几个布褶尖角
          ctx.lineTo(pelvis.x + nx * spread * 0.4 * k, pelvis.y + (drop - 3) * k);
          ctx.lineTo(pelvis.x, pelvis.y + drop * k);
          ctx.lineTo(pelvis.x - nx * spread * 0.4 * k, pelvis.y + (drop - 3) * k);
        }
        ctx.lineTo(pelvis.x - nx * spread * k, pelvis.y + drop * k);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    };

    /** 护肩：刚性装备（单肩/双肩/毛皮/尖刺/机关） */
    const drawPauldron = () => {
      if (o.pauldron === 'none') return;
      const shF = get('shoulderF');
      const shB = get('shoulderB');
      const one = (p: Pt, s: number) => {
        if (o.pauldron === 'fur') {
          // 毛皮披肩：外缘做锯齿毛边
          ctx.fillStyle = '#8B5E3C';
          ctx.beginPath();
          const rr = 6.2 * k * s;
          for (let i = 0; i <= 10; i++) {
            const a = Math.PI * 0.15 + (i / 10) * Math.PI * 1.2;
            const rr2 = rr * (i % 2 === 0 ? 1 : 0.78);
            const px = p.x + Math.cos(a) * rr2;
            const py = p.y + Math.sin(a) * rr2;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
        } else if (o.pauldron === 'spiked') {
          disc(p, 5.2 * k * s, '#8B5E3C');
          disc(p, 3.6 * k * s, trim);
          ctx.strokeStyle = '#E8EEF7';
          ctx.lineWidth = 1.6 * k;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - 4 * k * s);
          ctx.lineTo(p.x + facing * 1.5 * k, p.y - 9 * k * s);
          ctx.stroke();
        } else if (o.pauldron === 'gear') {
          ctx.fillStyle = '#8B5E3C';
          ctx.fillRect(p.x - 5 * k * s, p.y - 4 * k * s, 10 * k * s, 7 * k * s);
          ctx.strokeStyle = '#C9A227';
          ctx.lineWidth = 1.4 * k;
          ctx.beginPath();
          ctx.arc(p.x, p.y - 0.5 * k, 2.6 * k * s, 0, TAU);
          ctx.stroke();
        } else {
          disc(p, 5.0 * k * s, '#8B5E3C');
          disc(p, 3.6 * k * s, trim);
        }
      };
      if (o.pauldron === 'single') one(shF, 1);
      else {
        one(shB, 0.82);
        one(shF, 1);
      }
    };

    const drawArm = (which: 'B' | 'F', base: string) => {
      const s = get(which === 'B' ? 'shoulderB' : 'shoulderF');
      const e = get(which === 'B' ? 'elbowB' : 'elbowF');
      const h = get(which === 'B' ? 'handB' : 'handF');
      ctx.save();
      ctx.globalAlpha *= depthAlpha(((e.z || 0) + (h.z || 0)) / 2);
      // 上臂骨线
      limb(s, e, 4.6 * k, 3.8 * k, base);
      // 衣袖（盖在骨线外，四肢才有"穿着衣服"的体积）
      garment(s, e, 5.6 * k, 4.6 * k, o.sleeve, SLEEVE_COL);
      // 肘部护甲（盖住关节）
      const angElbow = Math.atan2(e.y - s.y, e.x - s.x);
      pad(e, angElbow, 4.3 * k, 3.4 * k, trim);
      // 前臂
      limb(e, h, 3.6 * k, 3.0 * k, base);
      // 皮质护腕
      const angWrist = Math.atan2(h.y - e.y, h.x - e.x);
      pad({ x: h.x - Math.cos(angWrist) * 2.4 * k, y: h.y - Math.sin(angWrist) * 2.4 * k, z: 0 }, angWrist, 2.3 * k, 2.6 * k, trim);
      hand(h, k, base, facing);
      ctx.restore();
    };

    const drawLeg = (which: 'B' | 'F', base: string) => {
      const hip = get(which === 'B' ? 'hipB' : 'hipF');
      const knee = get(which === 'B' ? 'kneeB' : 'kneeF');
      const foot = get(which === 'B' ? 'footB' : 'footF');
      ctx.save();
      ctx.globalAlpha *= depthAlpha(((knee.z || 0) + (foot.z || 0)) / 2);
      // 大腿骨线
      limb(hip, knee, (which === 'B' ? 5.0 : 5.6) * k, (which === 'B' ? 4.0 : 4.5) * k, base);
      // 裤管 / 护腿板 / 绑腿（覆盖大腿）
      if (o.leg === 'armored') {
        garment(hip, knee, 6.4 * k, 5.2 * k, 'metal', LEG_COL);
      } else if (o.leg === 'wrapped') {
        garment(hip, knee, 6.0 * k, 4.8 * k, 'bandage', LEG_COL);
      } else if (o.leg !== 'skirt' && o.leg !== 'kilt' && o.leg !== 'hakama') {
        garment(hip, knee, 6.2 * k, 5.0 * k, 'tight', LEG_COL);
      }
      // 皮质护膝（盖住关节）
      const angKnee = Math.atan2(knee.y - hip.y, knee.x - hip.x);
      pad(knee, angKnee, 4.6 * k, 3.4 * k, trim);
      // 小腿
      limb(knee, foot, (which === 'B' ? 3.8 : 4.2) * k, 3.2 * k, base);
      // 靴口翻边
      const angAnkle = Math.atan2(foot.y - knee.y, foot.x - knee.x);
      pad({ x: foot.x, y: foot.y - 1.6 * k, z: 0 }, angAnkle, 3.4 * k, 3.0 * k, trim);
      shoe(foot, facing, k, base);
      ctx.restore();
    };

    drawArm(backArmIsFarther ? 'B' : 'F', dark);
    drawLeg(backLegIsFarther ? 'B' : 'F', dark);

    torsoShape(pelvis, chest, k * torsoScale, body);
    // 服装层：外衣 + 下装 + 护肩，压在躯干之上、腰带之下
    drawTorsoGarment();
    drawPauldron();

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
    // 腰带扣
    disc({ x: bcx, y: bcy, z: 0 }, 2.4 * k, '#C9A227');

    // 脖子
    const neckA: Pt = { x: chest.x + (chest.x - pelvis.x) * 0.1, y: chest.y + (chest.y - pelvis.y) * 0.1, z: 0 };
    limb(neckA, { x: head.x - facing * 3 * k, y: head.y + L.headR * k * 0.7, z: 0 }, 3.5 * k, 3.2 * k, dark);

    headShape(head, k, body, trim, expr, side, camFace);

    // 装备与发型：剑客（护额/束发/单护肩/交叉皮带/交领/背剑/腰带尾）
    //              游侠（破损兜帽/羽毛/眼罩/凌乱短发/破边斗篷/箭袋/短弓/腰包）
    if (gear === 'swordsman') {
      // 额前护额（一条横带）
      pad({ x: head.x, y: head.y - L.headR * 0.32 * k, z: 0 }, 0, L.headR * 1.0 * k, 2.6 * k, trim);
      // 发髻（头顶小圆髻）
      disc({ x: head.x, y: head.y - (L.headR + 1.4) * k, z: 0 }, 2.6 * k, trim);
      // 低马尾 + 束发绳结（绳结在发根）
      const hx = head.x - facing * L.headR * 0.6 * k;
      const hy = head.y + L.headR * 0.7 * k;
      disc({ x: hx, y: hy, z: 0 }, 1.7 * k, '#C9A227');
      ctx.strokeStyle = trim;
      ctx.lineWidth = 3.4 * k;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.quadraticCurveTo(hx - facing * 1.5 * k, hy + 9 * k, hx + facing * 1.2 * k - sway * facing * 7 * k, hy + 15 * k);
      ctx.stroke();
      // 胸前交叉皮带（两条斜带）—— 交领与护肩已由通用服装层绘制
      const shF = get('shoulderF');
      const hipB2 = get('hipB');
      const hipF2 = get('hipF');
      ctx.strokeStyle = '#8B5E3C';
      ctx.lineWidth = 2.6 * k;
      ctx.beginPath();
      ctx.moveTo(shF.x, shF.y);
      ctx.lineTo(hipB2.x, hipB2.y + 2 * k);
      ctx.moveTo(get('shoulderB').x, get('shoulderB').y);
      ctx.lineTo(hipF2.x, hipF2.y + 2 * k);
      ctx.stroke();
      // 背剑：剑鞘斜背身后 + 剑柄从肩上伸出 + 剑格
      const sB = get('shoulderB');
      const hB = get('hipB');
      const dxg = sB.x - hB.x;
      const dyg = sB.y - hB.y;
      const lg = Math.hypot(dxg, dyg) || 1;
      const ux = dxg / lg;
      const uy = dyg / lg;
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 4.4 * k;
      ctx.beginPath();
      ctx.moveTo(sB.x - ux * 2, sB.y - uy * 2);
      ctx.lineTo(hB.x + ux * 1.5, hB.y + uy * 1.5);
      ctx.stroke();
      ctx.strokeStyle = trim;
      ctx.lineWidth = 2.8 * k;
      ctx.beginPath();
      ctx.moveTo(sB.x, sB.y);
      ctx.lineTo(sB.x + ux * 7 * k, sB.y + uy * 7 * k);
      ctx.stroke();
      ctx.lineWidth = 2.4 * k;
      ctx.beginPath();
      ctx.moveTo(sB.x + ux * 5.5 * k - uy * 3.2 * k, sB.y + uy * 5.5 * k + ux * 3.2 * k);
      ctx.lineTo(sB.x + ux * 5.5 * k + uy * 3.2 * k, sB.y + uy * 5.5 * k - ux * 3.2 * k);
      ctx.stroke();
      // 腰带尾（从腰带垂下，击打时飘动）
      ctx.fillStyle = '#8B5E3C';
      ctx.beginPath();
      ctx.moveTo(bcx, bcy);
      ctx.lineTo(bcx - facing * 3 * k - sway * facing * 8 * k, bcy + 9 * k);
      ctx.lineTo(bcx + facing * 1 * k - sway * facing * 6 * k, bcy + 8 * k);
      ctx.closePath();
      ctx.fill();
    } else if (gear === 'ranger') {
      // 游侠：破损兜帽（弧形帽檐 + 一处豁口）
      ctx.strokeStyle = trim;
      ctx.lineWidth = 4 * k;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.ellipse(head.x, head.y - L.headR * 0.1 * k, L.headR * 1.12 * k, L.headR * 1.0 * k, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
      // 凌乱短发（兜帽下几撮）
      ctx.lineWidth = 1.8 * k;
      ctx.beginPath();
      ctx.moveTo(head.x - facing * L.headR * 0.4 * k, head.y + L.headR * 0.3 * k);
      ctx.lineTo(head.x - facing * L.headR * 0.7 * k, head.y + L.headR * 0.75 * k);
      ctx.moveTo(head.x - facing * L.headR * 0.1 * k, head.y + L.headR * 0.35 * k);
      ctx.lineTo(head.x - facing * L.headR * 0.3 * k, head.y + L.headR * 0.85 * k);
      ctx.stroke();
      // 羽毛头饰（插在兜帽侧）
      ctx.strokeStyle = '#C9A227';
      ctx.lineWidth = 1.6 * k;
      ctx.beginPath();
      ctx.moveTo(head.x - facing * L.headR * 0.9 * k, head.y - L.headR * 0.8 * k);
      ctx.quadraticCurveTo(head.x - facing * L.headR * 1.6 * k, head.y - L.headR * 0.4 * k, head.x - facing * L.headR * 1.9 * k - sway * facing * 3 * k, head.y + L.headR * 0.2 * k);
      ctx.stroke();
      // 单眼眼罩（斜带 + 盖住一只眼）
      const eyePatchX = head.x + side * L.headR * 0.46 * k;
      const eyePatchY = head.y + L.headR * 0.02 * k;
      ctx.strokeStyle = '#3A2E00';
      ctx.lineWidth = 2.0 * k;
      ctx.beginPath();
      ctx.moveTo(eyePatchX - side * L.headR * 0.8 * k, eyePatchY - L.headR * 0.5 * k);
      ctx.lineTo(eyePatchX + side * L.headR * 0.6 * k, eyePatchY + L.headR * 0.5 * k);
      ctx.stroke();
      ctx.fillStyle = '#3A2E00';
      ctx.beginPath();
      ctx.ellipse(eyePatchX, eyePatchY, L.headR * 0.28 * k, L.headR * 0.22 * k, 0, 0, TAU);
      ctx.fill();
      // 破边斗篷（从肩向后飘，下摆几处豁口）
      const sB = get('shoulderB');
      const hB = get('hipB');
      ctx.fillStyle = trim;
      ctx.beginPath();
      ctx.moveTo(sB.x, sB.y - 2 * k);
      ctx.quadraticCurveTo(sB.x - facing * 13 * k, sB.y + 9 * k, sB.x - facing * 5 * k - sway * facing * 10 * k, hB.y + 11 * k);
      ctx.lineTo(sB.x - facing * 2 * k - sway * facing * 8 * k, hB.y + 9 * k);
      ctx.lineTo(sB.x - facing * 1 * k - sway * facing * 7 * k, hB.y + 11 * k);
      ctx.lineTo(sB.x + facing * 1 * k, hB.y + 5 * k);
      ctx.closePath();
      ctx.fill();
      // 斜挎箭袋 + 羽毛箭
      const shF = get('shoulderF');
      const hipB2 = get('hipB');
      ctx.strokeStyle = '#8B5E3C';
      ctx.lineWidth = 3.0 * k;
      ctx.beginPath();
      ctx.moveTo(shF.x, shF.y);
      ctx.lineTo(hipB2.x, hipB2.y + 2 * k);
      ctx.stroke();
      // 箭袋（腰后小袋）
      ctx.fillStyle = '#8B5E3C';
      ctx.beginPath();
      ctx.ellipse(hipB2.x, hipB2.y + 2 * k, 3.0 * k, 5.5 * k, 0.3, 0, TAU);
      ctx.fill();
      // 三支羽毛箭（箭羽露出）
      for (let ai = 0; ai < 3; ai++) {
        const ax = hipB2.x + (ai - 1) * 2.0 * k;
        const ay = hipB2.y - 2 * k - sway * ai * 1.5 * k;
        ctx.strokeStyle = '#C9A227';
        ctx.lineWidth = 1.4 * k;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax, ay - 6 * k);
        ctx.stroke();
      }
      // 短弓（背在身后：弓臂 + 弦）
      const bowTop = { x: sB.x + facing * 2 * k, y: sB.y - 6 * k };
      const bowBot = { x: sB.x - facing * 2 * k, y: hB.y + 8 * k };
      ctx.strokeStyle = '#8B5E3C';
      ctx.lineWidth = 2.6 * k;
      ctx.beginPath();
      ctx.moveTo(bowTop.x, bowTop.y);
      ctx.quadraticCurveTo(sB.x - facing * 10 * k, (bowTop.y + bowBot.y) / 2, bowBot.x, bowBot.y);
      ctx.stroke();
      ctx.strokeStyle = '#E8EEF7';
      ctx.lineWidth = 1.0 * k;
      ctx.beginPath();
      ctx.moveTo(bowTop.x, bowTop.y);
      ctx.lineTo(bowBot.x, bowBot.y);
      ctx.stroke();
      // 围巾
      ctx.fillStyle = trim;
      ctx.beginPath();
      ctx.moveTo(neckA.x, neckA.y - 1 * k);
      ctx.lineTo(neckA.x - facing * 7 * k, neckA.y + 3 * k);
      ctx.lineTo(neckA.x - facing * 2 * k - sway * facing * 5 * k, neckA.y + 6 * k);
      ctx.closePath();
      ctx.fill();
      // 腰包
      ctx.fillStyle = '#8B5E3C';
      ctx.beginPath();
      ctx.ellipse(bcx + facing * 3 * k, bcy + 2 * k, 3.0 * k, 2.6 * k, 0, 0, TAU);
      ctx.fill();
    } else {
      /* ===== 新流派：1 个主剪影装饰 + 最多 2 类动态件 ===== */
      const spec = GEAR_SPEC[gear];
      const shF = get('shoulderF');
      const shB = get('shoulderB');
      const hF = get('handF');
      const hB = get('handB');
      const eF = get('elbowF');
      const eB = get('elbowB');
      const hipB = get('hipB');
      const hipF = get('hipF');
      const foreF = Math.atan2(hF.y - eF.y, hF.x - eF.x);
      const foreB = Math.atan2(hB.y - eB.y, hB.x - eB.x);
      /** 沿某方向从一点刚性延伸（武器绑手骨：跟着前臂走，不独立飘） */
      const ext = (p: Pt, ang: number, len: number): Pt => ({
        x: p.x + Math.cos(ang) * len * k,
        y: p.y + Math.sin(ang) * len * k,
        z: 0,
      });

      /* --- 头部装饰 --- */
      if (gear === 'shield') {
        // 圆盔 + 护鼻（护鼻竖直一条，剪影立刻变"铁罐头"）
        ctx.fillStyle = '#8B5E3C';
        ctx.beginPath();
        ctx.arc(head.x, head.y - L.headR * 0.1 * k, L.headR * 1.02 * k, Math.PI, TAU);
        ctx.fill();
        ctx.strokeStyle = trim;
        ctx.lineWidth = 2.4 * k;
        ctx.beginPath();
        ctx.moveTo(head.x, head.y - L.headR * 0.5 * k);
        ctx.lineTo(head.x, head.y + L.headR * 0.45 * k);
        ctx.stroke();
      } else if (gear === 'spear') {
        // 束发带 + 护额
        pad({ x: head.x, y: head.y - L.headR * 0.34 * k, z: 0 }, 0, L.headR * 1.02 * k, 2.8 * k, trim);
        disc({ x: head.x - facing * L.headR * 0.55 * k, y: head.y - L.headR * 0.72 * k, z: 0 }, 2.2 * k, '#C9A227');
      } else if (gear === 'dagger') {
        // 短兜帽（贴头弧）+ 半脸面罩
        ctx.strokeStyle = dark;
        ctx.lineWidth = 3.6 * k;
        ctx.beginPath();
        ctx.ellipse(head.x, head.y - L.headR * 0.05 * k, L.headR * 1.05 * k, L.headR * 0.95 * k, 0, Math.PI * 0.92, Math.PI * 2.08);
        ctx.stroke();
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.moveTo(head.x - facing * L.headR * 0.9 * k, head.y + L.headR * 0.05 * k);
        ctx.lineTo(head.x + facing * L.headR * 0.9 * k, head.y + L.headR * 0.05 * k);
        ctx.lineTo(head.x + facing * L.headR * 0.5 * k, head.y + L.headR * 0.75 * k);
        ctx.lineTo(head.x - facing * L.headR * 0.5 * k, head.y + L.headR * 0.75 * k);
        ctx.closePath();
        ctx.fill();
      } else if (gear === 'monk') {
        // 护额布条 + 耳侧短发际（头型沿用 headShape，不覆盖五官）
        pad({ x: head.x, y: head.y - L.headR * 0.38 * k, z: 0 }, 0, L.headR * 1.0 * k, 2.2 * k, trim);
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1.8 * k;
        ctx.beginPath();
        ctx.moveTo(head.x - facing * L.headR * 0.85 * k, head.y - L.headR * 0.1 * k);
        ctx.lineTo(head.x - facing * L.headR * 0.7 * k, head.y + L.headR * 0.6 * k);
        ctx.stroke();
      } else if (gear === 'hammer') {
        // 矮人盔（宽檐）+ 护耳
        ctx.fillStyle = '#8B5E3C';
        ctx.beginPath();
        ctx.arc(head.x, head.y - L.headR * 0.08 * k, L.headR * 1.05 * k, Math.PI * 0.95, TAU * 0.55);
        ctx.fill();
        ctx.strokeStyle = '#8B5E3C';
        ctx.lineWidth = 2.6 * k;
        ctx.beginPath();
        ctx.moveTo(head.x - L.headR * 1.05 * k, head.y - L.headR * 0.08 * k);
        ctx.lineTo(head.x + L.headR * 1.05 * k, head.y - L.headR * 0.08 * k);
        ctx.stroke();
      } else if (gear === 'gunner') {
        // 头巾 + 单眼护目镜（横带 + 镜片 + 带扣）
        ctx.strokeStyle = dark;
        ctx.lineWidth = 3.0 * k;
        ctx.beginPath();
        ctx.ellipse(head.x, head.y - L.headR * 0.28 * k, L.headR * 1.02 * k, L.headR * 0.9 * k, 0, Math.PI, TAU);
        ctx.stroke();
        ctx.strokeStyle = '#8B5E3C';
        ctx.lineWidth = 2.2 * k;
        ctx.beginPath();
        ctx.moveTo(head.x - side * L.headR * 0.95 * k, head.y - L.headR * 0.12 * k);
        ctx.lineTo(head.x + side * L.headR * 0.3 * k, head.y - L.headR * 0.28 * k);
        ctx.stroke();
        disc({ x: head.x + side * L.headR * 0.34 * k, y: head.y - L.headR * 0.14 * k, z: 0 }, L.headR * 0.3 * k, '#C9A227');
      } else if (gear === 'ninja') {
        // 深色头巾包顶 + 面罩遮下半脸 + 护额金属板
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.arc(head.x, head.y - L.headR * 0.12 * k, L.headR * 1.0 * k, Math.PI * 1.02, Math.PI * 1.98);
        ctx.fill();
        ctx.fillRect(head.x - L.headR * 0.95 * k, head.y - L.headR * 0.28 * k, L.headR * 1.9 * k, L.headR * 0.5 * k);
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.moveTo(head.x - facing * L.headR * 0.9 * k, head.y + L.headR * 0.1 * k);
        ctx.lineTo(head.x + facing * L.headR * 0.9 * k, head.y + L.headR * 0.1 * k);
        ctx.lineTo(head.x + facing * L.headR * 0.55 * k, head.y + L.headR * 0.8 * k);
        ctx.lineTo(head.x - facing * L.headR * 0.55 * k, head.y + L.headR * 0.8 * k);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#C9A227';
        ctx.fillRect(head.x - L.headR * 0.55 * k, head.y - L.headR * 0.34 * k, L.headR * 1.1 * k, L.headR * 0.26 * k);
      } else if (gear === 'drunk') {
        // 歪戴斗笠（旋转 12°）+ 红鼻头（醉态剪影）
        ctx.save();
        ctx.translate(head.x, head.y - L.headR * 0.3 * k);
        ctx.rotate(-facing * 0.21);
        ctx.fillStyle = '#B08D5A';
        ctx.beginPath();
        ctx.ellipse(0, 0, L.headR * 1.5 * k, L.headR * 0.55 * k, 0, Math.PI, TAU);
        ctx.fill();
        ctx.strokeStyle = '#8B5E3C';
        ctx.lineWidth = 1.6 * k;
        ctx.beginPath();
        ctx.arc(0, -L.headR * 0.06 * k, L.headR * 0.9 * k, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
        ctx.restore();
        disc({ x: head.x + side * L.headR * 0.3 * k, y: head.y + L.headR * 0.28 * k, z: 0 }, L.headR * 0.22 * k, '#E23B2E');
      } else if (gear === 'viking') {
        // 角盔：半圆盔顶 + 两支上翘牛角
        ctx.fillStyle = '#8B5E3C';
        ctx.beginPath();
        ctx.arc(head.x, head.y - L.headR * 0.1 * k, L.headR * 1.02 * k, Math.PI, TAU);
        ctx.fill();
        for (const s of [-1, 1]) {
          ctx.strokeStyle = '#E8EEF7';
          ctx.lineWidth = 2.8 * k;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(head.x + s * L.headR * 0.85 * k, head.y - L.headR * 0.35 * k);
          ctx.quadraticCurveTo(head.x + s * L.headR * 1.7 * k, head.y - L.headR * 1.15 * k, head.x + s * L.headR * 1.15 * k, head.y - L.headR * 1.7 * k);
          ctx.stroke();
        }
      } else if (gear === 'samurai') {
        // 阵笠：宽扁圆锥盖头 + 顶珠 + 下颌系带
        ctx.fillStyle = '#8B5E3C';
        ctx.beginPath();
        ctx.ellipse(head.x, head.y - L.headR * 0.15 * k, L.headR * 1.6 * k, L.headR * 0.95 * k, 0, Math.PI, TAU);
        ctx.fill();
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1.4 * k;
        ctx.beginPath();
        ctx.ellipse(head.x, head.y - L.headR * 0.15 * k, L.headR * 1.6 * k, L.headR * 0.95 * k, 0, Math.PI, TAU);
        ctx.stroke();
        disc({ x: head.x, y: head.y - L.headR * 1.05 * k, z: 0 }, 1.6 * k, '#C9A227');
        ctx.strokeStyle = '#8B5E3C';
        ctx.lineWidth = 1.6 * k;
        ctx.beginPath();
        ctx.moveTo(head.x - facing * L.headR * 1.3 * k, head.y - L.headR * 0.1 * k);
        ctx.lineTo(head.x - facing * L.headR * 0.4 * k, head.y + L.headR * 0.7 * k);
        ctx.stroke();
      } else if (gear === 'flail') {
        // 全罩面甲：竖条栅格（只露出眼睛缝）
        ctx.fillStyle = '#8B5E3C';
        ctx.beginPath();
        ctx.arc(head.x, head.y + L.headR * 0.05 * k, L.headR * 0.95 * k, Math.PI * 0.9, Math.PI * 2.1);
        ctx.fill();
        ctx.strokeStyle = dark;
        ctx.lineWidth = 1.4 * k;
        for (let i = -2; i <= 2; i++) {
          ctx.beginPath();
          ctx.moveTo(head.x + i * L.headR * 0.34 * k, head.y - L.headR * 0.5 * k);
          ctx.lineTo(head.x + i * L.headR * 0.34 * k, head.y + L.headR * 0.7 * k);
          ctx.stroke();
        }
      } else if (gear === 'puppeteer') {
        // 单眼护目镜（大镜片 + 传动带）+ 头侧工具插笔
        ctx.strokeStyle = dark;
        ctx.lineWidth = 2.6 * k;
        ctx.beginPath();
        ctx.ellipse(head.x, head.y - L.headR * 0.25 * k, L.headR * 1.0 * k, L.headR * 0.92 * k, 0, Math.PI, TAU);
        ctx.stroke();
        disc({ x: head.x + side * L.headR * 0.4 * k, y: head.y - L.headR * 0.1 * k, z: 0 }, L.headR * 0.42 * k, '#B7E3F5');
        ctx.strokeStyle = '#8B5E3C';
        ctx.lineWidth = 2.0 * k;
        ctx.beginPath();
        ctx.arc(head.x + side * L.headR * 0.4 * k, head.y - L.headR * 0.1 * k, L.headR * 0.42 * k, 0, TAU);
        ctx.stroke();
        ctx.strokeStyle = '#C9A227';
        ctx.lineWidth = 1.6 * k;
        ctx.beginPath();
        ctx.moveTo(head.x - side * L.headR * 0.7 * k, head.y - L.headR * 0.6 * k);
        ctx.lineTo(head.x - side * L.headR * 1.1 * k, head.y - L.headR * 1.5 * k);
        ctx.stroke();
      }

      /* --- 主剪影装饰：武器绑在手骨上（画在手臂之后） --- */
      after.push(() => {
        if (gear === 'shield') {
          // 鸢盾：刚性绑在近侧前臂外侧，碰撞体优先（画在最上层）
          const c = { x: (eF.x + hF.x) / 2, y: (eF.y + hF.y) / 2 };
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.rotate(foreF);
          ctx.fillStyle = '#8B5E3C';
          ctx.beginPath();
          ctx.moveTo(-6 * k, -8 * k);
          ctx.quadraticCurveTo(0, -11 * k, 6 * k, -8 * k);
          ctx.lineTo(6 * k, 6 * k);
          ctx.quadraticCurveTo(0, 12 * k, -6 * k, 6 * k);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = trim;
          ctx.beginPath();
          ctx.ellipse(0, -0.5 * k, 2.6 * k, 3.4 * k, 0, 0, TAU);
          ctx.fill();
          ctx.restore();
          // 后手短剑
          const tipB = ext(hB, foreB, 11);
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 3.0 * k;
          ctx.beginPath();
          ctx.moveTo(hB.x, hB.y);
          ctx.lineTo(tipB.x, tipB.y);
          ctx.stroke();
          ctx.strokeStyle = trim;
          ctx.lineWidth = 1.5 * k;
          ctx.beginPath();
          ctx.moveTo(hB.x, hB.y);
          ctx.lineTo(tipB.x, tipB.y);
          ctx.stroke();
        } else if (gear === 'spear') {
          // 长枪：杆沿前手方向刚性延伸，枪头三角 + 枪缨
          const tip = ext(hF, foreF, 30);
          const grip = ext(hB, foreF, -4);
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 4.0 * k;
          ctx.beginPath();
          ctx.moveTo(grip.x, grip.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          ctx.strokeStyle = '#8B5E3C';
          ctx.lineWidth = 2.4 * k;
          ctx.beginPath();
          ctx.moveTo(grip.x, grip.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          ctx.fillStyle = '#E8EEF7';
          ctx.beginPath();
          ctx.moveTo(tip.x, tip.y);
          ctx.lineTo(tip.x - Math.cos(foreF - 0.42) * 8 * k, tip.y - Math.sin(foreF - 0.42) * 8 * k);
          ctx.lineTo(tip.x - Math.cos(foreF + 0.42) * 8 * k, tip.y - Math.sin(foreF + 0.42) * 8 * k);
          ctx.closePath();
          ctx.fill();
          // 枪缨（挂在枪头根部的短簇，用挂件质点）
          if (trinket && !Number.isNaN(trinket.x)) {
            const root = ext(tip, foreF, -6);
            ctx.strokeStyle = '#DD0100';
            ctx.lineWidth = 2.2 * k;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(root.x, root.y);
            ctx.quadraticCurveTo((root.x + trinket.x) / 2, (root.y + trinket.y) / 2, trinket.x, trinket.y);
            ctx.stroke();
          }
        } else if (gear === 'dagger') {
          // 双短刀：两把分别绑左右手骨，刃短，避免长围巾抢戏
          for (const [hd, ang] of [
            [hF, foreF],
            [hB, foreB],
          ] as [Pt, number][]) {
            const tip = ext(hd, ang, 9);
            ctx.strokeStyle = OUTLINE;
            ctx.lineWidth = 3.4 * k;
            ctx.beginPath();
            ctx.moveTo(hd.x, hd.y);
            ctx.lineTo(tip.x, tip.y);
            ctx.stroke();
            ctx.strokeStyle = '#E8EEF7';
            ctx.lineWidth = 1.6 * k;
            ctx.beginPath();
            ctx.moveTo(hd.x, hd.y);
            ctx.lineTo(tip.x, tip.y);
            ctx.stroke();
          }
          // 交叉背带（胸前一 X）
          ctx.strokeStyle = '#8B5E3C';
          ctx.lineWidth = 2.4 * k;
          ctx.beginPath();
          ctx.moveTo(shF.x, shF.y);
          ctx.lineTo(hipB.x, hipB.y + 2 * k);
          ctx.moveTo(shB.x, shB.y);
          ctx.lineTo(hipF.x, hipF.y + 2 * k);
          ctx.stroke();
        } else if (gear === 'hammer') {
          // 大锤：长杆 + 大锤头（刚性大碰撞体，前摇长所以锤头要画得沉）
          const tip = ext(hF, foreF, 22);
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 4.6 * k;
          ctx.beginPath();
          ctx.moveTo(hF.x, hF.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          ctx.strokeStyle = '#8B5E3C';
          ctx.lineWidth = 2.8 * k;
          ctx.beginPath();
          ctx.moveTo(hF.x, hF.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          ctx.save();
          ctx.translate(tip.x, tip.y);
          ctx.rotate(foreF);
          ctx.fillStyle = '#8B5E3C';
          ctx.fillRect(-2.5 * k, -5 * k, 9 * k, 10 * k);
          ctx.fillStyle = trim;
          ctx.fillRect(4 * k, -5 * k, 2.2 * k, 10 * k);
          ctx.restore();
        } else if (gear === 'gunner') {
          // 弩：弩身沿前臂，弓臂横向，箭在槽上（远程武器刚性，弹道靠粒子）
          const tip = ext(hF, foreF, 15);
          ctx.strokeStyle = '#8B5E3C';
          ctx.lineWidth = 3.0 * k;
          ctx.beginPath();
          ctx.moveTo(hF.x, hF.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          const nx = Math.cos(foreF + Math.PI / 2);
          const ny = Math.sin(foreF + Math.PI / 2);
          const mid = { x: (hF.x + tip.x) / 2, y: (hF.y + tip.y) / 2 };
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 2.8 * k;
          ctx.beginPath();
          ctx.moveTo(mid.x - nx * 8 * k, mid.y - ny * 8 * k);
          ctx.quadraticCurveTo(mid.x + Math.cos(foreF) * 4 * k, mid.y + Math.sin(foreF) * 4 * k, mid.x + nx * 8 * k, mid.y + ny * 8 * k);
          ctx.stroke();
          ctx.strokeStyle = '#E8EEF7';
          ctx.lineWidth = 1.8 * k;
          ctx.beginPath();
          ctx.moveTo(tip.x - Math.cos(foreF) * 3 * k, tip.y - Math.sin(foreF) * 3 * k);
          ctx.lineTo(tip.x + Math.cos(foreF) * 7 * k, tip.y + Math.sin(foreF) * 7 * k);
          ctx.stroke();
        } else if (gear === 'ninja') {
          // 手握苦无（短直刃）+ 腰侧备用星镖
          const tip = ext(hF, foreF, 10);
          ctx.strokeStyle = '#E8EEF7';
          ctx.lineWidth = 2.6 * k;
          ctx.beginPath();
          ctx.moveTo(hF.x, hF.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          // 星形飞镖（腰侧，纯装饰不占物理）
          const sx = bcx - facing * 6 * k;
          const sy = bcy + 1 * k;
          ctx.fillStyle = '#C9A227';
          ctx.beginPath();
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * TAU + 0.3;
            const rr = i % 2 === 0 ? 3.2 * k : 1.4 * k;
            const px = sx + Math.cos(a) * rr;
            const py = sy + Math.sin(a) * rr;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
        } else if (gear === 'viking') {
          // 战斧：长柄 + 双面弧刃（轨迹大，挥砍覆盖广）
          const tip = ext(hF, foreF, 20);
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 4.2 * k;
          ctx.beginPath();
          ctx.moveTo(hB.x, hB.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          ctx.strokeStyle = '#8B5E3C';
          ctx.lineWidth = 2.6 * k;
          ctx.beginPath();
          ctx.moveTo(hB.x, hB.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          // 双面斧刃（垂直于柄的弧形）
          const na = foreF + Math.PI / 2;
          ctx.fillStyle = '#E8EEF7';
          ctx.beginPath();
          ctx.moveTo(tip.x - Math.cos(na) * 4 * k, tip.y - Math.sin(na) * 4 * k);
          ctx.quadraticCurveTo(tip.x + Math.cos(na) * 12 * k, tip.y + Math.sin(na) * 12 * k, tip.x + Math.cos(na) * 5 * k, tip.y + Math.sin(na) * 5 * k);
          ctx.quadraticCurveTo(tip.x + Math.cos(foreF) * 3 * k, tip.y + Math.sin(foreF) * 3 * k, tip.x - Math.cos(na) * 4 * k, tip.y - Math.sin(na) * 4 * k);
          ctx.closePath();
          ctx.fill();
        } else if (gear === 'samurai') {
          // 太刀：微弯长刃 + 腰间刀鞘（拔刀斩的空间预留）
          const tip = ext(hF, foreF, 24);
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 3.8 * k;
          ctx.beginPath();
          ctx.moveTo(hF.x, hF.y);
          ctx.quadraticCurveTo(
            hF.x + Math.cos(foreF - 0.12) * 12 * k,
            hF.y + Math.sin(foreF - 0.12) * 12 * k,
            tip.x,
            tip.y
          );
          ctx.stroke();
          ctx.strokeStyle = '#E8EEF7';
          ctx.lineWidth = 1.8 * k;
          ctx.beginPath();
          ctx.moveTo(hF.x, hF.y);
          ctx.quadraticCurveTo(
            hF.x + Math.cos(foreF - 0.12) * 12 * k,
            hF.y + Math.sin(foreF - 0.12) * 12 * k,
            tip.x,
            tip.y
          );
          ctx.stroke();
          // 腰间刀鞘（水平短鞘 + 镗口）
          ctx.strokeStyle = '#8B5E3C';
          ctx.lineWidth = 3.4 * k;
          ctx.beginPath();
          ctx.moveTo(bcx - facing * 2 * k, bcy);
          ctx.lineTo(bcx - facing * 11 * k, bcy - 2.5 * k);
          ctx.stroke();
        } else if (gear === 'flail') {
          // 链锤：短柄 + 分段刚性链（3 节，每节限制角度）+ 末端刺球
          const hilt = ext(hF, foreF, 6);
          ctx.strokeStyle = '#8B5E3C';
          ctx.lineWidth = 3.2 * k;
          ctx.beginPath();
          ctx.moveTo(hF.x, hF.y);
          ctx.lineTo(hilt.x, hilt.y);
          ctx.stroke();
          if (trinket && !Number.isNaN(trinket.x)) {
            // 链节：从柄端到锤头分 3 段，中间点随摆动偏移（近似限制角度的分段链）
            const segs = 3;
            for (let i = 0; i <= segs; i++) {
              const t = i / segs;
              const cx = hilt.x + (trinket.x - hilt.x) * t + Math.sin(t * Math.PI * 1.5) * 3 * k;
              const cy = hilt.y + (trinket.y - hilt.y) * t;
              if (i > 0) {
                const pt = i / segs - 1 / segs;
                const px = hilt.x + (trinket.x - hilt.x) * pt + Math.sin(pt * Math.PI * 1.5) * 3 * k;
                const py = hilt.y + (trinket.y - hilt.y) * pt;
                ctx.strokeStyle = '#C9A227';
                ctx.lineWidth = 1.8 * k;
                ctx.beginPath();
                ctx.moveTo(px, py);
                ctx.lineTo(cx, cy);
                ctx.stroke();
              }
            }
            // 末端刺球（碰撞体大，前摇长所以锤头画得沉）
            disc({ x: trinket.x, y: trinket.y, z: 0 }, 4.6 * k, '#8B5E3C');
            for (let i = 0; i < 6; i++) {
              const a = (i / 6) * TAU + 0.2;
              ctx.strokeStyle = '#C9A227';
              ctx.lineWidth = 1.4 * k;
              ctx.beginPath();
              ctx.moveTo(trinket.x + Math.cos(a) * 4.2 * k, trinket.y + Math.sin(a) * 4.2 * k);
              ctx.lineTo(trinket.x + Math.cos(a) * 6.4 * k, trinket.y + Math.sin(a) * 6.4 * k);
              ctx.stroke();
            }
          }
        } else if (gear === 'puppeteer') {
          // 机关臂：前臂外包刚性套管 + 液压杆 + 大拳（重拳部位，碰撞体沿套管）
          const mid = { x: (eF.x + hF.x) / 2, y: (eF.y + hF.y) / 2 };
          ctx.save();
          ctx.translate(mid.x, mid.y);
          ctx.rotate(foreF);
          ctx.fillStyle = '#8B5E3C';
          ctx.fillRect(-9 * k, -3.4 * k, 18 * k, 6.8 * k);
          ctx.fillStyle = trim;
          ctx.fillRect(-9 * k, -3.4 * k, 4 * k, 6.8 * k);
          ctx.strokeStyle = '#C9A227';
          ctx.lineWidth = 1.4 * k;
          ctx.beginPath();
          ctx.moveTo(-5 * k, 0);
          ctx.lineTo(5 * k, 0);
          ctx.stroke();
          ctx.restore();
          // 大拳：方形机械拳
          ctx.fillStyle = '#8B5E3C';
          ctx.fillRect(hF.x - 3.4 * k, hF.y - 3.4 * k, 6.8 * k, 6.8 * k);
          ctx.strokeStyle = '#C9A227';
          ctx.lineWidth = 1.2 * k;
          ctx.strokeRect(hF.x - 3.4 * k, hF.y - 3.4 * k, 6.8 * k, 6.8 * k);
        }
      });

      /* --- 布片动态件（L2 半刚性，只做短幅） --- */
      if (cloth && !Number.isNaN(cloth.x) && spec.cloth) {
        const anchor = spec.cloth === 'apron' ? hipB : spec.cloth === 'hoodTail' ? head : spec.cloth === 'shoulderCape' ? shF : shB;
        ctx.fillStyle = spec.cloth === 'apron' ? '#8B5E3C' : trim;
        if (spec.cloth === 'cape2') {
          // 盾卫：两片式短披风，中间开缝
          for (const s of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(anchor.x + s * 3 * k, anchor.y - 2 * k);
            ctx.quadraticCurveTo(anchor.x + s * 6 * k, (anchor.y + cloth.y) / 2 + 3 * k, cloth.x + s * 3.5 * k, cloth.y);
            ctx.lineTo(cloth.x - s * 1.5 * k, cloth.y - 1 * k);
            ctx.closePath();
            ctx.fill();
          }
        } else if (spec.cloth === 'apron') {
          // 矮人皮围裙：分片，从腰垂到大腿
          ctx.beginPath();
          ctx.moveTo(anchor.x - 5 * k, anchor.y);
          ctx.lineTo(anchor.x + 5 * k, anchor.y);
          ctx.lineTo(cloth.x + 6 * k, cloth.y + 3 * k);
          ctx.lineTo(cloth.x - 6 * k, cloth.y + 3 * k);
          ctx.closePath();
          ctx.fill();
        } else if (spec.cloth === 'hoodTail') {
          // 刺客兜帽短尾（不做长飘带）
          ctx.beginPath();
          ctx.moveTo(anchor.x - facing * 2 * k, anchor.y + 2 * k);
          ctx.quadraticCurveTo(anchor.x - facing * 7 * k, anchor.y + 7 * k, cloth.x, cloth.y);
          ctx.lineTo(anchor.x + facing * 1 * k, anchor.y + 5 * k);
          ctx.closePath();
          ctx.fill();
        } else if (spec.cloth === 'shoulderCape') {
          // 弩手单侧短披风
          ctx.beginPath();
          ctx.moveTo(anchor.x, anchor.y - 1 * k);
          ctx.quadraticCurveTo(anchor.x - facing * 8 * k, anchor.y + 6 * k, cloth.x, cloth.y);
          ctx.lineTo(anchor.x + facing * 3 * k, anchor.y + 4 * k);
          ctx.closePath();
          ctx.fill();
        } else if (spec.cloth === 'haori') {
          // 羽织：肩到腰的短外褂，左右两片
          for (const s of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(anchor.x + s * 6 * k, anchor.y);
            ctx.quadraticCurveTo(anchor.x + s * 9 * k, (anchor.y + cloth.y) / 2, cloth.x + s * 7 * k, cloth.y);
            ctx.lineTo(anchor.x + s * 2 * k, anchor.y + 5 * k);
            ctx.closePath();
            ctx.fill();
          }
        } else if (spec.cloth === 'kilt') {
          // 腰后兽皮尾（战裙已在下装层画过，这里是后摆）
          ctx.beginPath();
          ctx.moveTo(anchor.x - facing * 4 * k, anchor.y);
          ctx.lineTo(anchor.x + facing * 2 * k, anchor.y);
          ctx.lineTo(cloth.x, cloth.y);
          ctx.closePath();
          ctx.fill();
        } else if (spec.cloth === 'coat') {
          // 背后工具披布（机关师）：方片 + 兜袋
          ctx.beginPath();
          ctx.moveTo(anchor.x - 6 * k, anchor.y);
          ctx.lineTo(anchor.x + 6 * k, anchor.y);
          ctx.lineTo(cloth.x + 5 * k, cloth.y + 2 * k);
          ctx.lineTo(cloth.x - 5 * k, cloth.y + 2 * k);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = trim;
          ctx.lineWidth = 1.2 * k;
          ctx.strokeRect(cloth.x - 3.5 * k, cloth.y - 3 * k, 7 * k, 4 * k);
        } else {
          // sash：斜袈裟单片
          ctx.beginPath();
          ctx.moveTo(anchor.x, anchor.y);
          ctx.quadraticCurveTo(anchor.x - facing * 5 * k, (anchor.y + cloth.y) / 2, cloth.x, cloth.y);
          ctx.lineTo(anchor.x + facing * 2 * k, anchor.y + 4 * k);
          ctx.closePath();
          ctx.fill();
        }
      }

      /* --- 挂件动态件（L3 柔性短挂件） --- */
      if (trinket && !Number.isNaN(trinket.x) && spec.trinket) {
        if (spec.trinket === 'beads') {
          // 武僧念珠：短串，从胸口垂到挂件末端
          const a = chest;
          for (let i = 1; i <= 5; i++) {
            const t = i / 5;
            const bx = a.x + (trinket.x - a.x) * t + Math.sin(t * 3) * 1.2 * k;
            const by = a.y + (trinket.y - a.y) * t;
            disc({ x: bx, y: by, z: 0 }, 1.7 * k, '#C9A227');
          }
        } else if (spec.trinket === 'ammo') {
          // 弩手弹药带：短串方块
          const a = chest;
          for (let i = 1; i <= 4; i++) {
            const t = i / 4;
            ctx.fillStyle = '#8B5E3C';
            ctx.fillRect(a.x + (trinket.x - a.x) * t - 1.6 * k, a.y + (trinket.y - a.y) * t - 1.6 * k, 3.2 * k, 3.2 * k);
          }
        } else if (spec.trinket === 'braid') {
          // 矮人胡子：短幅摆动，不遮住受击点（胸腹）
          ctx.fillStyle = trim;
          ctx.beginPath();
          ctx.moveTo(head.x - 3 * k, head.y + L.headR * 0.5 * k);
          ctx.lineTo(head.x + 3 * k, head.y + L.headR * 0.5 * k);
          ctx.quadraticCurveTo(trinket.x + 3 * k, trinket.y, trinket.x, trinket.y + 4 * k);
          ctx.quadraticCurveTo(trinket.x - 3 * k, trinket.y, head.x - 3 * k, head.y + L.headR * 0.5 * k);
          ctx.closePath();
          ctx.fill();
        } else if (spec.trinket === 'gourd') {
          // 酒葫芦：钟摆物理挂腰侧，两圆叠成葫芦形 + 系绳
          const a = { x: bcx, y: bcy };
          ctx.strokeStyle = '#8B5E3C';
          ctx.lineWidth = 1.4 * k;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(trinket.x, trinket.y - 5 * k);
          ctx.stroke();
          disc({ x: trinket.x, y: trinket.y - 3 * k, z: 0 }, 2.2 * k, '#B08D5A');
          disc({ x: trinket.x, y: trinket.y + 1.5 * k, z: 0 }, 3.0 * k, '#B08D5A');
          ctx.strokeStyle = '#8B5E3C';
          ctx.lineWidth = 1.0 * k;
          ctx.beginPath();
          ctx.moveTo(trinket.x - 3 * k, trinket.y + 1.5 * k);
          ctx.lineTo(trinket.x + 3 * k, trinket.y + 1.5 * k);
          ctx.stroke();
        } else if (spec.trinket === 'tassel') {
          // 腰带尾 / 枪缨的通用短流苏
          ctx.strokeStyle = '#C9A227';
          ctx.lineWidth = 2.0 * k;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(bcx, bcy);
          ctx.quadraticCurveTo((bcx + trinket.x) / 2, (bcy + trinket.y) / 2 + 2 * k, trinket.x, trinket.y);
          ctx.stroke();
        }
      }
    }
    drawLeg(backLegIsFarther ? 'F' : 'B', body);
    drawArm(backArmIsFarther ? 'F' : 'B', body);
    // 刚性武器（盾/锤/枪/弩）最后画，压在近侧手臂之上
    for (const fn of after) fn();
  };


  const drawFighter = (f: Fighter) => {
    const flashing = f.flash > 0.25;
    const body = flashing ? '#FFFFFF' : f.skin.body;
    const trim = flashing ? '#F4F4F4' : f.skin.trim;
    const dark = flashing ? '#E8E8E8' : f.skin.dark;
    const expr: 'normal' | 'hurt' | 'down' =
      f.state === 'down' ? 'down' : f.state === 'hurtLight' || f.state === 'hurtHeavy' || flashing ? 'hurt' : 'normal';

    // 体型：战士更宽（宽度放大），游侠更瘦
    const bulk = GEAR_SPEC[f.build].bulk;
    const yaw = f.pose.yaw || 0;
    const faceCam = -Math.sin(yaw);
    // 脸画在哪一侧：由「身体朝向 × 头自己转的角度」共同决定
    // （后旋踢背对时头回头看对手，脸要朝向对手一侧）
    const headAng = (f.pose.lean || 0) + (f.pose.head || 0);
    const side = Math.sin(headAng) * Math.cos(yaw) >= 0 ? f.facing : -f.facing;
    const torsoScale = 0.55 + 0.45 * Math.abs(Math.cos(yaw));
    const sh = Math.max(0.4, 1 - f.pose.lift / 40);
    // 登场动画：从上方落下（quadratic 快落）
    const enterDrop = f.enterT > 0 ? -70 * f.scale * Math.pow(Math.min(1, f.enterT / f.enterDur), 2) : 0;

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
    if (f.enterT > 0) ctx.translate(0, enterDrop);

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
        torsoScale,
        f.sway,
        null,
        null
      );
    } else {
      const { world } = place(f);
      drawFigure((key) => world[key as keyof Joints], f.scale * bulk, body, trim, dark, expr, f.facing, faceCam, f.build, side, torsoScale, f.sway, f.cloth, f.trinket);
    }
    ctx.restore();
    ctx.restore();

    // 登场姓名：艺术字体 + 小变大震撼（easeOutBack 回弹 + 金色光晕）
    if (f.enterT > 0) {
      const p = Math.max(0, Math.min(1, 1 - f.enterT / f.enterDur));
      const sc = Math.max(0.1, easeOutBack(p));
      const ny = groundY() - 62 * f.scale + enterDrop;
      const na = Math.min(1, p * 2.4);
      ctx.save();
      ctx.globalAlpha = na;
      ctx.translate(f.x, ny);
      ctx.scale(sc, sc);
      ctx.font = `bold ${30 * f.scale}px 'STXingkai','Xingkai SC','KaiTi','STKaiti','FangSong','Microsoft YaHei',serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(f.name).width;
      const bw = tw / 2 + 16;
      // 暗底牌 + 金色边框 + 光晕
      ctx.shadowColor = 'rgba(255,190,60,0.9)';
      ctx.shadowBlur = 20;
      ctx.fillStyle = 'rgba(18,10,4,0.82)';
      ctx.fillRect(-bw, -19, bw * 2, 38);
      ctx.strokeStyle = 'rgba(255,205,100,0.95)';
      ctx.lineWidth = 1.8;
      ctx.strokeRect(-bw, -19, bw * 2, 38);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#FFE9B8';
      ctx.fillText(f.name, 0, 1);
      ctx.restore();
    } else if (opts.showNames) {
      // 持续小号姓名（设定模式）
      const ny = groundY() - 54 * f.scale;
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.font = `bold ${11 * f.scale}px 'STXingkai','KaiTi','STKaiti','Microsoft YaHei',serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(f.name).width;
      ctx.fillStyle = 'rgba(20,16,12,0.72)';
      ctx.fillRect(f.x - tw / 2 - 6, ny - 7, tw + 12, 14);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(f.name, f.x, ny);
      ctx.restore();
    }

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

    // zoom punch：重击瞬间整画面微微推近
    if (zoom > 0.002) {
      const cz = 1 + zoom;
      ctx.translate(W / 2, H / 2);
      ctx.scale(cz, cz);
      ctx.translate(-W / 2, -H / 2);
    }
    // 定向震屏：画面整体沿打击方向偏移（像挨了一下），再叠少量随机抖避免太机械
    if (Math.abs(shakeDir) > 0.05) ctx.translate(shakeDir * 1.5, shakeDir * 0.3);
    if (shake > 0.15) ctx.translate(rand(-shake, shake) * 0.35, rand(-shake, shake) * 0.28);

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

    // 投射物：弩箭（杆+箭头）与飞镖（旋转星）
    for (const p of projectiles) {
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.kind === 'bolt') {
        ctx.rotate(Math.atan2(p.vy, p.vx));
        ctx.strokeStyle = '#8B5E3C';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-9, 0);
        ctx.lineTo(5, 0);
        ctx.stroke();
        ctx.fillStyle = '#E8EEF7';
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.lineTo(0, -2.5);
        ctx.lineTo(0, 2.5);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.rotate(p.life * 18);
        ctx.fillStyle = '#C9A227';
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU;
          const rr = i % 2 === 0 ? 5 : 2;
          const px = Math.cos(a) * rr;
          const py = Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // 打击线（speed line）：短线沿放射方向被拉走并淡出，速度感来自这里
    for (const l of speedLines) {
      const k = l.life / l.max;
      ctx.globalAlpha = Math.max(0, 1 - k) * 0.9;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.w;
      ctx.lineCap = 'round';
      const cx = l.x + Math.cos(l.a) * l.len * k * 0.55;
      const cy = l.y + Math.sin(l.a) * l.len * k * 0.55;
      const hx = Math.cos(l.a) * l.len * 0.5;
      const hy = Math.sin(l.a) * l.len * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx - hx, cy - hy);
      ctx.lineTo(cx + hx, cy + hy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 冲击环：椭圆环快速扩散并变细
    for (const r of impactRings) {
      const k = Math.min(1, r.life / r.max);
      const rad = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 3));
      ctx.globalAlpha = Math.max(0, 1 - k) * 0.85;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(0.4, r.wide * (1 - k * 0.65));
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, rad, rad * 0.74, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 伤害飘字（-XX）
    for (const p of popups) {
      const k = 1 - p.life / p.max;
      ctx.globalAlpha = Math.max(0, 1 - k * k);
      ctx.font = `bold ${13 + (1 - k) * 4}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

    // 演示模式：顶部显示当前招式名与序号
    if (opts.demo && opts.hud !== false) {
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
    const want = opts.demo || opts.matchup ? 2 : W < 620 ? 2 : 4;
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
    if (reduceMotion || (!visible && !opts.forceVisible) || !tabVisible) return;
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
        guard: Math.round(f.guard),
        guardBreak: Number(f.guardBreak.toFixed(2)),
      })),
    /** 结束外部控制，回到本地 AI */
    reset: () => setController(null),
    /** 停止引擎（重新开打前调用） */
    destroy: () => {
      cancelAnimationFrame(rafId);
      fighters = [];
      sparks = [];
      popups = [];
      impactRings = [];
      speedLines = [];
      projectiles = [];
      shake = 0;
      shakeDir = 0;
      zoom = 0;
    },
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
      /** 定格到当前招式的某个进度（0~1），供逐帧检查 / 截图 */
      seek: (frac: number) => {
        demoPaused = true;
        const a = fighters[0];
        if (!a) return;
        const clip = CLIPS[a.state] ?? CLIPS.idle;
        const t = Math.max(0, Math.min(0.999, frac));
        a.clipT = clip.dur * t;
        a.pose = sampleClip(clip, t);
      },
      /** 切换演示位角色（ROSTER 索引），用于逐个检查剪影与动态件 */
      who: (i: number) => {
        const a = fighters[0];
        if (!a) return null;
        const r = ROSTER[((i % ROSTER.length) + ROSTER.length) % ROSTER.length];
        applyRoster(a, r);
        a.enterT = 0; // 检查模式跳过登场动画，姓名牌不遮头
        return r.name;
      },
      /** 当前 roster（名字 + 流派），便于外部列出 */
      roster: () => ROSTER.map((r, i) => ({ i, name: r.name, build: r.build })),
      /** 定格状态下手动触发一次当前招式的命中特效（配合 seek 检查特效用） */
      fx: () => {
        const a = fighters[0];
        const b = fighters[1];
        if (!a) return;
        const atk = ATTACKS[a.state];
        const key = atk ? a.state : 'jab';
        // 命中点直接用打击部位的真实坐标，再往对手方向探出一点
        const w = place(a).world;
        const part = w[atk?.part ?? 'handF'];
        burstFx(key, part.x + a.facing * 10, part.y, a.facing, false, 0.45);
        if (b) {
          b.flash = 1;
          b.sway = 0.6;
        }
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
