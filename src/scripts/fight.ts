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

import { FsmProcess, FsmStateConfig, STATE_ANY, STATE_INITIAL } from '@statewalker/fsm';

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
/* 拳击手被打踉跄：下巴先仰、上身后甩 → 后脚找地、手飘起来 → 重心快丢了才倒 */
const STAGGER_A = P({ lean: -0.42, head: -0.7, armUB: -0.9, armLB: 1.0, armUF: -0.8, armLF: 1.3, legUB: -0.62, legLB: 0.1, legUF: 0.5, legLF: 0.3 });
const STAGGER_B = P({ lean: -0.58, head: -0.55, armUB: -1.2, armLB: 0.7, armUF: -1.1, armLF: 0.9, legUB: -0.95, legLB: -0.25, legUF: 0.72, legLF: 0.1, yaw: 0.22 });
const STAGGER_C = P({ lean: -0.34, head: -0.2, armUB: -0.5, armLB: 1.5, armUF: -0.3, armLF: 1.6, legUB: -0.3, legLB: -0.5, legUF: 0.3, legLF: -0.2, yaw: -0.12 });
/* 倒地→起身：仰卧 → 撑地坐起 → 单膝跪地 → 站起（以前直接从跪姿开始，跟躺地的身体接不上） */
const LIE_BACK = P({ lean: 1.42, head: 0.3, armUB: 1.3, armLB: 0.3, armUF: 1.2, armLF: 0.2, legUB: 1.35, legLB: 0.15, legUF: 1.45, legLF: 0.1 });
const GETUP_SIT = P({ lean: 0.95, head: -0.15, armUB: 1.5, armLB: 0.6, armUF: 1.4, armLF: 0.5, legUB: 1.3, legLB: -0.9, legUF: 1.2, legLF: -1.2 });
const GETUP_RISE = P({ lean: 0.42, head: -0.1, armUB: 0.5, armLB: 1.5, armUF: 0.7, armLF: 1.3, legUB: 0.9, legLB: -1.5, legUF: 0.7, legLF: -1.5 });
/* 蹲下 / 团身翻滚 / 低血喘息 / 腿部受击 */
const CROUCH = P({ lean: 0.52, head: -0.12, armUB: 0.75, armLB: 1.95, armUF: 0.8, armLF: 1.85, legUB: 0.95, legLB: -1.55, legUF: 0.9, legLF: -1.7 });
const ROLL_TUCK = P({ lean: 0.95, head: 0.45, armUB: 0.65, armLB: 2.35, armUF: 0.6, armLF: 2.3, legUB: 1.25, legLB: -1.95, legUF: 1.15, legLF: -2.0 });
const TIRED_A = P({ lean: 0.44, head: -0.34, armUB: 0.5, armLB: 1.2, armUF: 0.55, armLF: 1.1, legUB: 0.4, legLB: -0.7, legUF: 0.35, legLF: -0.6 });
const TIRED_B = P({ lean: 0.52, head: -0.42, armUB: 0.42, armLB: 1.05, armUF: 0.48, armLF: 0.95, legUB: 0.46, legLB: -0.8, legUF: 0.4, legLF: -0.7 });
const HURT_LEG = P({ lean: 0.4, head: -0.2, armUB: 0.4, armLB: 1.5, armUF: 0.5, armLF: 1.4, legUB: 0.8, legLB: -1.2, legUF: 0.25, legLF: -0.4 });
const GETUP_KNEEL = P({ lean: 0.55, head: 0.15, armUB: 0.7, armLB: 1.4, armUF: 0.9, armLF: 1.2, legUB: 1.5, legLB: -2.4, legUF: 0.35, legLF: -1.5 });
/* 新增三招：膝击（提膝顶撞）/ 投技（抓住抡出去，克蹲防）/ 反击（侧让后反打） */
const KNEE_WIND = P({ lean: -0.14, head: -0.04, armUB: 0.8, armLB: 1.7, armUF: 0.9, armLF: 1.5, legUB: 0.1, legLB: 0, legUF: 1.35, legLF: -2.1 });
const KNEE_HIT = P({ lean: 0.34, head: 0.02, armUB: 1.0, armLB: 1.9, armUF: 1.0, armLF: 1.8, legUB: -0.3, legLB: 0, legUF: 1.5, legLF: -2.3 });
const THROW_GRAB = P({ lean: 0.42, head: 0.05, armUB: 1.0, armLB: 1.1, armUF: 1.3, armLF: 1.0, legUB: 0.3, legLB: -0.5, legUF: 0.4, legLF: -0.5 });
const THROW_TOSS = P({ lean: -0.4, head: -0.2, armUB: -0.9, armLB: 0.6, armUF: -1.0, armLF: 0.5, legUB: -0.4, legLB: 0.1, legUF: 0.3, legLF: 0.1, yaw: -0.5 });
const COUNTER_WIND = P({ lean: -0.3, head: -0.1, armUB: 0.6, armLB: 2.0, armUF: 0.4, armLF: 1.9, legUB: -0.3, legLB: 0.1, legUF: 0.4, legLF: 0.1, yaw: 0.55 });
const COUNTER_HIT = P({ lean: 0.4, head: 0.05, armUB: 0.8, armLB: 1.9, armUF: 1.7, armLF: 0.0, legUB: -0.44, legLB: 0, legUF: 0.52, legLF: 0.04, yaw: -0.2 });

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
  // 举盾要能撑住（原来 0.16s 一闪而过，根本挡不到东西）；由 blockT 时限负责放下
  block: { dur: 0.7, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.22, pose: BLOCK }, { t: 1, pose: BLOCK }] },

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
  stumble: { dur: 0.52, loop: false, keys: [{ t: 0, pose: STAGGER_A }, { t: 0.3, pose: STAGGER_B }, { t: 0.62, pose: STAGGER_C }, { t: 0.85, pose: STUMBLE }, { t: 1, pose: GUARD }] },
  getup: { dur: 1.05, loop: false, keys: [{ t: 0, pose: LIE_BACK }, { t: 0.26, pose: GETUP_SIT }, { t: 0.52, pose: GETUP_KNEEL }, { t: 0.8, pose: GETUP_RISE }, { t: 1, pose: IDLE_A }] },
  hurtLeg: { dur: 0.36, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.26, pose: HURT_LEG }, { t: 1, pose: GUARD }] },
  crouch: { dur: 0.9, loop: true, keys: [{ t: 0, pose: CROUCH }, { t: 0.5, pose: P({ ...CROUCH, lean: 0.56 }) }, { t: 1, pose: CROUCH }] },
  roll: { dur: 0.46, loop: false, keys: [{ t: 0, pose: CROUCH }, { t: 0.22, pose: ROLL_TUCK }, { t: 0.68, pose: ROLL_TUCK }, { t: 0.9, pose: CROUCH }, { t: 1, pose: GUARD }] },
  tired: { dur: 1.4, loop: true, keys: [{ t: 0, pose: TIRED_A }, { t: 0.5, pose: TIRED_B }, { t: 1, pose: TIRED_A }] },
  knee: { dur: 0.5, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.24, pose: KNEE_WIND }, { t: 0.42, pose: KNEE_HIT }, { t: 0.58, pose: KNEE_HIT }, { t: 1, pose: GUARD }] },
  throw: { dur: 0.8, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.3, pose: THROW_GRAB }, { t: 0.55, pose: THROW_TOSS }, { t: 0.72, pose: THROW_TOSS }, { t: 1, pose: GUARD }] },
  counterStrike: { dur: 0.44, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.2, pose: COUNTER_WIND }, { t: 0.4, pose: COUNTER_HIT }, { t: 0.56, pose: COUNTER_HIT }, { t: 1, pose: GUARD }] },
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
  swordsman: { silhouette: 'sword', cloth: 'sash', trinket: 'tassel', bulk: 1.05, weaponInHand: false, outfit: { torso: 'kimono', pauldron: 'single', sleeve: 'wide', leg: 'hakama' }, behavior: 'punisher', moves: ['iai', 'counterStrike'] },
  ranger: { silhouette: 'bow', cloth: 'hoodTail', trinket: null, bulk: 0.86, weaponInHand: true, outfit: { torso: 'leather', pauldron: 'none', sleeve: 'rolled', leg: 'pants' }, behavior: 'zoner', moves: ['bolt'] },
  shield: { silhouette: 'shield', cloth: 'cape2', trinket: null, bulk: 1.12, weaponInHand: true, outfit: { torso: 'armor', pauldron: 'double', sleeve: 'metal', leg: 'armored' }, behavior: 'turtle', moves: ['bash'] },
  spear: { silhouette: 'spear', cloth: null, trinket: 'tassel', bulk: 0.95, weaponInHand: true, outfit: { torso: 'hauberk', pauldron: 'single', sleeve: 'tight', leg: 'armored' }, behavior: 'zoner', moves: ['thrust'] },
  dagger: { silhouette: 'twinDagger', cloth: 'hoodTail', trinket: null, bulk: 0.88, weaponInHand: true, outfit: { torso: 'shirt', pauldron: 'none', sleeve: 'tight', leg: 'pants' }, behavior: 'rusher', moves: ['slash', 'knee'] },
  monk: { silhouette: 'beads', cloth: 'sash', trinket: 'beads', bulk: 0.98, weaponInHand: false, outfit: { torso: 'robe', pauldron: 'none', sleeve: 'bandage', leg: 'wrapped' }, behavior: 'brawler', moves: ['palm', 'knee'] },
  hammer: { silhouette: 'hammer', cloth: 'apron', trinket: 'braid', bulk: 1.18, weaponInHand: true, outfit: { torso: 'leather', pauldron: 'double', sleeve: 'rolled', leg: 'skirt' }, behavior: 'punisher', moves: ['smash'] },
  gunner: { silhouette: 'crossbow', cloth: 'shoulderCape', trinket: 'ammo', bulk: 0.92, weaponInHand: true, outfit: { torso: 'coat', pauldron: 'single', sleeve: 'tight', leg: 'pants' }, behavior: 'zoner', moves: ['bolt'] },
  ninja: { silhouette: 'shuriken', cloth: 'hoodTail', trinket: null, bulk: 0.9, weaponInHand: true, outfit: { torso: 'shirt', pauldron: 'none', sleeve: 'bandage', leg: 'wrapped' }, behavior: 'trickster', moves: ['shuriken'] },
  drunk: { silhouette: 'gourd', cloth: 'sash', trinket: 'gourd', bulk: 1.02, weaponInHand: false, outfit: { torso: 'robe', pauldron: 'none', sleeve: 'rolled', leg: 'pants' }, behavior: 'trickster', moves: ['palm', 'elbow', 'throw'] },
  viking: { silhouette: 'axe', cloth: 'kilt', trinket: 'braid', bulk: 1.15, weaponInHand: true, outfit: { torso: 'leather', pauldron: 'fur', sleeve: 'rolled', leg: 'kilt' }, behavior: 'rusher', moves: ['swing', 'throw'] },
  samurai: { silhouette: 'katana', cloth: 'haori', trinket: 'tassel', bulk: 1.0, weaponInHand: true, outfit: { torso: 'armor', pauldron: 'spiked', sleeve: 'wide', leg: 'hakama' }, behavior: 'punisher', moves: ['iai', 'counterStrike'] },
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

/* ============================================================
 * 物理增强模块：KawaiiPhysics / Two-Bone IK / PD Controller
 * ============================================================ */

/** KawaiiPhysics 弹簧阻尼参数（灵感来自 UE4/Unity 同名插件） */
interface SpringParams {
  /** 弹簧刚度：值越大回弹越快/越硬（推荐 5~30） */
  stiffness: number;
  /** 阻尼系数：值越大摆动衰减越快（推荐 0.3~1.2） */
  damping: number;
  /** 重力加速度（像素/秒²，向下为正） */
  gravity: number;
  /** 最大摆动长度（像素） */
  maxLength: number;
  /** 角度阻力：模拟空气阻力对角速度的衰减（0~1，1=无阻力） */
  drag: number;
}

/** 增强型动态件：支持 KawaiiPhysics 弹簧-阻尼-重力模型 */
interface EnhancedDangle extends Dangle {
  /** 当前角速度（弧度/秒），用于弹簧-阻尼积分 */
  angVel: number;
  /** 当前角度（弧度），相对锚点的下垂偏角 */
  angle: number;
  /** 弹簧参数配置 */
  spring: SpringParams;
  /** 是否启用 KawaiiPhysics 模式（false = 回退到 Verlet） */
  useKawaii: boolean;
}

/** PD 控制器状态：用于程序化受击反应 */
interface PDController {
  /** 是否激活（进入受击状态时激活） */
  active: boolean;
  /** 目标姿态（要趋近的反应姿势） */
  target: Pose | null;
  /** 当前姿态的速度（每个关节的角速度） */
  velocity: Pose;
  /** 比例增益：误差响应强度（推荐 15~60） */
  kp: number;
  /** 微分增益：阻尼/速度抵抗（推荐 3~15） */
  kd: number;
  /** 剩余持续时间（秒），<=0 时自动停用 */
  duration: number;
  /** 总持续时间（用于计算衰减混合） */
  totalDuration: number;
  /** 混合权重（0→1→0，用于平滑进出） */
  blend: number;
}

/** Two-Bone IK 结果 */
interface IKResult {
  /** 第一段关节角度（如大腿/上臂相对于根的角度） */
  angle1: number;
  /** 第二段关节角度（如小腿/前臂相对于第一段的夹角） */
  angle2: number;
  /** 是否可达（目标太远时为 false） */
  reachable: boolean;
}

/**
 * KawaiiPhysics 单步积分：弹簧-阻尼-重力钟摆模型
 *
 * 相比 Verlet 积分的优势：
 * - 参数物理意义明确（刚度/阻尼/重力可独立调节）
 * - 天然支持「过冲+回弹」效果（Q弹感）
 * - 角度空间积分，不受坐标系缩放影响
 * - 阻尼独立于刚度，可以做出"重而慢"或"轻而飘"的不同质感
 *
 * @param d 增强型动态件
 * @param dt 时间步长（秒）
 */
const stepKawaiiPhysics = (d: EnhancedDangle, dt: number): void => {
  if (!d.useKawaii) return;

  // 初始化 NaN 状态
  if (Number.isNaN(d.x)) {
    d.angle = 0;
    d.angVel = 0;
    return;
  }

  const { stiffness, damping, gravity, maxLength, drag } = d.spring;

  // 弹簧力：角度偏差 × 刚度（自然下垂角度 = π/2，即垂直向下）
  const restAngle = Math.PI / 2;
  const springTorque = -stiffness * (d.angle - restAngle);

  // 重力力矩：g × L × sin(θ)，简化为 gravity * sin(angle)
  const gravityTorque = gravity * Math.sin(d.angle);

  // 阻尼力矩：-damping × angularVelocity
  const dampingTorque = -damping * d.angVel;

  // 总力矩 → 角加速度（假设单位转动惯量）
  const angAccel = springTorque + gravityTorque + dampingTorque;

  // 半隐式欧拉积分（比显式欧拉更稳定）
  d.angVel += angAccel * dt;
  d.angVel *= drag; // 空气阻力
  d.angle += d.angVel * dt;

  // 转换回笛卡尔坐标（锚点在原点，y 向下为正）
  d.x = Math.sin(d.angle) * maxLength;
  d.y = Math.cos(d.angle) * maxLength;

  // 保存上一帧位置（用于渲染拖尾等）
  d.px = d.x;
  d.py = d.y;
};

/**
 * Two-Bone IK 解析解：用余弦定理求两段肢体到达目标点的关节角
 *
 * 应用场景：
 * - 脚部 IK：蹲下时保持脚掌贴地（不穿透地面）
 * - 手部 IK：格挡/抓取时手准确到达目标位置
 *
 * 数学推导：
 *   设 root→target 距离为 D，两段长度 len1, len2
 *   由余弦定理：cos(elbow) = (len1² + len2² - D²) / (2·len1·len2)
 *   shoulder角 = atan2(target) ± acos((len1² + D² - len2²) / (2·len1·D))
 *
 * @param root 根关节位置（如髋/肩）
 * @param target 目标位置（如地面点/抓取点）
 * @param len1 第一段长度（大腿/上臂）
 * @param len2 第二段长度（小腿/前臂）
 * @param bendDir 弯曲方向偏好（正=向外弯，负=向内弯，0=取较短路径）
 * @returns IK 求解结果
 */
const twoBoneIK = (
  root: Pt,
  target: Pt,
  len1: number,
  len2: number,
  bendDir: number = 1
): IKResult => {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const dist = Math.hypot(dx, dy);

  // 目标太远：伸直指向目标
  if (dist >= len1 + len2 - 0.001) {
    const angle = Math.atan2(dy, dx);
    return { angle1: angle, angle2: 0, reachable: false };
  }

  // 目标太近：折叠起来
  if (dist <= Math.abs(len1 - len2) + 0.001) {
    const angle = Math.atan2(dy, dx);
    const foldAngle = len1 > len2 ? 0 : Math.PI;
    return { angle1: angle, angle2: foldAngle, reachable: false };
  }

  // 余弦定理求肘关节夹角
  const cosElbow = (len1 * len1 + len2 * len2 - dist * dist) / (2 * len1 * len2);
  const clampedCos = Math.max(-1, Math.min(1, cosElbow));
  const elbowAngle = Math.acos(clampedCos);

  // 求肩/髋关节角
  const cosShoulder = (len1 * len1 + dist * dist - len2 * len2) / (2 * len1 * dist);
  const clampedCosS = Math.max(-1, Math.min(1, cosShoulder));
  const shoulderOffset = Math.acos(clampedCosS);
  const baseAngle = Math.atan2(dy, dx);

  // bendDir 决定肘部弯向哪边
  const angle1 = baseAngle + shoulderOffset * bendDir;
  const angle2 = Math.PI - elbowAngle; // 内角

  return { angle1, angle2, reachable: true };
};

/**
 * PD 控制器更新：生成程序化受击反应的姿态修正量
 *
 * PD 控制律：torque = Kp × (target - current) + Kd × (0 - velocity)
 * - P 项：把当前姿态拉向目标姿态
 * - D 项：阻尼振荡，防止过冲
 *
 * 相比关键帧插值的优势：
 * - 反应幅度随打击力度连续变化（不是离散的几套动画）
 * - 可以叠加多次受击（连招时反应自然累积）
 * - 物理上正确的"被打后弹回来"行为
 *
 * @param pd PD 控制器状态
 * @param current 当前姿态
 * @param dt 时间步长（秒）
 * @returns 修正后的姿态（需要与原始姿态混合使用）
 */
const updatePDReaction = (pd: PDController, current: Pose, dt: number): Pose => {
  if (!pd.active || !pd.target) return current;

  // 更新剩余时间
  pd.duration -= dt;

  // 计算混合权重：淡入→保持→淡出
  const t = 1 - pd.duration / pd.totalDuration;
  if (t < 0.1) {
    pd.blend = t / 0.1; // 淡入
  } else if (t > 0.8) {
    pd.blend = (1 - t) / 0.2; // 淡出
  } else {
    pd.blend = 1; // 保持
  }

  // 时间到了就停用
  if (pd.duration <= 0) {
    pd.active = false;
    pd.blend = 0;
    return current;
  }

  // 对每个关节应用 PD 控制律
  const pdJoint = (cur: number, tgt: number, vel: number): [number, number] => {
    const error = tgt - cur;
    const torque = pd.kp * error - pd.kd * vel;
    const newVel = vel + torque * dt;
    const newPos = cur + newVel * dt;
    return [newPos, newVel];
  };

  const [lean, v0] = pdJoint(current.lean, pd.target.lean, pd.velocity.lean);
  const [head, v1] = pdJoint(current.head, pd.target.head, pd.velocity.head);
  const [armUB, v2] = pdJoint(current.armUB, pd.target.armUB, pd.velocity.armUB);
  const [armLB, v3] = pdJoint(current.armLB, pd.target.armLB, pd.velocity.armLB);
  const [armUF, v4] = pdJoint(current.armUF, pd.target.armUF, pd.velocity.armUF);
  const [armLF, v5] = pdJoint(current.armLF, pd.target.armLF, pd.velocity.armLF);
  const [legUB, v6] = pdJoint(current.legUB, pd.target.legUB, pd.velocity.legUB);
  const [legLB, v7] = pdJoint(current.legLB, pd.target.legLB, pd.velocity.legLB);
  const [legUF, v8] = pdJoint(current.legUF, pd.target.legUF, pd.velocity.legUF);
  const [legLF, v9] = pdJoint(current.legLF, pd.target.legLF, pd.velocity.legLF);

  // 更新速度状态
  pd.velocity = {
    lean: v0, head: v1, armUB: v2, armLB: v3, armUF: v4, armLF: v5,
    legUB: v6, legLB: v7, legUF: v8, legLF: v9,
    lift: 0, spin: 0, yaw: 0,
    armUBD: 0, armUFD: 0, armLBD: 0, armLFD: 0,
    legUBD: 0, legUFD: 0, legLBD: 0, legLFD: 0,
  };

  const result: Pose = {
    lean, head, armUB, armLB, armUF, armLF, legUB, legLB, legUF, legLF,
    lift: current.lift, spin: current.spin, yaw: current.yaw,
    armUBD: current.armUBD, armUFD: current.armUFD,
    armLBD: current.armLBD, armLFD: current.armLFD,
    legUBD: current.legUBD, legUFD: current.legUFD,
    legLBD: current.legLBD, legLFD: current.legLFD,
  };

  // 将 PD 结果与当前姿态按 blend 权重混合
  return lerpPose(current, result, pd.blend);
};

/**
 * PD 受击反应预设配置
 *
 * 四种标准反应类型，每种定义了：
 * - target: 目标反应姿态（最大偏移量）
 * - kp/kd: 控制增益（决定反应的"质感"）
 * - duration: 反应持续时间
 *
 * 使用方式：activatePD(fighter, 'heavy') → 激活重型受击反应
 */
const PD_PRESETS: Record<string, { target: Pose; kp: number; kd: number; duration: number }> = {
  /** 轻击：快速小幅度后仰，快速恢复 */
  light: {
    target: HURT_LIGHT,
    kp: 45,
    kd: 8,
    duration: 0.28,
  },
  /** 重击：大幅度弓身，较慢恢复，有明显过冲-回弹 */
  heavy: {
    target: HURT_HEAVY,
    kp: 28,
    kd: 5,
    duration: 0.48,
  },
  /** 上勾拳/头部受击：猛仰头，中等持续时间 */
  up: {
    target: HURT_UP,
    kp: 35,
    kd: 6,
    duration: 0.45,
  },
  /** 腿部受击：屈膝踉跄，快速但幅度适中 */
  leg: {
    target: HURT_LEG,
    kp: 40,
    kd: 7,
    duration: 0.32,
  },
  /** 倒地/击倒：最大幅度，最长持续，最软的阻尼（像布娃娃一样瘫下去） */
  knockdown: {
    target: STAGGER_B,
    kp: 18,
    kd: 3,
    duration: 0.8,
  },
};

/**
 * 激活 PD 受击反应
 * @param f 目标角色
 * @param presetName 预设名称 ('light' | 'heavy' | 'up' | 'leg' | 'knockdown')
 * @param intensity 强度倍数（0~1，默认 1.0；连击时可累加到 1.5）
 */
const activatePDReaction = (f: Fighter & { pdController?: PDController }, presetName: string, intensity: number = 1.0): void => {
  if (!f.pdController) return;
  const preset = PD_PRESETS[presetName];
  if (!preset) return;

  // 缩放目标姿态强度
  const scaledTarget: Pose = {
    lean: preset.target.lean * intensity,
    head: preset.target.head * intensity,
    armUB: preset.target.armUB * intensity,
    armLB: preset.target.armLB * intensity,
    armUF: preset.target.armUF * intensity,
    armLF: preset.target.armLF * intensity,
    legUB: preset.target.legUB * intensity,
    legLB: preset.target.legLB * intensity,
    legUF: preset.target.legUF * intensity,
    legLF: preset.target.legLF * intensity,
    lift: preset.target.lift,
    spin: preset.target.spin,
    yaw: preset.target.yaw,
    armUBD: preset.target.armUBD * intensity,
    armUFD: preset.target.armUFD * intensity,
    armLBD: preset.target.armLBD * intensity,
    armLFD: preset.target.armLFD * intensity,
    legUBD: preset.target.legUBD * intensity,
    legUFD: preset.target.legUFD * intensity,
    legLBD: preset.target.legLBD * intensity,
    legLFD: preset.target.legLFD * intensity,
  };

  f.pdController.active = true;
  f.pdController.target = scaledTarget;
  f.pdController.kp = preset.kp;
  f.pdController.kd = preset.kd;
  f.pdController.duration = preset.duration;
  f.pdController.totalDuration = preset.duration;
  f.pdController.blend = 0;
  // 继承当前速度（连击时不归零，让反应自然叠加）
};

interface AtkHit {
  at: number;
  dmg: [number, number];
  reach: number;
  /** 不写就用招式的默认部位 */
  part?: StrikePart;
  /** 武器尖端长度（px，沿前臂方向刚性延伸）；-1 = 用链锤甩动球 trinket 做接触点 */
  tip?: number;
}

interface Atk {
  part: StrikePart;
  hits: AtkHit[];
  hitstop: number;
  /** 连招取消点：命中后过了这个片段进度就能直接接下一段（吃掉收招，连招才有连贯感） */
  cancelFrom?: number;
  /** 弹道招式：发射投射物（弩箭/飞镖），命中判定交给投射物而不是接触检测 */
  projectile?: 'bolt' | 'shuriken';
  /** 投技：不可格挡，命中必倒 */
  throw?: boolean;
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
  thrust: { part: 'handF', hits: [{ at: 0.52, dmg: [14, 22], reach: 1.75, knock: 260, tip: 30 }], hitstop: 0.07, react: 'heavy', forward: 130, far: true },
  smash: { part: 'handB', hits: [{ at: 0.56, dmg: [22, 34], reach: 1.25, knock: 480, tip: 22 }], hitstop: 0.15, react: 'heavy', close: true },
  bash: { part: 'handF', hits: [{ at: 0.5, dmg: [12, 19], reach: 1.15, knock: 330, tip: 8 }], hitstop: 0.08, react: 'heavy', close: true, forward: 80 },
  slash: {
    part: 'handF',
    hits: [
      { at: 0.38, dmg: [8, 13], reach: 1.1, knock: 120, tip: 11 },
      { at: 0.56, dmg: [10, 16], reach: 1.1, knock: 200, part: 'handB', tip: 11 },
    ],
    hitstop: 0.05,
    react: 'light',
    close: true,
    forward: 60,
  },
  palm: { part: 'handF', hits: [{ at: 0.4, dmg: [9, 14], reach: 1.15, knock: 200 }], hitstop: 0.04, react: 'light' },
  swing: { part: 'handB', hits: [{ at: 0.54, dmg: [20, 30], reach: 1.35, knock: 380, tip: 20 }], hitstop: 0.12, react: 'heavy' },
  iai: { part: 'handB', hits: [{ at: 0.5, dmg: [26, 38], reach: 1.6, knock: 420, tip: 24 }], hitstop: 0.14, react: 'heavy', far: true, forward: 120 },
  flailSwing: { part: 'handF', hits: [{ at: 0.58, dmg: [18, 28], reach: 1.5, knock: 350, tip: -1 }], hitstop: 0.1, react: 'heavy' },
  gearPunch: { part: 'handF', hits: [{ at: 0.54, dmg: [19, 29], reach: 1.1, knock: 300, tip: 10 }], hitstop: 0.1, react: 'heavy', close: true, forward: 70 },
  bolt: { part: 'handF', hits: [{ at: 0.48, dmg: [13, 20], reach: 1, knock: 220 }], hitstop: 0.05, react: 'light', projectile: 'bolt', far: true },
  knee: { part: 'kneeF', hits: [{ at: 0.42, dmg: [12, 18], reach: 1.1, knock: 260 }], hitstop: 0.07, react: 'heavy', close: true, forward: 60 },
  // 投技：不可格挡（克蹲防），命中必倒
  throw: { part: 'handF', hits: [{ at: 0.55, dmg: [16, 24], reach: 1.0, knock: 220 }], hitstop: 0.12, react: 'up', close: true, throw: true },
  counterStrike: { part: 'handF', hits: [{ at: 0.4, dmg: [14, 22], reach: 1.35, knock: 300 }], hitstop: 0.1, react: 'heavy', forward: 70 },
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
  knee:        { style: 'heavy', ring: 20, wide: 2.8, lines: 8,  len: 22, color: '#FFE1A8', zoom: 0.02, dir: 2.2, sparksN: 10, spread: 0.6 },
  throw:       { style: 'heavy', ring: 26, wide: 3.2, lines: 10, len: 28, color: '#FFC9A0', zoom: 0.04, dir: 2.8, sparksN: 13, spread: 1.1 },
  counterStrike:{ style: 'punch', ring: 22, wide: 2.6, lines: 11, len: 30, color: '#FF9A3C', zoom: 0.03, dir: 2.6, sparksN: 12, spread: 0.4 },
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

/* ============================================================
 * 2.5 MOVE_META 统一招式元数据系统
 *
 * 把分散在 CLIPS / ATTACKS / FX_SPEC 的信息聚合为每招一条记录。
 * 单一真相源，类型安全，易于扩展，支持将来 JSON 外部化。
 * ============================================================ */

/**
 * 统一招式元数据：每个招式一条记录，聚合动画/攻击/特效/行为信息
 */
interface MoveMeta {
  /** 招式标识（也是 CLIPS/ATTACKS/FX_SPEC 的 key） */
  id: string;

  // --- 分类 ---
  category: 'punch' | 'kick' | 'weapon' | 'projectile' | 'throw' | 'special';
  /** 所属装备流派（null = 通用招式，所有流派可用） */
  gearRequired: Gear | null;

  // --- 帧数据（从 CLIPS.dur + ATTACKS.hits.at 计算）---
  frameData: {
    startup: number;      // 起手帧数（60fps）
    active: number;       // 活跃帧数（60fps）
    recovery: number;     // 收招帧数（60fps）
    total: number;        // 总帧数（60fps）
  };

  // --- 攻击属性（来自 ATTACKS）---
  attack: {
    part: StrikePart;
    hits: AtkHit[];
    hitstop: number;
    react: 'light' | 'heavy' | 'up';
    damage: [number, number];  // [min, max]
    knockback: number;
    forward?: number;     // 前冲距离
    close?: boolean;      // 仅近距离
    far?: boolean;        // 远距离突进
    projectile?: 'bolt' | 'shuriken';
    throw?: boolean;      // 投技
  };

  // --- 特效配置（来自 FX_SPEC）---
  vfx: {
    style: FxSpec['style'];
    color: string;
    zoom: number;
    screenShake: number;
  };

  // --- 行为属性（AI 用）---
  behavior: {
    /** AI 选用权重基础值（会被行为模板调整） */
    baseWeight: number;
    /** 在连招中的位置：opener(起手)/filler(衔接)/ender(终结) */
    comboRole: 'opener' | 'filler' | 'ender';
    /** 是否适合反击用（counter-hit 加成） */
    goodForCounter: boolean;
    /** 破防能力（0~1，多大概率打破架势） */
    guardDamage: number;
    /** 对霸体/装甲的额外伤害倍率 */
    armorMultiplier: number;
  };

  // --- 取消规则 ---
  cancels: {
    /** 链式取消：此招命中后可取消到的招式列表 */
    chainTo: string[];
    /** 目标取消窗口（进度值 0~1）*/
    cancelFrom: number;
    /** 是否可以被 RC（格挡取消）*/
    rcCancelable: boolean;
  };
}

/** 默认 VFX：当 FX_SPEC 中没有该招式时使用 */
const DEFAULT_VFX: MoveMeta['vfx'] = {
  style: 'punch',
  color: '#FFFFFF',
  zoom: 0,
  screenShake: 1.0,
};

/**
 * 招式分类：根据 ID 和攻击属性判断类别
 */
function categorizeMove(id: string, atk: Atk): MoveMeta['category'] {
  if (atk.projectile) return 'projectile';
  if (atk.throw) return 'throw';
  if (['jab', 'cross', 'hook', 'uppercut', 'elbow', 'palm', 'gearPunch'].includes(id)) return 'punch';
  if (['snapKick', 'pushKick', 'sideKick', 'roundKick', 'axeKick', 'spinKick', 'flyKick', 'scissorKick', 'knee'].includes(id)) return 'kick';
  if (['thrust', 'smash', 'bash', 'slash', 'swing', 'iai', 'flailSwing'].includes(id)) return 'weapon';
  return 'special';
}

/**
 * 获取招式所需的装备流派
 */
function getGearForMove(id: string): Gear | null {
  const moveGearMap: Record<string, Gear> = {
    thrust: 'spear', smash: 'hammer', bash: 'shield',
    slash: 'dagger', palm: 'monk', swing: 'viking',
    iai: 'samurai', flailSwing: 'flail', gearPunch: 'puppeteer',
    bolt: 'gunner', shuriken: 'ninja',
  };
  return moveGearMap[id] ?? null;
}

/**
 * 计算基础 AI 权重：伤害越高的招权重越低（重招稀有），快招加分
 */
function computeBaseWeight(id: string, atk: Atk): number {
  const power = atk.hits.reduce((s, h) => s + (h.dmg[0] + h.dmg[1]) / 2, 0);
  let w = Math.max(0.3, 24 / power);
  if (atk.hits.length > 1) w *= 0.75;
  return w;
}

/**
 * 推断连招角色：起手/衔接/终结
 */
function inferComboRole(id: string, atk: Atk): MoveMeta['behavior']['comboRole'] {
  if (atk.react === 'light') return atk.hits[0]?.at && atk.hits[0].at < 0.45 ? 'opener' : 'filler';
  if (atk.react === 'heavy' || atk.react === 'up') {
    const power = atk.hits.reduce((s, h) => s + (h.dmg[0] + h.dmg[1]) / 2, 0);
    return power > 20 ? 'ender' : 'filler';
  }
  return 'filler';
}

/**
 * 估算破防能力（0~1）
 */
function estimateGuardDamage(atk: Atk): number {
  const power = atk.hits.reduce((s, h) => s + (h.dmg[0] + h.dmg[1]) / 2, 0);
  if (power >= 22) return 0.8;
  if (power >= 16) return 0.5;
  if (power >= 12) return 0.3;
  return 0.15;
}

/**
 * 计算连取消目标列表
 */
function computeChainTargets(id: string): string[] {
  const chainMap: Record<string, string[]> = {
    jab: ['cross', 'hook', 'uppercut', 'snapKick'],
    cross: ['uppercut', 'hook', 'roundKick', 'elbow'],
    hook: ['uppercut', 'cross', 'snapKick'],
    uppercut: ['spinKick', 'flyKick', 'roundKick'],
    elbow: ['jab', 'cross', 'uppercut', 'knee'],
    snapKick: ['roundKick', 'axeKick', 'pushKick', 'jab'],
    pushKick: ['sideKick', 'jab', 'cross'],
    sideKick: ['roundKick', 'axeKick', 'jab'],
    roundKick: ['axeKick', 'spinKick', 'hook'],
    axeKick: ['spinKick', 'roundKick'],
    spinKick: ['jab', 'cross', 'uppercut'],
    flyKick: ['jab', 'cross', 'snapKick'],
    scissorKick: ['roundKick', 'uppercut', 'jab'],
    thrust: ['smash', 'bash', 'jab'],
    smash: ['thrust', 'bash', 'gearPunch'],
    bash: ['thrust', 'smash', 'jab'],
    slash: ['palm', 'jab', 'slash'],
    palm: ['elbow', 'knee', 'jab'],
    swing: ['iai', 'smash', 'thrust'],
    iai: ['swing', 'slash', 'cross'],
    flailSwing: ['smash', 'swing', 'bash'],
    gearPunch: ['elbow', 'cross', 'jab'],
    bolt: ['shuriken', 'jab', 'snapKick'],
    knee: ['elbow', 'palm', 'uppercut', 'jab'],
    throw: [],
    counterStrike: ['cross', 'uppercut', 'roundKick', 'iai'],
    shuriken: ['bolt', 'jab', 'snapKick'],
  };
  return chainMap[id] ?? ['jab', 'cross'];
}

/**
 * 从现有的分散表构建完整的 MoveMeta 条目
 *
 * @param id - 招式 ID
 * @returns 完整的 MoveMeta，或 null 如果缺少必要数据
 */
function buildMoveMeta(id: string): MoveMeta | null {
  const clip = CLIPS[id];
  const atk = ATTACKS[id];
  const fx = FX_SPEC[id];

  if (!clip || !atk) return null;

  // 从 atk.hits 计算帧数据（60fps）
  const firstHit = atk.hits[0];
  const lastHit = atk.hits[atk.hits.length - 1];
  const totalFrames = Math.round(clip.dur * 60);
  const startupFrames = Math.round((firstHit?.at ?? 0.5) * clip.dur * 60);
  const activeEnd = Math.round((lastHit?.at ?? 0.6) * clip.dur * 60);
  const activeFrames = Math.max(1, activeEnd - startupFrames);
  const recoveryFrames = Math.max(1, totalFrames - activeEnd);

  // 提取伤害范围
  const allDmgs = atk.hits.flatMap(h => h.dmg);
  const minDmg = Math.min(...allDmgs);
  const maxDmg = Math.max(...allDmgs);

  // 提取击退值（取最大的 knock）
  const maxKnock = Math.max(...atk.hits.map(h => (h as AtkHit & { knock?: number }).knock ?? 0));

  return {
    id,
    category: categorizeMove(id, atk),
    gearRequired: getGearForMove(id),
    frameData: {
      startup: startupFrames,
      active: activeFrames,
      recovery: recoveryFrames,
      total: totalFrames,
    },
    attack: {
      part: atk.part,
      hits: atk.hits,
      hitstop: atk.hitstop,
      react: atk.react,
      damage: [minDmg, maxDmg],
      knockback: maxKnock,
      forward: atk.forward,
      close: atk.close,
      far: atk.far,
      projectile: atk.projectile,
      throw: atk.throw,
    },
    vfx: fx ? {
      style: fx.style,
      color: fx.color,
      zoom: fx.zoom,
      screenShake: fx.dir,
    } : { ...DEFAULT_VFX },
    behavior: {
      baseWeight: computeBaseWeight(id, atk),
      comboRole: inferComboRole(id, atk),
      goodForCounter: atk.react === 'heavy' || id === 'counterStrike' || id === 'elbow' || id === 'iai',
      guardDamage: estimateGuardDamage(atk),
      armorMultiplier: id === 'smash' || id === 'swing' || id === 'flailSwing' ? 1.5 : 1.0,
    },
    cancels: {
      chainTo: computeChainTargets(id),
      cancelFrom: atk.cancelFrom ?? 0.78,
      rcCancelable: !atk.throw && !atk.projectile,
    },
  };
}

/**
 * MOVE_META_FULL 表：所有招式的完整统一元数据（从现有数据自动聚合生成）
 */
const _MOVE_META_FULL: Record<string, MoveMeta> = ((): Record<string, MoveMeta> => {
  const table: Record<string, MoveMeta> = {};
  for (const id of Object.keys(ATTACKS)) {
    const meta = buildMoveMeta(id);
    if (meta) table[id] = meta;
  }
  return table;
})();

/**
 * 向后兼容的 MOVE_META：保留简化接口供 pickAttack 等现有代码使用。
 * 新代码应优先使用 _MOVE_META_FULL 获取完整元数据。
 *
 * 每条记录包含：
 * - startup/recovery: 起手收招时间（秒），从帧数据自动计算
 * - breakGuard: 是否有破防能力
 * - finisher: 是否是终结技
 * - fast: 是否是快招（<=14帧起手）
 * - counter: 是否适合反击
 * - _full: 完整元数据引用
 */
const MOVE_META: Record<string, {
  startup: number; recovery: number;
  breakGuard?: boolean; finisher?: boolean;
  fast?: boolean; counter?: boolean;
  _full?: MoveMeta;
}> = ((): Record<string, {
  startup: number; recovery: number;
  breakGuard?: boolean; finisher?: boolean;
  fast?: boolean; counter?: boolean;
  _full?: MoveMeta;
}> => {
  const compat: Record<string, {
    startup: number; recovery: number;
    breakGuard?: boolean; finisher?: boolean;
    fast?: boolean; counter?: boolean;
    _full?: MoveMeta;
  }> = {};
  for (const [id, meta] of Object.entries(_MOVE_META_FULL)) {
    compat[id] = {
      startup: meta.frameData.startup / 60,
      recovery: meta.frameData.recovery / 60,
      breakGuard: meta.behavior.guardDamage > 0.5,
      finisher: meta.behavior.comboRole === 'ender',
      fast: meta.frameData.startup <= 14,
      counter: meta.behavior.goodForCounter,
      _full: meta,
    };
  }
  return compat;
})();

/**
 * 基于 MOVE_META 计算 AI 招式选择权重
 *
 * 替代当前散落在决策函数中的硬编码权重，
 * 提供统一、可扩展的招式排名接口。
 *
 * @param f - 当前 Fighter
 * @param availableMoves - 可用的招式列表（考虑装备解锁 + 冷却）
 * @param snap - 战斗快照
 * @returns 排序后的 [{ move, weight, reason }] 列表
 */
function rankMoves(
  f: Fighter,
  availableMoves: string[],
  snap: FightSnapshot
): { move: string; weight: number; reason: string }[] {
  const gear = GEAR_SPEC[f.build];

  return availableMoves
    .map(moveId => {
      const fullMeta = _MOVE_META_FULL[moveId];
      const meta = MOVE_META[moveId];
      if (!fullMeta || !meta) return { move: moveId, weight: 0, reason: 'no_meta' };

      let w = fullMeta.behavior.baseWeight;

      // 距离修正
      const dist = snap.self.distance;
      if (fullMeta.attack.far && dist > (fullMeta.attack.forward ? 50 : 40)) w *= 1.5;
      if (fullMeta.attack.close && dist < 25) w *= 2.0;
      if (!fullMeta.attack.far && !fullMeta.attack.close && dist > 45) w *= 0.3;

      // 行为模板修正
      if (gear.behavior === 'zoner' && fullMeta.category === 'projectile') w *= 2.0;
      if (gear.behavior === 'rusher' && fullMeta.attack.close) w *= 1.8;
      if (gear.behavior === 'punisher' && fullMeta.behavior.goodForCounter && f.counterWindow > 0) w *= 3.0;
      if (gear.behavior === 'brawler' && (meta.fast || fullMeta.attack.close)) w *= 1.4;

      // 连招修正
      if (f.comboTimer > 0) {
        if (f.comboSteps && f.comboSteps.length > 0) {
          const lastMove = f.comboSteps[f.comboSteps.length - 1];
          const lastFullMeta = _MOVE_META_FULL[lastMove];
          if (lastFullMeta && lastFullMeta.cancels.chainTo.includes(moveId)) w *= 2.5;
        }
        if (meta.fast) w *= 1.5;
      }

      // 破防优先
      if (snap.opponent.guardBreak) w *= (fullMeta.behavior.comboRole === 'ender' ? 2.4 : 1.6);
      if (snap.opponent.guard < 30 && fullMeta.behavior.guardDamage > 0.5) w *= 2.6;

      // 局面修正
      const oppHurt = ['hurtLight', 'hurtHeavy', 'hurtUp', 'stumble'].includes(snap.opponent.state);
      const oppBlock = snap.opponent.state === 'block';
      if (oppHurt && fullMeta.attack.damage[1] >= 20) w *= 2.2;
      if (oppBlock) w *= fullMeta.behavior.guardDamage > 0.5 ? 2.0 : 0.5;
      if (snap.opponent.hp < 30 && fullMeta.behavior.comboRole === 'ender') w *= 2.5;
      if (f.hp < 30 && meta.fast) w *= 1.8;
      if (f.counterWindow > 0 && fullMeta.behavior.goodForCounter) w *= 3.0;

      // 流派专属加成
      if (gear.moves.includes(moveId)) w *= 1.9;

      return { move: moveId, weight: Math.max(0, w), reason: 'computed' };
    })
    .filter(x => x.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

/**
 * 验证所有数据表的一致性
 *
 * 检查项：
 * 1. ATTACKS 中每个 key 都在 CLIPS 中有对应
 * 2. FX_SPEC 应该覆盖所有攻击性招式
 * 3. GEAR_SPEC.moves 引用的招式 ID 必须存在于 ATTACKS
 * 4. 连取消目标必须指向存在的招式
 *
 * @returns 验证结果
 */
function validateDataConsistency(): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. ATTACKS -> CLIPS 一致性
  for (const k of Object.keys(ATTACKS)) {
    if (!CLIPS[k]) errors.push(`ATTACKS["${k}"] 缺少对应的 CLIPS 条目`);
  }

  // 2. FX_SPEC 覆盖检查
  for (const k of Object.keys(ATTACKS)) {
    if (!FX_SPEC[k]) warnings.push(`ATTACKS["${k}"] 缺少 FX_SPEC 特效配置`);
  }

  // 3. GEAR_SPEC.moves 引用检查
  for (const [gear, spec] of Object.entries(GEAR_SPEC)) {
    for (const move of spec.moves) {
      if (!ATTACKS[move]) errors.push(`GEAR_SPEC["${gear}"].moves 引用了不存在的招式: "${move}"`);
      if (!CLIPS[move]) errors.push(`GEAR_SPEC["${gear}"].moves 引用了不存在的 CLIPS: "${move}"`);
    }
  }

  // 4. 连取消目标有效性检查
  for (const [id, meta] of Object.entries(_MOVE_META_FULL)) {
    for (const target of meta.cancels.chainTo) {
      if (!ATTACKS[target]) {
        warnings.push(`MOVE_META["${id}"].cancels.chainTo 引用了不存在的招式: "${target}"`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

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
  | 'crouch'
  | 'roll'
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
  | 'scissorKick'
  // 招式名由 ATTACKS 表驱动（武器招/膝击/投技/反击都走这里），不再手工维护两份清单
  | (string & {});

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
  /** 正朝我飞来的投射物（弩箭/星镖）。AI 用此字段做闪避/格挡决策。
   *  kind 字段让 AI 能区分 bolt（高伤慢速→优先举盾）和 shuriken（低伤高速→优先跳跃） */
  incoming: { x: number; y: number; vx: number; eta: number; kind: 'bolt' | 'shuriken' }[];
}

export type FightController = (snap: FightSnapshot) => Decision | null;

/* ============================================================
 * 3.5 输入缓冲与帧数据系统（格斗引擎核心基础设施）
 * ============================================================ */

/** 缓冲的输入条目 */
interface BufferedInput {
  /** 决策值 */
  decision: Decision;
  /** 输入时间戳（秒，用 elapsed 全局时钟） */
  timestamp: number;
  /** 是否已被消费 */
  consumed: boolean;
  /** 输入强度（AI 置信度 0~1） */
  confidence: number;
}

/**
 * 环形输入缓冲区
 *
 * 设计参考：FGC Input Buffer / Jazz Engine
 * - 容量 15 帧（约 0.25 秒 @60fps），覆盖人类反应窗口
 * - 支持模糊匹配：消费时按谓词查找，不要求精确匹配
 * - 自动过期：超过窗口的输入在 getUnconsumed 时被过滤
 */
class InputBuffer {
  private buffer: BufferedInput[] = [];
  /** 缓冲窗口（秒）：15 帧 @60fps ≈ 0.25s */
  readonly windowSeconds: number = 0.25;
  /** 最大缓存条目数 */
  readonly capacity: number = 16;

  /** 压入一个决策到缓冲区 */
  push(decision: Decision, confidence: number, now: number): void {
    const entry: BufferedInput = {
      decision,
      timestamp: now,
      consumed: false,
      confidence: Math.max(0, Math.min(1, confidence)),
    };
    this.buffer.push(entry);
    // 防止无限增长：超过容量时移除最旧的未消费条目
    while (this.buffer.length > this.capacity) {
      const removed = this.buffer.shift();
      // 如果移除的是未消费条目，记录一下（调试用）
      if (removed && !removed.consumed) { /* 可加日志 */ }
    }
  }

  /**
   * 消费最近一个匹配的输入（从新到旧搜索）
   * @param predicate 匹配条件
   * @returns 匹配到的条目（标记为已消费），无匹配返回 null
   */
  consume(predicate: (d: Decision) => boolean): BufferedInput | null {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const entry = this.buffer[i];
      if (!entry.consumed && predicate(entry.decision)) {
        entry.consumed = true;
        return entry;
      }
    }
    return null;
  }

  /**
   * 查看最近的输入但不消费
   * @param predicate 匹配条件
   * @param windowSeconds 可选的时间窗口（默认用类默认值）
   * @returns 匹配到的条目引用（不标记消费），无匹配返回 null
   */
  peek(predicate: (d: Decision) => boolean, windowSeconds?: number): BufferedInput | null {
    const win = windowSeconds ?? this.windowSeconds;
    const now = performance.now() / 1000; // 近似当前时间，或传入精确时间
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const entry = this.buffer[i];
      if (!entry.consumed && predicate(entry.decision)) {
        // 检查是否在时间窗口内（这里用相对时间差近似）
        return entry;
      }
    }
    return null;
  }

  /** 清空缓冲区所有条目 */
  clear(): void {
    this.buffer.length = 0;
  }

  /**
   * 获取未消费且在时间窗口内的输入列表（从旧到新）
   * @param now 当前时间戳（秒）
   * @param windowSeconds 时间窗口
   * @returns 有效未消费输入列表
   */
  getUnconsumed(now: number, windowSeconds?: number): BufferedInput[] {
    const win = windowSeconds ?? this.windowSeconds;
    const cutoff = now - win;
    return this.buffer.filter((e) => !e.consumed && e.timestamp >= cutoff);
  }

  /** 获取缓冲区中总条目数（含已消费） */
  get size(): number {
    return this.buffer.length;
  }
}

/**
 * 标准帧数据模型（Startup / Active / Recovery 三段式）
 *
 * 格斗游戏通用框架：
 * - Startup: 从指令输入到攻击判定生效前的帧数
 * - Active: 攻击判定有效的帧范围
 * - Recovery: 判定结束后到完全恢复可行动的帧数
 *
 * 本引擎用「进度值 0~1」（clipT/clipDur）代替帧号，
 * 所以 startup/activeStart/activeEnd 都是 0~1 的比例值。
 */
interface FrameData {
  /** 起手阶段结束点（进度 0~1）：第一段 hit 的 at 值 */
  startup: number;
  /** 活跃阶段起始点（进度 0~1）：最早 hit 的 at */
  activeStart: number;
  /** 活跃阶段结束点（进度 0~1）：最晚 hit 的 at */
  activeEnd: number;
  /** 收招阶段起始点（进度 0~1）：活跃结束 + 少许帧 */
  recoveryStart: number;
  /** 总持续时间（秒），来自 clip.dur */
  totalDuration: number;

  // ---- 派生属性（从 ATTACKS + MOVE_META 计算）----
  /** 取消窗口起始（进度值 0~1）：命中后过了这个点就能取消收招接下一段 */
  cancelFrom: number;
  /** 被防时的 frame advantage（正=有利，负=不利），单位：秒 */
  blockAdvantage: number;
  /** 命中时的 frame advantage，单位：秒 */
  hitAdvantage: number;
  /** 是否是多段打击招式 */
  multiHit: boolean;
  /** 总段数 */
  hitCount: number;
}

/**
 * 从现有的 Atk 定义和 Clip 数据计算标准帧数据
 *
 * 计算规则：
 * - startup = 第一段 hit.at（起手到首次判定生效）
 * - activeStart = 第一段 hit.at
 * - activeEnd = 最后一段 hit.at
 * - recoveryStart = activeEnd + 2~4 帧的等价进度（约 0.03~0.06）
 * - blockAdvantage ≈ -(totalDuration - recoveryStart/1) * totalDuration + 0.03s（被防通常略不利）
 * - hitAdvantage ≈ -(totalDuration - recoveryStart/1) * totalDuration + 0.07s（命中通常稍有利）
 *
 * @param moveName 招式名（用于查 MOVE_META）
 * @param atk 攻击数据（来自 ATTACKS 表）
 * @param clip 动画片段数据（来自 CLIPS 表）
 */
function computeFrameData(moveName: string, atk: Atk, clip: Clip): FrameData {
  const hits = atk.hits;
  const hitCount = hits.length;
  const multiHit = hitCount > 1;

  // 起手和活跃窗口
  const firstAt = Math.min(...hits.map((h) => h.at));
  const lastAt = Math.max(...hits.map((h) => h.at));

  const startup = firstAt;
  const activeStart = firstAt;
  const activeEnd = lastAt;

  // 收招起点：活跃结束后约 2~4 帧（@60fps ≈ 0.033~0.067s）
  // 多段招收招稍慢
  const recoveryPad = multiHit ? 0.06 : 0.04;
  const recoveryStart = Math.min(1, activeEnd + recoveryPad);

  // 取消窗口：优先用 atk.cancelFrom，否则用 MOVE_META 或默认值
  const cancelFrom = atk.cancelFrom ?? 0.78;

  // Frame advantage 估算（秒）
  // 公式：剩余收招时间的负值 + 基础修正
  const remainingRecovery = (1 - recoveryStart / 1) * clip.dur;
  const meta = MOVE_META[moveName];
  // 被防优势：重招被防更有利（对手硬直长），快招不利
  const blockBonus = meta?.breakGuard ? 0.05 : meta?.fast ? -0.02 : 0.01;
  const blockAdvantage = -remainingRecovery + 0.025 + blockBonus;
  // 命中优势：通常比被防多 3~5 帧有利
  const hitBonus = meta?.finisher ? 0.06 : meta?.counter ? 0.04 : 0.02;
  const hitAdvantage = -remainingRecovery + 0.06 + hitBonus;

  return {
    startup,
    activeStart,
    activeEnd,
    recoveryStart,
    totalDuration: clip.dur,
    cancelFrom,
    blockAdvantage,
    hitAdvantage,
    multiHit,
    hitCount,
  };
}

/** 判定当前招式所处阶段 */
type AttackPhase = 'none' | 'startup' | 'active' | 'recovery';

/**
 * 获取当前招式的攻击阶段
 * @param prog 当前动画进度（0~1）
 * @param fd 帧数据（可为 null）
 */
function getAttackPhase(prog: number, fd: FrameData | null): AttackPhase {
  if (!fd) return 'none';
  if (prog < fd.activeStart) return 'startup';
  if (prog <= fd.activeEnd) return 'active';
  return 'recovery';
}

/** 决策历史条目（用于调试和模式分析） */
interface DecisionRecord {
  /** 时间戳（秒） */
  t: number;
  /** 决策值 */
  decision: Decision;
  /** 置信度 */
  confidence: number;
  /** 来源：'heuristic' | 'buffer' | 'external' | 'manual' */
  source: string;
  /** 是否被执行（false 表示被缓冲或被 intentLock 抑制） */
  executed: boolean;
}

let externalController: FightController | null = null;

/** 供将来接 AI：window.takinolFight.setController(fn) */
export function setController(fn: FightController | null): void {
  externalController = fn;
}

/* ============================================================
 * 4. 引擎
 * ============================================================ */

/** 可播种随机：不播种时行为和以前一样；播种后整局可复现（回放 / 回归测试 / RL  rollout 都靠它） */
let rngState = 0;
const random = (): number => {
  if (!rngState) return Math.random();
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = (a: number, b: number) => a + random() * (b - a);

interface Root {
  x: number;
  vx: number;
  facing: number;
  scale: number;
  top: number; // 头顶相对骨盆的高度（造型相关）
}

/* ============================================================
 * 调试系统类型定义
 * ============================================================ */

/** 命中盒类型：格斗游戏行业标准 6 色系统（SF6 / GGPO 工具） */
export enum HitboxType {
  /** 攻击命中盒（红）- 出招时出现的攻击判定区域 */
  Attack = 'attack',
  /** 受击盒（蓝）- 可以被攻击命中的身体区域 */
  Hurt = 'hurt',
  /** 格挡盒（绿）- 格挡状态下生效的防御判定区域 */
  Guard = 'guard',
  /** 脆弱盒（黄）- 特殊状态（破防/硬直）下扩大受击区域 */
  Vulnerable = 'vulnerable',
  /** 传感器盒（紫）- 地面检测/距离探测等非伤害判定 */
  Sensor = 'sensor',
  /** 投射物盒（青）- 弹道类招式的飞行道具判定 */
  Projection = 'projection',
}

/** 单个调试命中盒 */
export interface DebugHitbox {
  type: HitboxType;
  /** 圆形：cx, cy, r；矩形：x, y, w, h */
  cx?: number; cy?: number; r?: number;
  x?: number; y?: number; w?: number; h?: number;
  /** 关联的关节名（用于跟随骨骼运动） */
  joint?: keyof Joints;
  /** 激活时间段 [start, end] (0~1 相对 clip 进度) */
  activeRange: [number, number];
}

/** 洋葱皮/鬼帧：姿态历史快照 */
export interface PoseGhost {
  /** 世界坐标关节位置 */
  joints: Record<keyof Joints, Pt>;
  /** 时间戳（用于淡出计算） */
  t: number;
  /** 透明度（0=完全透明，1=完全不透明） */
  alpha: number;
}

/** 帧步进控制状态 */
interface FrameStepControl {
  paused: boolean;
  stepForward: boolean;
  stepBackward: boolean;
  speed: number;        // 播放速度倍率 (0.1 ~ 5.0)
  currentFrame: number; // 当前帧编号
  totalFrames: number;  // 总帧数
}

/** 多级调试选项 */
export interface DebugOptions {
  /** 骨骼显示（原有功能） */
  bones?: boolean;
  /** 命中盒显示（6色系统） */
  hitboxes?: boolean;
  /** 帧信息显示（帧计数器、clip进度条） */
  frames?: boolean;
  /** 完整模式 = bones + hitboxes + frames + HUD + onion skin */
  full?: boolean;
  /** 洋葱皮/鬼帧显示 */
  onionSkin?: boolean;
  /** 洋葱皮配置 */
  onionConfig?: {
    maxGhosts: number;   // 最大鬼帧数量（默认 5）
    fadeRate: number;    // 淡出速率（默认 0.03/帧）
    color: string;       // 鬼帧颜色（默认 'rgba(100,180,255,ALPHA)'）
  };
  /** 帧步进模式 */
  frameStep?: boolean;
  /** SF6 风格调试 HUD */
  hud?: boolean;
  /** 命中盒详细程度：'simple'=仅当前激活, 'full'=所有定义的盒子 */
  hitboxDetail?: 'simple' | 'full';
}

/** 解析 URL 调试参数 */
const parseDebugParams = (urlParams: URLSearchParams): DebugOptions => {
  const raw = urlParams.get('debug');
  const opts: DebugOptions = {};
  if (!raw) return opts;

  const modes = raw.split(',').map(s => s.trim().toLowerCase());
  for (const m of modes) {
    if (m === 'bones') opts.bones = true;
    else if (m === 'hitboxes') opts.hitboxes = true;
    else if (m === 'frames') opts.frames = true;
    else if (m === 'full') { opts.bones = opts.hitboxes = opts.frames = opts.full = opts.hud = true; opts.onionSkin = true; }
    else if (m === 'onion') opts.onionSkin = true;
    else if (m === 'hud') opts.hud = true;
    // 兼容旧版 ?debug=bones
    else if (m === 'bones') opts.bones = true;
  }

  // 帧步进通过单独参数控制
  if (urlParams.get('frame_step') === 'true' || urlParams.get('frame_step') === '1') {
    opts.frameStep = true;
  }

  return opts;
};

/** 命中盒颜色映射（SF6 标准 6 色） */
const HITBOX_COLORS: Record<HitboxType, { fill: string; stroke: string }> = {
  [HitboxType.Attack]:     { fill: 'rgba(231,76,60,0.25)',  stroke: '#E74C3C' },      // 红 - 攻击
  [HitboxType.Hurt]:       { fill: 'rgba(52,152,219,0.20)',  stroke: '#3498DB' },      // 蓝 - 受击
  [HitboxType.Guard]:      { fill: 'rgba(46,204,113,0.22)',  stroke: '#2ECC71' },      // 绿 - 格挡
  [HitboxType.Vulnerable]: { fill: 'rgba(241,196,15,0.25)',  stroke: '#F1C40F' },      // 黄 - 脆弱
  [HitboxType.Sensor]:     { fill: 'rgba(155,89,182,0.20)',  stroke: '#9B59B6' },      // 紫 - 传感
  [HitboxType.Projection]: { fill: 'rgba(26,188,156,0.22)',  stroke: '#1ABC9C' },      // 青 - 投射
};

/** 命中盒类型中文标签 */
const HITBOX_LABELS: Record<HitboxType, string> = {
  [HitboxType.Attack]:     'ATK',
  [HitboxType.Hurt]:       'HURT',
  [HitboxType.Guard]:      'GRD',
  [HitboxType.Vulnerable]: 'VULN',
  [HitboxType.Sensor]:     'SENS',
  [HitboxType.Projection]: 'PROJ',
};

export interface FightOptions {
  /** 画布元素 id，默认 fight-canvas */
  canvasId?: string;
  /** 演示模式：按顺序逐个播放招式并标注 */
  demo?: boolean;
  /** 调试/截图用：无视口可见性门控，始终渲染 */
  forceVisible?: boolean;
  /** 演示模式下是否在 canvas 顶部画招式标题 HUD（图鉴等嵌入场景可关） */
  hud?: boolean;
  /** 无限模式：真正阵亡后换下一个随机挑战者（默认开）；普通击倒只倒地再起身 */
  endless?: boolean;
  /** 持续显示姓名牌（设定模式用） */
  showNames?: boolean;
  /** 设定模式：指定左右角色（ROSTER 下标） */
  matchup?: { left: number; right: number };
  /** 手动模式：左侧角色由键盘控制（A/D 移动 W 跳 S 蹲 J/K 攻击 L 翻滚 U 格挡 空格反击） */
  manual?: boolean;
  /** 参数覆盖：侵略性 / 格挡倾向 / 血量 */
  params?: { aggression?: number; guardChance?: number; hp?: number };
  /** 调试模式：实时绘制骨骼轮廓叠加层（关节点+骨连线），用于动作精调。
   *  也可通过 URL 参数 ?debug=bones 自动启用。
   *  @deprecated 使用 debugOptions 替代以获得更多调试功能 */
  debugBones?: boolean;
  /** 增强调试选项：支持多级调试模式（bones/hitboxes/frames/full）
   *  通过 URL 参数启用：?debug=hitboxes&frame_step=true
   *  或 ?debug=full 启用完整调试套件 */
  debugOptions?: DebugOptions;
}

export function initFightBand(opts: FightOptions = {}): void {
  const canvas = document.getElementById(opts.canvasId ?? 'fight-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // URL 参数调试系统：支持多级模式
  // ?debug=bones|hitboxes|frames|full|onion|hud (&frame_step=true)
  const urlParams = new URLSearchParams(window.location.search);
  const urlDebugOpts = parseDebugParams(urlParams);
  // 合并选项：显式传入 > URL 参数 > 默认值
  const debugOptions: DebugOptions = {
    bones: opts.debugBones ?? opts.debugOptions?.bones ?? urlDebugOpts.bones,
    hitboxes: opts.debugOptions?.hitboxes ?? urlDebugOpts.hitboxes,
    frames: opts.debugOptions?.frames ?? urlDebugOpts.frames,
    full: opts.debugOptions?.full ?? urlDebugOpts.full,
    onionSkin: opts.debugOptions?.onionSkin ?? urlDebugOpts.onionSkin,
    onionConfig: opts.debugOptions?.onionConfig ?? urlDebugOpts.onionConfig ?? {
      maxGhosts: 5,
      fadeRate: 0.03,
      color: 'rgba(100,180,255,ALPHA)',
    },
    frameStep: opts.debugOptions?.frameStep ?? urlDebugOpts.frameStep,
    hud: opts.debugOptions?.hud ?? urlDebugOpts.hud,
    hitboxDetail: opts.debugOptions?.hitboxDetail ?? 'simple',
  };
  // 向后兼容：debugBones 或 debug=bones 时自动启用 bones
  const debugBones = debugOptions.bones ?? false;

  // MOVE_META 数据一致性验证（仅 debug 模式输出）
  if (debugBones || urlParams.get('debug') !== null) {
    const result = validateDataConsistency();
    if (!result.ok) {
      console.error('[MOVE_META] Data consistency errors:', result.errors);
    }
    if (result.warnings.length > 0) {
      console.warn('[MOVE_META] Warnings:', result.warnings);
    }
    if (result.ok && result.warnings.length === 0) {
      console.log('[MOVE_META] All data tables consistent ✓');
    }
  }

  // full 模式一键全开
  if (debugOptions.full) {
    debugOptions.bones = true;
    debugOptions.hitboxes = true;
    debugOptions.frames = true;
    debugOptions.hud = true;
    debugOptions.onionSkin = true;
  }

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
   * 十五人角色表：按「剪影差异 + 武器轨迹 + 动态件类型」分化，每人占一个打法生态位。
   *   build      装备流派（决定剪影主装饰与动态件）
   *   skin       配色
   *   aggression 进攻欲 / guardChance 格挡倾向
   *   preferDist 已移除 → 由 computePreferDist(GEAR_SPEC[build].behavior) 自动计算
   */
  const ROSTER = [
    { name: '疾风剑客', build: 'swordsman' as const, skin: 1, aggression: 0.85, guardChance: 0.4 },
    { name: '林影游侠', build: 'ranger' as const, skin: 4, aggression: 0.6, guardChance: 0.35 },
    { name: '铁壁盾卫', build: 'shield' as const, skin: 6, aggression: 0.4, guardChance: 0.85 },
    { name: '青芒枪兵', build: 'spear' as const, skin: 7, aggression: 0.6, guardChance: 0.5 },
    { name: '双刃影客', build: 'dagger' as const, skin: 8, aggression: 1.0, guardChance: 0.25 },
    { name: '拂尘武僧', build: 'monk' as const, skin: 9, aggression: 0.8, guardChance: 0.45 },
    { name: '熔岩矮匠', build: 'hammer' as const, skin: 10, aggression: 0.65, guardChance: 0.3 },
    { name: '硝石弩手', build: 'gunner' as const, skin: 11, aggression: 0.5, guardChance: 0.4 },
    { name: '赤焰武人', build: 'swordsman' as const, skin: 0, aggression: 1.0, guardChance: 0.5 },
    { name: '暗影忍者', build: 'ninja' as const, skin: 12, aggression: 0.75, guardChance: 0.2 },
    { name: '醉卧仙', build: 'drunk' as const, skin: 13, aggression: 0.7, guardChance: 0.35 },
    { name: '血斧维京', build: 'viking' as const, skin: 14, aggression: 0.95, guardChance: 0.25 },
    { name: '月下武士', build: 'samurai' as const, skin: 15, aggression: 0.65, guardChance: 0.55 },
    { name: '铁链判官', build: 'flail' as const, skin: 16, aggression: 0.7, guardChance: 0.4 },
    { name: '齿轮机关师', build: 'puppeteer' as const, skin: 17, aggression: 0.6, guardChance: 0.45 },
  ];

  /** 把角色表里的设定套到一个斗士身上，并触发登场。preferDist 由行为 archetype 自动计算 */
  const applyRoster = (f: Fighter, r: (typeof ROSTER)[number]) => {
    f.name = r.name;
    f.build = r.build;
    f.skin = SKINS[r.skin];
    f.aggression = r.aggression;
    f.guardChance = r.guardChance;
    f.preferDist = computePreferDist(GEAR_SPEC[r.build].behavior);
    f.enterT = f.enterDur;
  };

  type State =
    | 'idle'
    | 'walk'
    | 'approach'
    | 'retreat'
    | 'block'
    | 'jump'
    | 'crouch'
    | 'roll'
    | 'down'
    | 'getup'
    | 'hurtLight'
    | 'hurtHeavy'
    | 'hurtUp'
    | 'hurtLeg'
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
    | 'scissorKick'
    /* 武器流派招式：之前漏在这个联合类型外面，靠 as State 强转糊过去，
       导致任何 Record<State, X> 的表漏项都不报错 —— 现在补齐，让类型重新能兜底 */
    | 'thrust'
    | 'smash'
    | 'bash'
    | 'slash'
    | 'palm'
    | 'swing'
    | 'iai'
    | 'flailSwing'
    | 'gearPunch'
    | 'bolt'
    | 'shuriken'
    | 'knee'
    | 'throw'
    | 'counterStrike';

  /* ========== HFSM: 基于 @statewalker/fsm 的分层有限状态机 ========== */

  /**
   * 战斗状态机配置：4 层嵌套层级状态机
   *
   * 层级结构（从外到内，优先级从高到低）：
   *   root (fighter)
   *   ├── System      — KO / 登场 / 命中定格（最高优先级）
   *   ├── HitReaction — 受击反应（被打/踉跄/倒地/起身）
   *   ├── Combat      — 攻击/格挡/蹲/翻滚
   *   └── Locomotion  — 待机/走/接近/撤退/跳跃
   *
   * 每层的 INITIAL 状态自动下落到内层，实现"外层空闲时交给下层处理"的语义。
   * 高优先级事件（如受击）通过根级别或外层通配符 [STATE_ANY, ...] 接管。
   */
  const fighterFsmConfig: FsmStateConfig = {
    key: 'fighter',
    states: [
      {
        key: 'system',
        transitions: [
          [STATE_INITIAL, STATE_EMPTY, 'idle'],
          [STATE_ANY, 'HURT_LIGHT', 'hitReaction'],
          [STATE_ANY, 'HURT_HEAVY', 'hitReaction'],
          [STATE_ANY, 'HURT_UP', 'hitReaction'],
          [STATE_ANY, 'HURT_LEG', 'hitReaction'],
          [STATE_ANY, 'STUMBLE', 'hitReaction'],
        ],
        states: [{ key: 'idle' }]
      },
      {
        key: 'hitReaction',
        transitions: [
          [STATE_INITIAL, STATE_EMPTY, 'idle'],
          [STATE_ANY, 'HURT_LIGHT', 'hurtLight'],
          [STATE_ANY, 'HURT_HEAVY', 'hurtHeavy'],
          [STATE_ANY, 'HURT_UP', 'hurtUp'],
          [STATE_ANY, 'HURT_LEG', 'hurtLeg'],
          [STATE_ANY, 'STUMBLE', 'stumble'],
          ['stumble', 'KNOCK_DOWN', 'down'],
          ['down', 'GETUP', 'getup'],
          ['hurtLight', 'RECOVER', STATE_INITIAL],
          ['hurtHeavy', 'RECOVER', STATE_INITIAL],
          ['hurtUp', 'RECOVER', STATE_INITIAL],
          ['hurtLeg', 'RECOVER', STATE_INITIAL],
          ['getup', 'RECOVER', STATE_INITIAL],
          // 受击态之间互相切换
          ['hurtLight', 'HURT_HEAVY', 'hurtHeavy'],
          ['hurtLight', 'HURT_UP', 'hurtUp'],
          ['hurtHeavy', 'HURT_LIGHT', 'hurtLight'],
          ['hurtHeavy', 'HURT_UP', 'hurtUp'],
          ['hurtLight', 'HURT_LEG', 'hurtLeg'],
          ['hurtHeavy', 'HURT_LEG', 'hurtLeg'],
          ['hurtUp', 'HURT_LEG', 'hurtLeg'],
          ['hurtLeg', 'HURT_LIGHT', 'hurtLight'],
          ['hurtLeg', 'HURT_HEAVY', 'hurtHeavy'],
          ['hurtLeg', 'HURT_UP', 'hurtUp'],
        ],
        states: [
          { key: 'idle' }, { key: 'hurtLight' }, { key: 'hurtHeavy' },
          { key: 'hurtUp' }, { key: 'hurtLeg' }, { key: 'stumble' },
          { key: 'down' }, { key: 'getup' },
        ]
      },
      {
        key: 'combat',
        transitions: [
          [STATE_INITIAL, STATE_EMPTY, 'idle'],
          // 从 idle 发起的攻击（30 个）
          ['idle', 'JAB', 'jab'], ['idle', 'CROSS', 'cross'], ['idle', 'HOOK', 'hook'],
          ['idle', 'UPPERCUT', 'uppercut'], ['idle', 'ELBOW', 'elbow'], ['idle', 'KNEE', 'knee'],
          ['idle', 'THROW', 'throw'], ['idle', 'COUNTER_STRIKE', 'counterStrike'],
          ['idle', 'SNAP_KICK', 'snapKick'], ['idle', 'PUSH_KICK', 'pushKick'],
          ['idle', 'SIDE_KICK', 'sideKick'], ['idle', 'ROUND_KICK', 'roundKick'],
          ['idle', 'AXE_KICK', 'axeKick'], ['idle', 'SPIN_KICK', 'spinKick'],
          ['idle', 'FLY_KICK', 'flyKick'], ['idle', 'SCISSOR_KICK', 'scissorKick'],
          ['idle', 'THRUST', 'thrust'], ['idle', 'SMASH', 'smash'], ['idle', 'BASH', 'bash'],
          ['idle', 'SLASH', 'slash'], ['idle', 'PALM', 'palm'], ['idle', 'SWING', 'swing'],
          ['idle', 'IAI', 'iai'], ['idle', 'FLAIL_SWING', 'flailSwing'],
          ['idle', 'GEAR_PUNCH', 'gearPunch'], ['idle', 'BOLT', 'bolt'],
          ['idle', 'SHURIKEN', 'shuriken'],
          // 防御/特殊
          ['idle', 'BLOCK', 'block'], ['idle', 'CROUCH', 'crouch'], ['idle', 'ROLL', 'roll'],
          // 连招取消
          ['jab', 'COMBO_CROSS', 'cross'], ['jab', 'COMBO_HOOK', 'hook'],
          ['jab', 'COMBO_UPPERCUT', 'uppercut'], ['jab', 'COMBO_SNAP_KICK', 'snapKick'],
          ['cross', 'COMBO_HOOK', 'hook'], ['cross', 'COMBO_UPPERCUT', 'uppercut'],
          ['cross', 'COMBO_SNAP_KICK', 'snapKick'],
          ['hook', 'COMBO_UPPERCUT', 'uppercut'], ['hook', 'COMBO_ROUND_KICK', 'roundKick'],
          ['snapKick', 'COMBO_ROUND_KICK', 'roundKick'], ['snapKick', 'COMBO_SIDE_KICK', 'sideKick'],
          ['pushKick', 'COMBO_ROUND_KICK', 'roundKick'], ['pushKick', 'COMBO_AXE_KICK', 'axeKick'],
          ['cross', 'COMBO_COUNTER_STRIKE', 'counterStrike'],
          ['uppercut', 'COMBO_COUNTER_STRIKE', 'counterStrike'],
          ['roundKick', 'COMBO_SPIN_KICK', 'spinKick'], ['roundKick', 'COMBO_AXE_KICK', 'axeKick'],
          ['axeKick', 'COMBO_SPIN_KICK', 'spinKick'], ['axeKick', 'COMBO_FLY_KICK', 'flyKick'],
          ['thrust', 'COMBO_SLASH', 'slash'], ['thrust', 'COMBO_SMASH', 'smash'],
          ['slash', 'COMBO_IAI', 'iai'], ['slash', 'COMBO_SWING', 'swing'],
          ['smash', 'COMBO_BASH', 'bash'],
          // 自然结束 → INITIAL
          ['jab', 'ATTACK_END', STATE_INITIAL], ['cross', 'ATTACK_END', STATE_INITIAL],
          ['hook', 'ATTACK_END', STATE_INITIAL], ['uppercut', 'ATTACK_END', STATE_INITIAL],
          ['elbow', 'ATTACK_END', STATE_INITIAL], ['knee', 'ATTACK_END', STATE_INITIAL],
          ['throw', 'ATTACK_END', STATE_INITIAL], ['counterStrike', 'ATTACK_END', STATE_INITIAL],
          ['snapKick', 'ATTACK_END', STATE_INITIAL], ['pushKick', 'ATTACK_END', STATE_INITIAL],
          ['sideKick', 'ATTACK_END', STATE_INITIAL], ['roundKick', 'ATTACK_END', STATE_INITIAL],
          ['axeKick', 'ATTACK_END', STATE_INITIAL], ['spinKick', 'ATTACK_END', STATE_INITIAL],
          ['flyKick', 'ATTACK_END', STATE_INITIAL], ['scissorKick', 'ATTACK_END', STATE_INITIAL],
          ['thrust', 'ATTACK_END', STATE_INITIAL], ['smash', 'ATTACK_END', STATE_INITIAL],
          ['bash', 'ATTACK_END', STATE_INITIAL], ['slash', 'ATTACK_END', STATE_INITIAL],
          ['palm', 'ATTACK_END', STATE_INITIAL], ['swing', 'ATTACK_END', STATE_INITIAL],
          ['iai', 'ATTACK_END', STATE_INITIAL], ['flailSwing', 'ATTACK_END', STATE_INITIAL],
          ['gearPunch', 'ATTACK_END', STATE_INITIAL], ['bolt', 'ATTACK_END', STATE_INITIAL],
          ['shuriken', 'ATTACK_END', STATE_INITIAL],
          ['block', 'ACTION_END', STATE_INITIAL], ['crouch', 'ACTION_END', STATE_INITIAL],
          ['roll', 'ACTION_END', STATE_INITIAL],
        ],
        states: [
          { key: 'idle' },
          { key: 'jab' }, { key: 'cross' }, { key: 'hook' }, { key: 'uppercut' },
          { key: 'elbow' }, { key: 'knee' }, { key: 'throw' }, { key: 'counterStrike' },
          { key: 'snapKick' }, { key: 'pushKick' }, { key: 'sideKick' },
          { key: 'roundKick' }, { key: 'axeKick' }, { key: 'spinKick' },
          { key: 'flyKick' }, { key: 'scissorKick' },
          { key: 'thrust' }, { key: 'smash' }, { key: 'bash' },
          { key: 'slash' }, { key: 'palm' }, { key: 'swing' },
          { key: 'iai' }, { key: 'flailSwing' }, { key: 'gearPunch' },
          { key: 'bolt' }, { key: 'shuriken' },
          { key: 'block' }, { key: 'crouch' }, { key: 'roll' },
        ]
      },
      {
        key: 'locomotion',
        transitions: [
          [STATE_INITIAL, STATE_EMPTY, 'idle'],
          ['idle', 'WALK', 'walk'], ['idle', 'APPROACH', 'approach'],
          ['idle', 'RETREAT', 'retreat'], ['idle', 'JUMP', 'jump'],
          ['walk', 'IDLE', 'idle'], ['walk', 'APPROACH', 'approach'],
          ['walk', 'RETREAT', 'retreat'], ['walk', 'JUMP', 'jump'],
          ['approach', 'IDLE', 'idle'], ['approach', 'WALK', 'walk'],
          ['retreat', 'IDLE', 'idle'], ['retreat', 'WALK', 'walk'],
          ['jump', 'LAND', 'idle'],
        ],
        states: [
          { key: 'idle' }, { key: 'walk' }, { key: 'approach' },
          { key: 'retreat' }, { key: 'jump' },
        ]
      },
    ]
  };

  /**
   * State 枚举值 → FSM 事件名称映射表
   * 用于 setStateHFSM 将 State 值转换为 FsmProcess.dispatch() 的事件字符串
   */
  const STATE_EVENT_MAP: Partial<Record<State, string>> = {
    hurtLight: 'HURT_LIGHT', hurtHeavy: 'HURT_HEAVY', hurtUp: 'HURT_UP',
    hurtLeg: 'HURT_LEG', stumble: 'STUMBLE', down: 'KNOCK_DOWN', getup: 'GETUP',
    jab: 'JAB', cross: 'CROSS', hook: 'HOOK', uppercut: 'UPPERCUT',
    elbow: 'ELBOW', knee: 'KNEE', throw: 'THROW', counterStrike: 'COUNTER_STRIKE',
    snapKick: 'SNAP_KICK', pushKick: 'PUSH_KICK', sideKick: 'SIDE_KICK',
    roundKick: 'ROUND_KICK', axeKick: 'AXE_KICK', spinKick: 'SPIN_KICK',
    flyKick: 'FLY_KICK', scissorKick: 'SCISSOR_KICK',
    thrust: 'THRUST', smash: 'SMASH', bash: 'BASH', slash: 'SLASH',
    palm: 'PALM', swing: 'SWING', iai: 'IAI', flailSwing: 'FLAIL_SWING',
    gearPunch: 'GEAR_PUNCH', bolt: 'BOLT', shuriken: 'SHURIKEN',
    block: 'BLOCK', crouch: 'CROUCH', roll: 'ROLL',
    idle: 'IDLE', walk: 'WALK', approach: 'APPROACH', retreat: 'RETREAT', jump: 'JUMP',
  };

  interface Fighter {
    x: number;
    facing: number;
    hp: number;
    maxHp: number;
    state: State;
    /** @statewalker/fsm 分层状态机实例：管理 4 层嵌套状态（System/HitReaction/Combat/Locomotion） */
    fsm: FsmProcess;
    clipT: number;
    clipDur: number;
    pose: Pose;
    hitDone: boolean[];
    /** 这一招是否已经打到过人（含被格挡）：false 且招式播完 = 挥空，要吃收招惩罚 */
    landedHit: boolean;
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
    /** 感知延迟（秒）：看到的对手比真实慢半拍，AI 不再是全知读帧 */
    perceiveLag: number;
    /** 距离估计噪声（每 0.5s 刷新一次） */
    noise: number;
    noiseT: number;
    /** 承诺窗口：意图锁定剩余时间（防止每 0.1s 反悔抽搐） */
    intentLock: number;
    /** 距上次出招的秒数：用于「出招饥饿」，防止两人贴脸互相试探却永远不动手 */
    sinceAttack: number;
    /** 强制脱离期：打完一套必须拉开喘口气，而不是无休止贴脸互殴 */
    disengage: number;
    /** 反击窗口：格挡成功后短暂提升反击招权重 */
    counterWindow: number;
    /** 架势值（guard）：格挡会消耗，耗尽 → 破防大硬直。站架不动时缓慢回复 */
    guard: number;
    /** 破防硬直剩余时间：此时无法格挡且受伤加重 */
    guardBreak: number;
    /** 架势回复延迟：格挡被击中后这段时间内架势不回，连续压制才能真的打破防 */
    guardDelay: number;
    /** 举盾已持续时间：不能一直举着，超时自动放下 */
    blockT: number;
    /** 跳跃水平速度：非零 = 正在腾空位移（用于越过对手换边，不是瞬移） */
    leap: number;
    /** 滚翻方向：1=向前滚（穿越/切入），-1=向后滚（脱离） */
    rollDir: number;
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
    /** 落地缓冲：>0 时下蹲压缩 */
    landSquash: number;
    ragdoll: Record<string, Pt & { px: number; py: number }> | null;
    links: { a: string; b: string; len: number }[];
    getupFade: number;
    lastDecision: number;
    kb: number;
    /** 被击后的踉跄剩余时间 */
    stagger: number;
    /** 大伤害：踉跄后站不住要倒地 */
    knockdown: boolean;
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
    /** PD 控制器：程序化受击反应（null = 使用传统关键帧，非 null = 启用 PD 增强） */
    pdController: PDController | null;
    /** 无敌帧剩余时间（闪避用） */
    invuln: number;
    minX: number;
    maxX: number;
    /** 洋葱皮/鬼帧历史：用于显示姿态轨迹（调试用） */
    poseHistory: PoseGhost[];
    /* ---- 输入缓冲与帧数据系统字段 ---- */
    /** 环形输入缓冲区：AI 决策先入缓冲，再按窗口消费，防止每帧反悔 */
    inputBuffer: InputBuffer;
    /** 当前招式的帧数据（出招时由 computeFrameData 填充） */
    currentFrameData: FrameData | null;
    /** 当前招式所处阶段：startup / active / recovery / none */
    attackPhase: AttackPhase;
    /** 决策历史（用于模式分析、调试和训练数据采集），最多保留 200 条 */
    decisionHistory: DecisionRecord[];
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

  /* ============================================================
   * 调试系统：命中盒计算 / 洋葱皮 / 帧步进 / HUD
   * ============================================================ */

  /** 帧步进控制状态 */
  const frameStepCtrl: FrameStepControl = {
    paused: false,
    stepForward: false,
    stepBackward: false,
    speed: 1.0,
    currentFrame: 0,
    totalFrames: 0,
  };

  /**
   * 计算当前斗士的活跃命中盒列表。
   * 根据当前姿态、招式状态、clip 进度，实时生成所有应显示的命中盒。
   * 这是调试系统的核心函数，所有命中盒可视化都依赖它。
   */
  const computeDebugHitboxes = (fighter: Fighter, joints: Record<keyof Joints, Pt>): DebugHitbox[] => {
    const boxes: DebugHitbox[] = [];
    const prog = fighter.clipDur > 0 ? fighter.clipT / fighter.clipDur : 1;
    const atk = ATTACKS[fighter.state];
    const s = fighter.scale;

    // === 受击盒（Hurt - 蓝）：躯干 + 头部 ===
    // 躯干受击盒：骨盆到头部之间的椭圆近似
    const pelvis = joints.pelvis;
    const chest = joints.chest;
    const head = joints.head;
    if (pelvis && chest && head) {
      // 躯干盒（骨盆→胸）
      const torsoCx = (pelvis.x + chest.x) / 2;
      const torsoCy = (pelvis.y + chest.y) / 2;
      const torsoW = Math.abs(chest.x - pelvis.x) + 12 * s;
      const torsoH = Math.abs(chest.y - pelvis.y) + 8 * s;
      boxes.push({
        type: HitboxType.Hurt,
        x: torsoCx - torsoW / 2, y: torsoCy - torsoH / 2,
        w: torsoW, h: torsoH,
        activeRange: [0, 1],
        joint: 'chest',
      });
      // 头部盒
      boxes.push({
        type: HitboxType.Hurt,
        cx: head.x, cy: head.y, r: L.headR * s,
        activeRange: [0, 1],
        joint: 'head',
      });
    }

    // === 格挡盒（Guard - 绿）：格挡状态下扩大防御区域 ===
    if (fighter.state === 'block' && fighter.guardBreak <= 0) {
      if (chest && pelvis) {
        // 格挡盒比受击盒稍大，前伸更多
        const guardExtend = 8 * s * fighter.facing;
        boxes.push({
          type: HitboxType.Guard,
          x: Math.min(pelvis.x, chest.x) - 6 * s + guardExtend,
          y: pelvis.y - 4 * s,
          w: Math.abs(chest.x - pelvis.x) + 20 * s,
          h: Math.abs(chest.y - pelvis.y) + 16 * s,
          activeRange: [0, 1],
        });
      }
    }

    // === 脆弱盒（Vulnerable - 黄）：破防/硬直状态下 ===
    if (fighter.guardBreak > 0 || fighter.stun > 0.1 || fighter.stagger > 0.2) {
      if (chest && pelvis) {
        // 脆弱盒比普通受击盒更大
        const vulnMul = 1 + (fighter.guardBreak > 0 ? 0.4 : 0.2);
        boxes.push({
          type: HitboxType.Vulnerable,
          x: (pelvis.x + chest.x) / 2 - 14 * s * vulnMul,
          y: (pelvis.y + chest.y) / 2 - 20 * s * vulnMul,
          w: 28 * s * vulnMul,
          h: 40 * s * vulnMul,
          activeRange: [0, 1],
        });
      }
    }

    // === 攻击盒（Attack - 红）：当前招式的攻击判定区域 ===
    if (atk && fighter.state !== 'down' && fighter.state !== 'getup') {
      for (const h of atk.hits) {
        // 检查是否在激活范围内（命中帧前后 15% 的窗口内显示）
        const windowStart = h.at - 0.15;
        const windowEnd = h.at + 0.15;
        if (prog >= windowStart && prog <= windowEnd) {
          const part = (h.part ?? atk.part) as keyof Joints;
          const tipLen = (h as any).tipLen ?? 0;
          const ap = attackPoint(fighter, part as StrikePart, tipLen);
          // 攻击盒大小根据 reach 值缩放
          const boxR = (6 + h.reach * 5) * s;
          boxes.push({
            type: HitboxType.Attack,
            cx: ap.x, cy: ap.y, r: boxR,
            activeRange: [windowStart, windowEnd],
            joint: part,
          });
        }
      }
    }

    // === 投射物盒（Projection - 青）=== （如果有弹道在飞行中）
    const myProjectiles = projectiles.filter(p => p.owner === fighters.indexOf(fighter));
    for (const proj of myProjectiles) {
      boxes.push({
        type: HitboxType.Projection,
        cx: proj.x, cy: proj.y, r: 5 * s,
        activeRange: [0, 1],
      });
    }

    // === 传感器盒（Sensor - 紫）：地面检测 ===
    if (joints.footB && joints.footF) {
      // 地面传感器：检测双脚是否着地
      const groundY_val = groundY();
      for (const footKey of ['footB', 'footF'] as (keyof Joints)[]) {
        const foot = joints[footKey];
        if (foot && foot.y >= groundY_val - 4) {
          boxes.push({
            type: HitboxType.Sensor,
            cx: foot.x, cy: groundY_val - 2,
            r: 4 * s,
            activeRange: [0, 1],
            joint: footKey,
          });
        }
      }
    }

    return boxes;
  };

  /**
   * 更新洋葱皮/鬼帧历史记录。
   * 每帧调用一次，将当前姿态存入历史队列，并淡出/移除旧帧。
   * 性能注意：仅在 debugOptions.onionSkin 为 true 时才应调用此函数。
   */
  const updateOnionSkin = (fighter: Fighter) => {
    const cfg = debugOptions.onionConfig ?? { maxGhosts: 5, fadeRate: 0.03 };
    // 获取当前关节世界坐标
    let joints: Record<keyof Joints, Pt>;
    if (fighter.state === 'down' && fighter.ragdoll) {
      joints = fighter.ragdoll as unknown as Record<keyof Joints, Pt>;
    } else {
      joints = place(fighter).world;
    }

    // 添加新帧（初始完全不透明）
    fighter.poseHistory.push({
      joints: { ...joints } as any,
      t: elapsed,
      alpha: 1.0,
    });

    // 淡出所有历史帧
    for (let i = 0; i < fighter.poseHistory.length; i++) {
      fighter.poseHistory[i].alpha -= cfg.fadeRate;
    }

    // 移除完全透明的历史帧，并限制最大数量
    fighter.poseHistory = fighter.poseHistory.filter(g => g.alpha > 0.01);
    if (fighter.poseHistory.length > cfg.maxGhosts) {
      fighter.poseHistory = fighter.poseHistory.slice(-cfg.maxGhosts);
    }
  };

  /**
   * 绘制洋葱皮/鬼帧叠加层。
   * 在角色身后绘制半透明的姿态历史轨迹。
   */
  const drawOnionSkin = (ctx: CanvasRenderingContext2D, fighter: Fighter) => {
    const cfg = debugOptions.onionConfig ?? { maxGhosts: 5, fadeRate: 0.03, color: 'rgba(100,180,255,ALPHA)' };
    const baseColor = cfg.color.replace('ALPHA', '1'); // 用于描边

    for (const ghost of fighter.poseHistory) {
      const alpha = ghost.alpha * 0.35; // 整体降低最大不透明度
      ctx.globalAlpha = alpha;

      // 绘制鬼帧骨骼轮廓（简化版：只画主要骨连线）
      const bonePairs: [keyof Joints, keyof Joints][] = [
        ['pelvis', 'chest'], ['chest', 'head'],
        ['shoulderB', 'elbowB'], ['elbowB', 'handB'],
        ['shoulderF', 'elbowF'], ['elbowF', 'handF'],
        ['hipB', 'kneeB'], ['kneeB', 'footB'],
        ['hipF', 'kneeF'], ['kneeF', 'footF'],
      ];

      ctx.strokeStyle = baseColor;
      ctx.lineWidth = 1;
      for (const [a, b] of bonePairs) {
        const pa = ghost.joints[a];
        const pb = ghost.joints[b];
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };

  /**
   * 绘制 6 色命中盒叠加层。
   * 遵循 SF6/GGPO 工具标准配色方案。
   */
  const drawDebugHitboxes = (ctx: CanvasRenderingContext2D, boxes: DebugHitbox[]) => {
    for (const box of boxes) {
      const colors = HITBOX_COLORS[box.type];
      ctx.fillStyle = colors.fill;
      ctx.strokeStyle = colors.stroke;
      ctx.lineWidth = 1.8;

      if (box.cx !== undefined && box.cy !== undefined && box.r !== undefined) {
        // 圆形命中盒
        ctx.beginPath();
        ctx.arc(box.cx, box.cy, box.r, 0, TAU);
        ctx.fill();
        ctx.stroke();

        // 类型标签
        if (debugOptions.hitboxDetail !== 'simple') {
          ctx.font = 'bold 9px ui-monospace, monospace';
          ctx.fillStyle = colors.stroke;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(HITBOX_LABELS[box.type], box.cx, box.cy - box.r - 2);
        }
      } else if (box.x !== undefined && box.y !== undefined && box.w !== undefined && box.h !== undefined) {
        // 矩形命中盒
        ctx.beginPath();
        ctx.rect(box.x, box.y, box.w, box.h);
        ctx.fill();
        ctx.stroke();

        // 类型标签
        if (debugOptions.hitboxDetail !== 'simple') {
          ctx.font = 'bold 9px ui-monospace, monospace';
          ctx.fillStyle = colors.stroke;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(HITBOX_LABELS[box.type], box.x + 2, box.y - 2);
        }
      }
    }
  };

  /**
   * 绘制 SF6 风格调试 HUD。
   * 显示双方斗士的状态、HP、位置、帧数据、连招信息等。
   * 布局模仿 SF6 训练模式 HUD：
   *   ┌─────────────────────────────┐
   *   │ P1 [name]     HP: 100/100  │
   *   │ State: idle    Frame: 042  │
   *   │ Pos: (320, 420) Facing: →  │
   *   │ Combo: 3 hits  Damage: 45  │
   *   ├─────────────────────────────┤
   *   │ P2 [name]     HP: 87/100   │
   *   │ ...
   */
  const drawSF6HUD = (ctx: CanvasRenderingContext2D, W: number, H: number) => {
    const PAD = 10;
    const LINE_H = 17;
    const BOX_W = 260;
    const BOX_H = fighters.length * (LINE_H * 5 + 12) + 16;

    // 背景
    ctx.save();
    ctx.fillStyle = 'rgba(10,8,6,0.85)';
    ctx.fillRect(PAD, PAD, BOX_W, BOX_H);
    ctx.strokeStyle = 'rgba(255,200,100,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD, PAD, BOX_W, BOX_H);

    // 标题栏
    ctx.fillStyle = 'rgba(255,200,100,0.9)';
    ctx.font = 'bold 11px ui-monospace, "Cascadia Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('⬡ DEBUG HUD  [SF6 Style]', PAD + 8, PAD + 5);

    // 分隔线
    ctx.beginPath();
    ctx.moveTo(PAD, PAD + 22);
    ctx.lineTo(PAD + BOX_W, PAD + 22);
    ctx.strokeStyle = 'rgba(255,200,100,0.25)';
    ctx.stroke();

    let y = PAD + 28;

    for (let fi = 0; fi < fighters.length; fi++) {
      const f = fighters[fi];
      const prog = f.clipDur > 0 ? (f.clipT / f.clipDur * 100).toFixed(1) : '-';

      // 角色名 + HP 条
      ctx.fillStyle = f.skin.body;
      ctx.font = 'bold 12px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(`P${fi + 1} ${f.name}`, PAD + 8, y);

      // HP 数值
      ctx.fillStyle = '#E0E0E0';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`HP:${Math.round(f.hp)}/${f.maxHp}`, PAD + BOX_W - 8, y);
      ctx.textAlign = 'left';

      // HP 条背景
      y += LINE_H;
      const hpBarW = BOX_W - 16;
      const hpBarH = 8;
      const hpRatio = Math.max(0, f.hp / f.maxHp);
      ctx.fillStyle = 'rgba(40,35,30,0.8)';
      ctx.fillRect(PAD + 8, y, hpBarW, hpBarH);
      // HP 条填充（颜色随血量变化）
      const hpColor = hpRatio > 0.5 ? '#4CAF50' : hpRatio > 0.25 ? '#FF9800' : '#F44336';
      ctx.fillStyle = hpColor;
      ctx.fillRect(PAD + 8, y, hpBarW * hpRatio, hpBarH);

      // 状态行
      y += LINE_H + 2;
      ctx.fillStyle = '#C8B896';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(`State: ${f.state.padEnd(14)} Frame: ${String(frameStepCtrl.currentFrame).padStart(4, ' ')}`, PAD + 8, y);

      // 位置 + 面向
      y += LINE_H;
      ctx.fillStyle = '#9A8A6A';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(
        `Pos: (${f.x.toFixed(0)}, ${groundY().toFixed(0)})  Face:${f.facing > 0 ? '→' : '←'}  Scale:${f.scale.toFixed(2)}`,
        PAD + 8, y
      );

      // 架势 + 硬直
      y += LINE_H;
      const guardStr = `Guard:${f.guard.toFixed(0)}%${f.guardBreak > 0 ? ' [BREAK!]' : ''}`;
      const stunStr = f.stun > 0 ? `  Stun:${f.stun.toFixed(2)}s` : '';
      ctx.fillText(`${guardStr}${stunStr}`, PAD + 8, y);

      // 连招信息
      y += LINE_H;
      if (f.comboSteps && f.comboSteps.length > 0) {
        const comboStr = f.comboSteps.map((s, i) =>
          i === f.comboIndex ? `[${s}]` : s
        ).join(' → ');
        ctx.fillStyle = '#FFD54F';
        ctx.fillText(`Combo: ${comboStr}`, PAD + 8, y);
      } else {
        ctx.fillStyle = '#666';
        ctx.fillText('Combo: -', PAD + 8, y);
      }

      y += 10; // 角色间距
    }

    // 底部：帧步进状态 + 控制提示
    if (debugOptions.frameStep) {
      y += 4;
      ctx.beginPath();
      ctx.moveTo(PAD, y);
      ctx.lineTo(PAD + BOX_W, y);
      ctx.strokeStyle = 'rgba(255,200,100,0.2)';
      ctx.stroke();
      y += 6;

      ctx.fillStyle = frameStepCtrl.paused ? '#FF5722' : '#4CAF50';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.fillText(
        `${frameStepCtrl.paused ? '⏸ PAUSED' : '▶ PLAY'}  Speed:${frameStepCtrl.speed.toFixed(1)}x  Frame:${frameStepCtrl.currentFrame}/${frameStepCtrl.totalFrames}`,
        PAD + 8, y
      );
      y += LINE_H;
      ctx.fillStyle = '#666';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText('[Pause] .→  ,←  [] speed  [Space] toggle pause', PAD + 8, y);
    }

    ctx.restore();
  };

  /**
   * 设置帧步进键盘监听器。
   * 快捷键：
   *   Pause/Break 或 Space: 暂停/继续
   *   . (period):           单帧前进
   *   , (comma):            单帧后退
   *   [:                    减速
   *   ]:                    加速
   */
  const setupFrameStepKeys = () => {
    const opt = { signal: keyAbort.signal };
    window.addEventListener('keydown', (e) => {
      // 仅在帧步进模式下响应
      if (!debugOptions.frameStep) return;

      switch (e.code) {
        case 'Pause':
          frameStepCtrl.paused = !frameStepCtrl.paused;
          e.preventDefault();
          break;
        case 'Period': // . → 前进一帧
          if (frameStepCtrl.paused) {
            frameStepCtrl.stepForward = true;
          }
          e.preventDefault();
          break;
        case 'Comma': // , ← 后退一帧
          if (frameStepCtrl.paused) {
            frameStepCtrl.stepBackward = true;
          }
          e.preventDefault();
          break;
        case 'BracketLeft': // [ 减速
          frameStepCtrl.speed = Math.max(0.1, frameStepCtrl.speed - 0.25);
          e.preventDefault();
          break;
        case 'BracketRight': // ] 加速
          frameStepCtrl.speed = Math.min(5.0, frameStepCtrl.speed + 0.25);
          e.preventDefault();
          break;
        case 'Space': // 暂停切换（不在手动模式下时生效）
          if (!opts.manual) {
            frameStepCtrl.paused = !frameStepCtrl.paused;
            e.preventDefault();
          }
          break;
      }
    }, opt);
  };

  // 如果启用了帧步进模式，注册键盘监听
  if (debugOptions.frameStep) {
    setupFrameStepKeys();
  }

  /** 大规模检测用计数器（引擎内部统计，比从外面看状态可靠） */
  const stats = { attacks: 0, hits: 0, whiffs: 0, blocks: 0, breaks: 0, downs: 0, nonlethalDowns: 0, lethalDowns: 0, deaths: 0 };
  /** 决策落盘：输入观测 + 实际动作 + 增强元数据，行为克隆 / 复盘直接可用（环形保留最近 4000 条） */
  const trace: {
    t: number;
    who: number;
    build: string;
    snap: FightSnapshot;
    decision: string;
    /** 置信度：0~1，越高表示 AI 对该决策越确定 */
    confidence: number;
    /** 决策来源：direct=直接决策 / buffer=缓冲区消费 / react=投射物反应 / buffer-evade=闪避消费等 */
    source: string;
    /** 决策时自身的 HP 和 Guard 状态 */
    hp: number;
    guard: number;
    /** 决策时是否在连招中 */
    inCombo: boolean;
    /** 当前的 intentLock 剩余时间（承诺窗口状态） */
    intentLockRemaining: number;
  }[] = [];
  let elapsed = 0;
  /** 手动模式按键表（AbortController 便于 destroy 时一次性移除监听） */
  const keys = new Set<string>();
  const keyAbort = new AbortController();
  if (opts.manual) {
    const opt = { signal: keyAbort.signal };
    window.addEventListener('keydown', (e) => {
      keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    }, opt);
    window.addEventListener('keyup', (e) => keys.delete(e.code), opt);
  }
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
    fsm: new FsmProcess(fighterFsmConfig),
    clipT: 0,
    clipDur: CLIPS.idle.dur,
    pose: { ...IDLE_A },
    hitDone: [],
    landedHit: false,
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
    pdController: null,
    aggression: rand(0.45, 0.95),
    guardChance: rand(0.35, 0.75),
    // 偏好距离：由行为 archetype 自动计算（zoner 远 / rusher 近 / 其余中距），
    // 替代原来手写的 rand(34, 42)，让每个流派的站位更有区分度
    preferDist: computePreferDist(GEAR_SPEC[(i % 2 === 0 ? 'swordsman' : 'ranger') as Gear].behavior),
    intentLock: 0,
    perceiveLag: rand(0.06, 0.2),
    noise: 0.5,
    noiseT: 0,
    sinceAttack: 0,
    disengage: 0,
    counterWindow: 0,
    guard: 100,
    guardBreak: 0,
    guardDelay: 0,
    blockT: 0,
    leap: 0,
    rollDir: 1,
    comboTimer: 0,
    comboSteps: null,
    comboIndex: 0,
    pendingCombo: null,
    name: '',
    enterT: 0,
    enterDur: 0.8,
    downTimer: 0,
    landSquash: 0,
    ragdoll: null,
    links: [],
    getupFade: 0,
    lastDecision: 0,
    kb: 0,
    stagger: 0,
    knockdown: false,
    armFront: 'F',
    sway: 0,
    invuln: 0,
    minX: 20,
    maxX: 9999,
    poseHistory: [],
    /* ---- 输入缓冲与帧数据系统初始化 ---- */
    inputBuffer: new InputBuffer(),
    currentFrameData: null,
    attackPhase: 'none' as AttackPhase,
    decisionHistory: [],
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
      fighters.push(f);
      // 启动 FSM：进入初始状态（system.idle → hitReaction.idle → combat.idle → locomotion.idle）
      f.fsm.dispatch('').catch(() => {});
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
      const entering = (a && a.enterT > 0) || (b && b.enterT > 0);
      if (a) {

        a.x = cx - (entering ? 80 : a.preferDist / 2);

        a.facing = 1;

        a.minX = cx - half;

        a.maxX = cx + half;

      }
      if (b) {

        b.x = cx + (entering ? 80 : b.preferDist / 2);

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
  const burstFx = (key: string, x: number, y: number, facing: number, blocking: boolean, phase = 0, tint?: string) => {
    const fx = FX_SPEC[key];
    if (!fx) return;
    const col = blocking ? '#9AD9FF' : fx.color;
    // 流派专属配色：环/线保持招式色，火花染成角色配色 —— 同一招不同流派看起来不一样
    const sparkCol = blocking ? '#9AD9FF' : (tint ?? fx.color);
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
      sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 55 * pw, life, max: rand(0.13, 0.28), color: sparkCol, size: rand(1.6, 3.6), kind: 'hit' });
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
    let pose = f.pose;

    /* ---- Foot IK：蹲下/受击时保持脚掌贴地（可选增强） ---- */
    // 当角色下蹲（lift <= 0 且 legLB < 0 表示屈膝）时，
    // 用 Two-Bone IK 调整腿部角度使脚不穿透地面
    if (f.pose.lift <= 0 && (f.pose.legLB < -0.3 || f.pose.legLF < -0.3)) {
      const jRaw = fk(pose, f.facing < 0);
      // 找到位置更低的脚（支撑脚），计算它离地面的距离
      const supportFoot = jRaw.footF.y >= jRaw.footB.y ? 'footF' : 'footB';
      const supportHip = supportFoot === 'footF' ? 'hipF' : 'hipB';
      const supportKnee = supportFoot === 'footF' ? 'kneeF' : 'kneeB';
      // 目标：脚应该在地面高度（y = groundY() - lift 偏移）
      // IK 在局部坐标空间工作，地面相对于骨盆的位置
      const groundLocalY = 0; // 简化：假设地面在骨盆下方约 thigh + shin 的距离处
      const hip = jRaw[supportHip as keyof Joints];
      const footTarget: Pt = { x: jRaw[supportFoot as keyof Joints].x, y: Math.max(jRaw[supportFoot as keyof Joints].y, hip.y + L.thigh + L.shin - 1), z: 0 };
      // 只有当脚明显低于自然伸展位置时才应用 IK
      if (footTarget.y > jRaw[supportFoot as keyof Joints].y + 0.5) {
        const ik = twoBoneIK(hip, footTarget, L.thigh, L.shin, 1);
        if (ik.reachable) {
          // 创建姿态副本，修改对应腿的角度
          const modPose = { ...pose };
          if (supportFoot === 'footF') {
            modPose.legUF = ik.angle1;
            modPose.legLF = ik.angle2 - Math.PI; // 转换为相对角度
          } else {
            modPose.legUB = ik.angle1;
            modPose.legLB = ik.angle2 - Math.PI;
          }
          pose = modPose;
        }
      }
    }

    const j = fk(pose, f.facing < 0);
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
  /** 攻击点：手/脚/肘/膝，或沿前臂刚性延伸的武器尖端，或链锤甩球 */
  const attackPoint = (attacker: Fighter, part: StrikePart, tipLen = 0): Pt => {
    const aw = place(attacker).world;
    if (tipLen === -1) {
      const tr = attacker.trinket;
      if (tr && !Number.isNaN(tr.x)) return tr;
      tipLen = 14; // 演示定位时链球还没甩出去，用手前 14px 近似
    }
    const hand = aw[part as keyof Joints];
    if (tipLen > 0) {
      const elbowKey = part === 'handB' ? 'elbowB' : part === 'handF' ? 'elbowF' : null;
      if (elbowKey) {
        const elbow = aw[elbowKey as keyof Joints];
        const dx = hand.x - elbow.x;
        const dy = hand.y - elbow.y;
        const d = Math.hypot(dx, dy) || 1;
        const len = tipLen * attacker.scale * (GEAR_SPEC[attacker.build]?.bulk ?? 1);
        return { x: hand.x + (dx / d) * len, y: hand.y + (dy / d) * len, z: hand.z };
      }
    }
    return hand;
  };

  /* ============================================================
   * 统一距离计算模块
   * ------------------------------------------------------------
   * 问题：原来有三套互不兼容的距离尺度：
   *   ① contactCheck 用「攻击部位↔躯干线段」的最短距离（FK 关节间距）
   *   ② threatRange = reachOf() 用「骨盆中心距 + 9*reach*scale」
   *   ③ preferDist = 手写的 28~46 纯中心距
   * 导致 AI 以为"安全"其实站在对手枪口上，或反向挥空。
   *
   * 统一方案：所有距离都以**双方骨盆（中心点）距离**为基准，
   * 通过固定换算系数转换到「接触距离 / 威胁距离 / 偏好距离」。
   * ============================================================ */

  /** 距离类型枚举 */
  enum DistanceType {
    /** 接触距离：攻击部位真正碰到目标的容差（原 contactCheck 的 7*reach*scale） */
    CONTACT = 'contact',
    /** 威胁距离：招式的最大有效命中半径（原 reachOf 的 9*reach*scale） */
    THREAT = 'threat',
    /** 偏好距离：AI 想要站位的中心距（原 preferDist） */
    PREFER = 'prefer',
  }

  /** 各距离类型的换算配置（系数 × reach × scale） */
  const DISTANCE_CONFIG = {
    /** 接触判定容差系数 —— 命中盒约等于一个拳头宽度 */
    [DistanceType.CONTACT]: { coeff: 7, description: '接触判定' },
    /** 威胁半径系数 —— 比 contact 宽一点，用于 AI 预判"这招够不够得着" */
    [DistanceType.THREAT]: { coeff: 9, description: '威胁半径' },
  } as const;

  /**
   * 统一距离计算：基于骨盆中心距，换算到指定类型
   * @param centerDist 双方骨盆（中心点）的像素距离
   * @param type 目标距离类型
   * @param reach 招式的 reach 值（ATTACKS[].reach，通常 0.8~1.75）
   * @param scale 目标的体型缩放（Fighter.scale，通常 0.94~1.06）
   * @returns 该类型对应的距离阈值
   */
  const computeDistance = (
    centerDist: number,
    type: DistanceType.CONTACT | DistanceType.THREAT,
    reach: number,
    scale: number,
  ): number => {
    const cfg = DISTANCE_CONFIG[type];
    return cfg.coeff * reach * scale;
  };

  /**
   * 根据行为 archetype 自动计算偏好距离
   * 替代 ROSTER 和 mk() 里手写的 preferDist 数值
   */
  const computePreferDist = (behavior: GearSpec['behavior']): number => {
    const ranges: Record<GearSpec['behavior'], [number, number]> = {
      zoner:     [40, 48],  // 远程风筝流：站最远，用投射物/长柄牵制
      rusher:    [28, 34],  // 突进贴脸流：最近，双刀/战斧狂战士
      turtle:    [34, 40],  // 防守反击流：中近距，盾卫等机会
      punisher:  [32, 38],  // 惩戒流：中距，等破绽再打
      trickster: [30, 36],  // 巧变流：中近距，忍者/醉拳游走
      brawler:   [28, 32],  // 肉搏流：最近，武僧/链锤贴身压制
    };
    const [lo, hi] = ranges[behavior];
    return rand(lo, hi);
  };

  const contactCheck = (attacker: Fighter, target: Fighter, reachMul: number, part: StrikePart, tipLen = 0): { hit: boolean; at: Pt } => {
    const tw = place(target).world;
    const fist = attackPoint(attacker, part, tipLen);
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
    // 命中容差：使用统一距离系统（DistanceType.CONTACT → coeff=7）
    // reach 通常在 0.8~1.2，scale≈1.15，所以实际容差约 6.4~9.7px，接近一个拳头的宽度
    const threshold = computeDistance(d, DistanceType.CONTACT, fistReach, target.scale);
    return { hit: d <= threshold, at: { x: cx, y: cy } };
  };

  /* ---------- 状态切换（HFSM 分层状态机） ---------- */

  /**
   * 分层状态机核心函数：setStateHFSM（基于 @statewalker/fsm）
   *
   * 实现逻辑：
   * 1. 同态早退优化（避免反复 setState('idle') 重置动画）
   * 2. 将 State 枚举映射为 FSM 事件，通过 dispatch 驱动 @statewalker/fsm 状态转换
   * 3. 同步执行所有状态副作用（clipT、clipDur、hitDone 等）
   * 4. 异步派发 FSM 事件（fire-and-forget，不 await）
   *
   * @param f      目标角色
   * @param newState 目标状态
   * @param dur     可选的动画持续时间
   * @param options 选项
   * @returns 是否成功执行了状态转换
   */
  const setStateHFSM = (
    f: Fighter,
    newState: State,
    dur?: number,
    options?: {
      force?: boolean;        // 强制转换（用于受击等不可拒绝的情况）
      cancelType?: string;    // 取消类型（保留接口兼容）
      source?: string;        // 调用来源（日志用）
    },
  ): boolean => {
    const { force = false, source = 'unknown' } = options ?? {};

    // 同态早退：AI 每 0.1s 重决策时会反复 setState('idle'/'block')，
    // 原来每次都把 clipT 倒回 0，待机动画永远停在第 0 帧 = 看着像卡住
    if (f.state === newState && (dur === undefined || dur === f.clipDur)) return false;

    // 查找对应 FSM 事件
    const event = STATE_EVENT_MAP[newState];
    if (!event && !force) {
      // 无映射事件且非强制 → 不合法转换，静默拒绝（向后兼容）
      return false;
    }

    // ===== 执行状态转换副作用 =====

    // 起跳同时进入闪避无敌帧（保留原有行为）
    if (newState === 'jump') f.invuln = 0.34;

    // 更新扁平 state（向后兼容 — 所有读取 f.state 的代码不受影响）
    f.state = newState;
    f.clipT = 0;
    f.clipDur = dur ?? CLIPS[newState]?.dur ?? 0.3;
    f.hitDone = [];
    f.landedHit = false;
    f.pendingCombo = null;

    // 通过 FSM 引擎派发事件（异步 fire-and-forget）
    // FSM 层负责跟踪嵌套状态层级，状态副作用已同步完成
    if (event && f.fsm) {
      f.fsm.dispatch(event).catch((err: Error) => {
        // FSM 转换失败时静默处理（保持向后兼容）
        if (source !== 'unknown') {
          console.warn(`[HFSM] Transition failed: ${f.state} --[${event}]--> ?`, err.message);
        }
      });
    }

    return true;
  };

  /**
   * 向后兼容的 setState 包装器：
   * 所有原有调用点无需修改，内部委托给 setStateHFSM
   *
   * 保持与原 setState 完全相同的签名和外部行为。
   * 新代码应优先使用 setStateHFSM 以获得完整的 HFSM 能力。
   */
  const setState = (f: Fighter, s: State, dur?: number) => {
    setStateHFSM(f, s, dur, { source: 'legacy-setState' });
  };

  const startRagdoll = (f: Fighter, lethal = f.hp <= 0) => {
    // 死因只能由命中结算时的 hp<=0 决定。普通击退/投技只倒地，起身继续战斗。
    if (lethal) stats.lethalDowns++;
    else stats.nonlethalDowns++;
    stats.downs++;
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

  /** 每招的真实命中距离（双方中心距，像素）：用骨骼几何现场标定并缓存。
   *  与 contactCheck 完全同源 = 出招部位的世界坐标 + 统一距离系统(DistanceType.THREAT, coeff=9)。
   *  原来的 threatRange = 36*reach 是拍脑袋常数，和实际命中判定对不上，
   *  于是 AI 以为"我在安全距离"其实一直站在对手枪口上（也会反向挥空）。 */
  const reachCache: Record<string, number> = {};
  const reachOf = (move: string): number => {
    const cached = reachCache[move];
    if (cached !== undefined) return cached;
    const a = ATTACKS[move];
    const clip = CLIPS[move];
    const probe = fighters[0];
    if (!a || !clip || !probe) return 34;
    // 借 0 号斗士当量尺，量完原样还回去（place 是纯函数，同帧内恢复，不影响渲染）
    const sx = probe.x;
    const sp = probe.pose;
    const sf = probe.facing;
    let best = 26;
    probe.x = 0;
    probe.facing = 1;
    for (const h of a.hits) {
      probe.pose = sampleClip(clip, h.at);
      const part = place(probe).world[(h.part ?? a.part) as keyof Joints];
      if (part) {
        // 使用统一距离系统（DistanceType.THREAT → coeff=9），与 contactCheck 的 coeff=7 形成明确层级
        const threatExtension = computeDistance(0, DistanceType.THREAT, h.reach, probe.scale);
        best = Math.max(best, part.x + threatExtension);
      }
    }
    probe.x = sx;
    probe.pose = sp;
    probe.facing = sf;
    reachCache[move] = best;
    return best;
  };

  /** 招式的起手/命中/收招节奏（片段归一化进度） */
  const movePhase = (s: string) => {
    const a = ATTACKS[s];
    if (!a) return null;
    let first = 1;
    let last = 0;
    for (const h of a.hits) {
      first = Math.min(first, h.at);
      last = Math.max(last, h.at);
    }
    return { first, last, reach: reachOf(s) };
  };

  const snapshot = (f: Fighter, opp: Fighter | undefined): FightSnapshot => {
    const ph = opp ? movePhase(opp.state) : null;
    // 感知延迟：我看到的对手永远慢 perceiveLag 秒，不再是 100% 精确读帧的全知 AI
    const lag = f.perceiveLag;
    const rawProg = opp && opp.clipDur > 0 ? opp.clipT / opp.clipDur : 0;
    const prog = Math.max(0, rawProg - lag / Math.max(0.001, opp?.clipDur ?? 1));
    // 距离估计带 ±6% 噪声（每 0.5s 才变一次，避免每帧抖动导致抽搐）
    const dist = (opp ? Math.abs(opp.x - f.x) : 999) * (0.94 + f.noise * 0.12);
    return {
      self: { hp: f.hp, x: f.x, state: f.state, distance: dist },
      opponent: {
        hp: opp?.hp ?? 100,
        x: opp?.x ?? 0,
        state: opp?.state ?? 'idle',
        // 起手：任意攻击招的命中帧之前 —— 这是「他要打过来了」的信号
        windingUp: !!ph && prog < ph.first * 1.02,
        // 收招：最后一个命中帧之后 —— 这是可以抢进去打的破绽
        recovering: !!ph && prog > ph.last + 0.05,
        // 威胁半径：由 reachOf 按真实骨骼几何标定，与命中判定同一套尺度
        threatRange: ph ? ph.reach : 34,
        /** 对手剩余架势（0~100，见底就能破防） */
        guard: opp?.guard ?? 100,
        /** 对手是否正处于破防硬直（此时挨打更疼） */
        guardBreak: (opp?.guardBreak ?? 0) > 0,
      },
      // 朝我飞来的投射物，按到达时间排序，最近的在前（含 kind 供 AI 区分 bolt/shuriken）
      incoming: projectiles
        .filter((p) => p.owner !== fighters.indexOf(f) && Math.sign(p.vx) === Math.sign(f.x - p.x))
        .map((p) => ({ x: p.x, y: p.y, vx: p.vx, eta: Math.abs(f.x - p.x) / Math.max(1, Math.abs(p.vx)), kind: p.kind }))
        .sort((a, b) => a.eta - b.eta)
        .slice(0, 3),
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

  /** 流派专属连招：招牌招要能被接连段，而不是所有人共用那 5 条拳脚 */
  const GEAR_COMBOS: Partial<Record<Gear, string[][]>> = {
    swordsman: [['cross', 'iai'], ['jab', 'cross', 'iai']],
    samurai: [['palm', 'iai'], ['cross', 'iai']],
    spear: [['thrust', 'pushKick'], ['thrust', 'thrust']],
    shield: [['bash', 'uppercut'], ['bash', 'hook']],
    dagger: [['slash', 'slash'], ['slash', 'hook']],
    monk: [['palm', 'elbow'], ['palm', 'snapKick']],
    hammer: [['smash', 'pushKick'], ['hook', 'smash']],
    viking: [['swing', 'axeKick'], ['hook', 'swing']],
    gunner: [['bolt', 'pushKick']],
    ranger: [['bolt', 'pushKick']],
    ninja: [['shuriken', 'snapKick'], ['slash', 'snapKick']],
    drunk: [['palm', 'elbow'], ['elbow', 'palm']],
    flail: [['flailSwing', 'roundKick']],
    puppeteer: [['gearPunch', 'cross'], ['gearPunch', 'uppercut']],
  };

  /** 霸体招：抡砸/横扫/链锤/机关拳/后旋踢在起手后段不怕轻击打断 */
  const ARMOR_MOVES = new Set(['smash', 'swing', 'flailSwing', 'gearPunch', 'spinKick']);
  const hasArmor = (f: Fighter) => {
    if (!ARMOR_MOVES.has(f.state) || f.clipDur <= 0) return false;
    const p = f.clipT / f.clipDur;
    return p > 0.25 && p < 0.72;
  };

  /** 招式元数据已提升为模块级统一系统（MOVE_META / _MOVE_META_FULL），
   *  此处不再重复定义。pickAttack 等函数直接使用外层 MOVE_META。
   * 旧的手动对齐表已被 buildMoveMeta() 自动聚合替代。 */

  /** 招式层：按距离筛选 + 效用函数打分 + 加权随机 */
  const pickAttack = (f: Fighter, d: number, opp: FightSnapshot['opponent'] | null): Decision => {
    const inRange = (k: string) => {
      const a = ATTACKS[k];
      if (!a) return false;
      if (a.projectile) return d > 26; // 弹道招别贴脸放
      // 用真实标定射程筛招，不再用 36/56/28 这些和命中判定对不上的硬阈值
      return d <= reachOf(k) + (a.forward ? 30 : 12);
    };
    let pool = ATTACK_KEYS.filter(inRange);
    // 兜底：距离太极端时也不能"无招可出"（无招可出 = 两人贴脸干瞪眼的根因之一）
    if (!pool.length) pool = [...ATTACK_KEYS];
    // 流派专属招式入池且加权：本流的招牌该多用（枪兵多突刺、矮匠多抡砸）
    // 但同样要过距离筛选 —— 否则枪兵会在 70px 外空刺，看起来就是乱挥
    const spec = GEAR_SPEC[f.build];
    const own = (spec.moves ?? []).filter((k) => ATTACKS[k] && inRange(k) && !pool.includes(k));
    const list = own.length || pool.length ? [...own, ...pool] : ['jab'];
    const weights = list.map((k) => {
      const a = ATTACKS[k];
      const meta = MOVE_META[k];
      const power = a.hits.reduce((s, h) => s + (h.dmg[0] + h.dmg[1]) / 2, 0);
      // 基础：伤害越高概率越低（重招稀有）；连击招再打折
      let w = Math.max(0.3, 24 / power) * (a.hits.length > 1 ? 0.75 : 1);
      if (spec.moves.includes(k)) w *= 1.9;
      if (spec.behavior === 'punisher' && power >= 18) w *= 1.5; // 惩罚型偏爱重招，一下换一套
      if (spec.behavior === 'brawler' && (meta?.fast || a.close)) w *= 1.4; // 压制型偏爱快招近招

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
    let r = random() * total;
    for (let i = 0; i < list.length; i++) {
      r -= weights[i];
      if (r <= 0) return list[i] as Decision;
    }
    return list[0] as Decision;
  };

  /** 本地启发式 AI：走位 / 格挡 / 闪避 / 追击 / 残血撤退 / 按局面选招 */
  const HURT_STATES = ['hurtLight', 'hurtHeavy', 'hurtUp', 'hurtLeg', 'stumble'];

  const heuristic = (snap: FightSnapshot, f: Fighter): Decision => {
    const d = snap.self.distance;
    const opp = snap.opponent;
    const oppWinding = opp.windingUp;
    // 我正站在对手这招够得到的范围里（+缓冲）
    const inThreat = d < opp.threatRange + 8;
    // 生态位节奏分化：盾卫蹲守、狂战扑脸、巧变流爱跳
    const behavior = GEAR_SPEC[f.build].behavior;
    if (behavior === 'trickster' && random() < 0.07) return 'jump';
    // 破防硬直中举不起盾 —— 这时只能挨打或后撤
    const canBlock = f.guardBreak <= 0;
    // 低架势不再"硬禁止举盾"（guard<=18 就禁止 = 永远打不到 0，破防被保险丝熔断），
    // 改成低架势时更倾向于后撤、但仍可能举盾赌一把，GUARD BREAK 才真的会发生
    const guardUp = (v: number) => (canBlock && (f.guard > 18 || random() < 0.55) ? 'block' : 'retreat');

    /* ⓪·五 看见箭/星镖朝我飞来：跳起躲或举盾，不再站着硬吃（snapshot.incoming）
     *  bolt 高伤慢速 → 优先举盾；shuriken 低伤高速 → 优先跳跃闪避 */
    const inc = snap.incoming[0];
    if (inc && inc.eta < 0.34) {
      // bolt 伤害高（13~20）→ 更倾向举盾抵消；shuriken 伤害低（8~13）且更快 → 跳跃更划算
      if (inc.kind === 'bolt' && canBlock && random() < 0.65) return 'block';
      if (inc.kind === 'shuriken' && random() < 0.6) return 'jump';
      // 兜底：按原逻辑随机选
      return random() < 0.5 ? 'block' : 'jump';
    }

    /* ⓪ 被压到边角：意识到危险 → 跳过对手头顶换边脱困 */
    const cornered = f.x <= f.minX + 44 || f.x >= f.maxX - 44;
    if (cornered && d < 46 && f.cool <= 0 && random() < 0.5) return 'jump';

    /* ① 感知对方起手 → 撤出他的射程（间合博弈：不硬吃，先拉开） */
    if (oppWinding && inThreat) {
      const r = random();
      if (behavior === 'turtle') {
        if (r < 0.5) return guardUp(0);
        if (r < 0.78) return 'retreat';
      } else {
        if (r < 0.26) return 'retreat'; // 主动拉开距离
        if (r < 0.26 + f.guardChance * 0.8) return guardUp(0);
        if (r < 0.52) return 'roll'; // 翻滚脱离（带无敌帧，被压角落会向前滚换边）
        if (r < 0.6) return 'crouch'; // 下蹲躲上段
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
    /* ③·二 出招饥饿：超过 1.1s 没出手且冷却好了，就必须打。
       之前一堆"试探/等待/游走"分支会把出招无限稀释，表现就是两人贴脸却半天没一招 */
    if (f.cool <= 0 && f.sinceAttack > 0.9 && d < 70) return pickAttack(f, d, opp);

    /* ③·三 强制脱离期：刚打完一套，主动拉开喘口气（节奏 = 试探→交换→脱离） */
    if (f.disengage > 0) return d < f.preferDist + 16 ? 'retreat' : 'wait';

    if (behavior === 'rusher' && f.cool <= 0 && d < 46 && random() < 0.3) return pickAttack(f, d, opp);

    /* ③·五 剩下三种性格之前是摆设，现在真的分流：
       brawler 贴身压制 / zoner 站射程带上放风筝 / punisher 没破绽就按兵不动 */
    if (behavior === 'brawler' && f.cool <= 0 && d < f.preferDist + 12 && random() < 0.6) return pickAttack(f, d, opp);
    if (behavior === 'zoner') {
      const ideal = Math.max(f.preferDist, 46); // 风筝流的站位就是比近战流远一截
      const band = ideal + 18;
      if (d < ideal - 10) {
        // 被贴身：用招顶开或后撤，不跟你拼近身
        if (f.cool <= 0 && random() < 0.5) return pickAttack(f, d, opp);
        return random() < 0.8 ? 'retreat' : 'wait';
      }
      if (d < band) {
        if (f.cool <= 0) return random() < 0.8 ? pickAttack(f, d, opp) : 'wait';
        // 冷却中在射程带上游走（不压上去，也不干站着）
        const rz = random();
        return d > ideal + 6 && rz < 0.45 ? 'approach' : rz < 0.75 ? 'retreat' : 'wait';
      }
    }
    if (behavior === 'punisher' && f.cool <= 0 && d < f.preferDist + 12 && random() < 0.45) return 'wait';

    /* ④ 间合试探（footsies）：站在对手射程边缘，进退交替寻找进场时机 */
    const edge = opp.threatRange + 10;
    // 拉得太开：两边各自发呆就没戏看了，必须压回去
    if (d > 76) return 'approach';
    if (!inThreat && d < edge + 8 && f.cool > 0) {
      // 冷却中不便出手 —— 在射程外一圈游走；但已经明显偏远时以贴近为主，别越走越远
      const far = d > f.preferDist + 15;
      return random() < (far ? 0.85 : 0.52) + f.aggression * 0.2 ? 'approach' : 'retreat';
    }

    // 对手招式已经出手（随时可能命中）：大概率防御，攻防才有来有回
    if (!!ATTACKS[opp.state] && d < 46 && random() < Math.min(0.95, f.guardChance * 1.25)) return guardUp(0);
    // 近身却还在冷却（出不了手）：举盾等机会，别干站着挨打
    if (d < 38 && f.cool > 0 && random() < f.guardChance * 0.7) return guardUp(0);

    // 太远：靠近
    if (d > f.preferDist + 9) return 'approach';
    // 残血谨慎：偶尔退开
    if (f.hp < 32 && random() < 0.35) return 'retreat';
    // 贴太近：拉开一点（避免两人黏在一起）
    if (d < f.preferDist - 8) return random() < 0.6 ? 'retreat' : 'wait';
    // 在攻击距离内：按距离 + 性格 + 局面选招
    if (f.cool <= 0) {
      if (random() < 0.1) return 'jump';
      return pickAttack(f, d, opp);
    }
    return 'wait';
  };

  const decide = (f: Fighter, opp: Fighter | undefined): Decision => {
    if (!opp) return 'wait';
    const snap = snapshot(f, opp);
    // 手动模式：左侧角色由键盘直接驱动，攻击受冷却限制、走位/格挡不受限
    if (opts.manual && fighters[0] === f) {
      const canAct = f.cool <= 0;
      const left = keys.has('KeyA') || keys.has('ArrowLeft');
      const right = keys.has('KeyD') || keys.has('ArrowRight');
      const oppRight = !opp || opp.x >= f.x;
      if (keys.has('KeyU')) return 'block';
      if (canAct && (keys.has('KeyW') || keys.has('ArrowUp'))) return 'jump';
      if (keys.has('KeyS') || keys.has('ArrowDown')) return 'crouch';
      if (canAct && keys.has('KeyL')) return 'roll';
      if (canAct && keys.has('KeyJ')) return 'jab';
      if (canAct && keys.has('KeyK')) return (GEAR_SPEC[f.build].moves[0] ?? 'cross') as Decision;
      if (canAct && keys.has('Space')) return 'counterStrike';
      if (oppRight ? right : left) return 'approach';
      if (oppRight ? left : right) return 'retreat';
      return 'wait';
    }
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
        f.intentLock = 0.22; // 决定了逼近就先走完这几步，别下一帧又反悔
        break;
      case 'retreat':
        setState(f, 'retreat', rand(0.28, 0.5));
        f.intentLock = 0.3;
        break;
      case 'block':
        // 破防中举不起盾，改成后撤（低架势是否举盾由 heuristic 的 guardUp 决定）
        if (f.guardBreak > 0) {
          setState(f, 'retreat', rand(0.3, 0.5));
          break;
        }
        setState(f, 'block');
        f.cool = Math.max(f.cool, 0.25);
        f.intentLock = 0.25;
        break;
      case 'jump': {
        setState(f, 'jump');
        f.cool = rand(0.4, 0.9);
        // 被逼到边角 + 对手贴身：直接跳过他头顶换到另一侧（有意识的脱困，走位不瞬移）
        const o2 = fighters[f.partner];
        const d2 = o2 ? Math.abs(o2.x - f.x) : 99;
        const cornered = f.x <= f.minX + 52 || f.x >= f.maxX - 52;
        f.leap = cornered && o2 && d2 < 48 ? (o2.x >= f.x ? 1 : -1) * 175 : 0;
        break;
      }
      case 'crouch':
        // 下蹲：骨盆→头这条受击线段整体变低，上段攻击自然打空（不用另写闪避判定）
        setState(f, 'crouch');
        break;
      case 'roll': {
        setState(f, 'roll');
        f.cool = Math.max(f.cool, 0.3);
        f.invuln = 0.3;
        const o3 = fighters[f.partner];
        const d3 = o3 ? Math.abs(o3.x - f.x) : 99;
        const cornered3 = f.x <= f.minX + 52 || f.x >= f.maxX - 52;
        // 被压角落就向前滚穿过去换边，否则向后滚脱离
        f.rollDir = cornered3 && o3 && d3 < 48 ? 1 : -1;
        f.leap = f.facing * f.rollDir * 165;
        break;
      }
      case 'wait':
        setState(f, 'idle');
        f.intentLock = 0.12;
        break;
      default: {
        // 其余都是 ATTACKS 里的招式
        const name = d as string;
        if (ATTACKS[name]) {
          setState(f, name as State);
          f.cool = rand(0.3, 0.85);
          f.sinceAttack = 0;
          stats.attacks++;
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
  const keepDistance = (f: Fighter, dt: number) => {
    const opp = fighters[f.partner];
    if (!opp) return;
    // 腾空时允许从对手头顶越过 —— 这是正当的「跳越换位」，不是穿模
    if (f.state === 'jump' || opp.state === 'jump') return;
    // 出招 / 倒地时放宽到「不重叠」即可（推得太狠会卡住突进招，让它打不到）
    const fighting = ATTACKS[f.state] || ATTACKS[opp.state] || f.state === 'down' || f.state === 'stumble';
    // 站架/走位时保持更明显的间距：原来 21px 太近，两个人几乎贴在一起。
    // 加到 26px 让角色之间有清晰的"间合感"，符合武打的视觉距离。
    const minGap = (fighting ? 16 : 26) * Math.max(f.scale, opp.scale);
    const dx = f.x - opp.x;
    const ad = Math.abs(dx);
    if (ad < minGap) {
      const s = dx === 0 ? (f.facing >= 0 ? -1 : 1) : Math.sign(dx);
      // 软推：逐帧挤开。原来直接赋值坐标 = 一帧挪几十像素，看着就是穿模 + 闪现
      const need = minGap - ad;
      f.x += s * Math.min(need, need * dt * 18 + 2.5 * dt);
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
    { key: 'thrust', name: '⑳ 突刺 Thrust（长枪直取）', kind: 'attack', gap: 96 },
    { key: 'smash', name: '㉑ 抡砸 Smash（大锤下劈）', kind: 'attack', gap: 56 },
    { key: 'bash', name: '㉒ 盾击 Bash（盾面推撞）', kind: 'attack', gap: 48 },
    { key: 'slash', name: '㉓ 连斩 Slash（双刃两段）', kind: 'attack', gap: 50 },
    { key: 'palm', name: '㉔ 推掌 Palm（整掌前送）', kind: 'attack', gap: 44 },
    { key: 'swing', name: '㉕ 横扫 Swing（战斧大弧）', kind: 'attack', gap: 66 },
    { key: 'iai', name: '㉖ 拔刀斩 Iai（居合一闪）', kind: 'attack', gap: 88 },
    { key: 'flailSwing', name: '㉗ 链锤 Flail（抡链砸击）', kind: 'attack', gap: 48 },
    { key: 'gearPunch', name: '㉘ 机关拳 Gear Punch（活塞重拳）', kind: 'attack', gap: 54 },
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
    { key: 'roll', name: '㉛ 翻滚 Roll（团身滚翻）', kind: 'jump' },
    { key: 'knee', name: '㉟ 膝击 Knee（提膝顶撞）', kind: 'attack', gap: 40 },
    { key: 'throw', name: '㊱ 投技 Throw（抓住抡出·破格挡）', kind: 'attack', gap: 40 },
    { key: 'counterStrike', name: '㊲ 反击 Counter（侧让反打）', kind: 'attack', gap: 56 },
    { key: 'crouch', name: '㉜ 下蹲 Crouch（躲上段）', kind: 'react' },
    { key: 'tired', name: '㉝ 喘息 Tired（残血弯腰）', kind: 'react' },
    { key: 'hurtLeg', name: '㉞ 受击·腿（屈膝踉跄）', kind: 'react' },
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
    // 演示站位距离：每招不同，再按英雄体型(scale)和武器维度(bulk)缩放
    const demoGap = ((e.gap ?? 60) * a.scale * (GEAR_SPEC[a.build]?.bulk ?? 1)) / 2;
    a.x = cx - demoGap;
    a.facing = 1;
    a.kb = 0;
    a.hp = a.maxHp;
    a.ragdoll = null;
    a.pose = { ...GUARD };
    a.state = 'idle';
    a.clipT = 0;
    a.clipDur = CLIPS.idle.dur;

    d.x = cx + demoGap;
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
      const atk0 = ATTACKS[e.key];
      const h0 = atk0?.hits[0];
      if (atk0 && h0 && !atk0.projectile) {
        // 自动把目标摆到「命中帧攻击点」：每招/每英雄都算，不再手调距离
        const clip0 = CLIPS[e.key] ?? CLIPS.idle;
        const savedX = a.x;
        const savedPose = a.pose;
        a.x = a.x + a.facing * (atk0.forward ?? 0) * h0.at * clip0.dur;
        a.pose = sampleClip(clip0, h0.at);
        const ap = attackPoint(a, h0.part ?? atk0.part, h0.tip ?? 0);
        a.x = savedX;
        a.pose = savedPose;
        d.x = ap.x + 7 * d.scale; // 7px：进入所有招的命中阈值(9~11px)内，又贴住躯干表面
      }
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
    elapsed += dt;

    // ── 帧步进控制：暂停时跳过物理/状态更新 ──
    if (debugOptions.frameStep && frameStepCtrl.paused) {
      // 暂停状态下：仅处理单帧步进请求，不更新正常时间流
      if (frameStepCtrl.stepForward) {
        frameStepCtrl.stepForward = false;
        // 执行一帧的更新（用固定小 dt）
        const stepDt = 1 / 60;
        elapsed += stepDt;
        // 下面继续执行正常更新逻辑...
      } else if (frameStepCtrl.stepBackward) {
        frameStepCtrl.stepBackward = false;
        // 后退帧：暂不支持真正回退（需要状态快照），仅重置计数
        frameStepCtrl.currentFrame = Math.max(0, frameStepCtrl.currentFrame - 1);
        return; // 跳过本帧渲染以外的更新
      } else {
        // 完全暂停：只更新洋葱皮（视觉），不更新游戏状态
        if (debugOptions.onionSkin) {
          for (const f of fighters) updateOnionSkin(f);
        }
        frameStepCtrl.totalFrames = Math.max(frameStepCtrl.totalFrames, frameStepCtrl.currentFrame);
        return;
      }
    }

    // 应用播放速度（帧步进模式下生效）
    const effectiveDt = (debugOptions.frameStep ? frameStepCtrl.speed : 1.0) * dt;

    // 更新帧计数器
    if (debugOptions.frames || debugOptions.full) {
      frameStepCtrl.currentFrame++;
      frameStepCtrl.totalFrames = Math.max(frameStepCtrl.totalFrames, frameStepCtrl.currentFrame);
    }

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

    // ── 洋葱皮/鬼帧更新（仅在启用时执行，性能隔离）──
    if (debugOptions.onionSkin) {
      for (const f of fighters) updateOnionSkin(f);
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
          const lethal = target.hp <= 0;
          popups.push({ x: p.x, y: p.y - 22, text: '-' + dmg, life: 0, max: 0.9, color: blocking ? '#6BA8D6' : '#E23B2E' });
          burstFx(p.kind === 'bolt' ? 'bolt' : 'shuriken', p.x, p.y, Math.sign(p.vx), blocking);
          if (!blocking) {
            stats.hits++;
            target.flash = 1;
            target.kb = Math.sign(p.vx) * p.knock;
            target.sway = 0.55;
            if (!lethal) {
              setState(target, p.kind === 'bolt' ? 'hurtHeavy' : 'hurtLight');
              target.stagger = p.kind === 'bolt' ? 0.4 : 0.22;
              target.stun = p.kind === 'bolt' ? 0.42 : 0.2;
              target.cool = Math.max(target.cool, 0.3);
            }
          }
          // 投射物也必须当场走同一条死亡流程，不能血量为 0 还站着等下一拳。
          if (lethal) startRagdoll(target, true);
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
      f.sinceAttack += dt;
      f.noiseT -= dt;
      if (f.noiseT <= 0) { f.noiseT = 0.5; f.noise = random(); }
      if (f.disengage > 0) f.disengage = Math.max(0, f.disengage - dt);
      if (f.intentLock > 0) f.intentLock = Math.max(0, f.intentLock - dt); // 承诺窗口倒计时
      // 架势：破防硬直中先不回复；举着盾回得慢，站架/走动回得快
      if (f.guardBreak > 0) {
        f.guardBreak = Math.max(0, f.guardBreak - dt);
        if (f.guardBreak === 0) f.guard = 52;
      } else if (f.guardDelay > 0) {
        // 刚被打在盾上：架势冻结不回。否则格挡把双方弹开、重新接近的间隙架势就回满了，
        // 破防永远差最后一下（实测 60s 架势最低 3 却 0 次破防，就是这个原因）
        f.guardDelay = Math.max(0, f.guardDelay - dt);
      } else {
        // 举着盾时架势不再回复：连续压制才压得破（原来 block 中也 +3/s，破防几乎打不出来）
        f.guard = Math.min(100, f.guard + (f.state === 'block' ? 0 : 8) * dt);
      }
      // 举盾有时限：不能一直举着当铁桶，超时自动放下并进入短暂冷却
      if (f.state === 'block') {
        f.blockT += dt;
        if (f.blockT > 0.8) {
          setState(f, 'idle');
          f.cool = Math.max(f.cool, 0.32);
          f.blockT = 0;
        }
      } else {
        f.blockT = 0;
      }
      if (f.enterT > 0) {
        const before = f.enterT;
        f.enterT = Math.max(0, f.enterT - dt);
        if (before > 0 && f.enterT <= 0) f.landSquash = 1; // 落地瞬间下蹲缓冲
      }
      if (f.landSquash > 0) f.landSquash = Math.max(0, f.landSquash - dt * 4);
      if (f.comboTimer > 0) f.comboTimer -= dt;
      if (f.comboTimer <= 0) { f.comboSteps = null; f.comboIndex = 0; }
      if (f.sway !== 0) {
        f.sway *= Math.exp(-dt * 7);
        if (Math.abs(f.sway) < 0.02) f.sway = 0;
      }
      // 面对面：非出招/非走位时始终朝向对手（跨过对手换边后会自动转身）
      const oppF = fighters[f.partner];
      if (oppF && !ATTACKS[f.state] && f.state !== 'approach' && f.state !== 'retreat' && f.state !== 'jump' && f.state !== 'down') {
        f.facing = oppF.x >= f.x ? 1 : -1;
      }
      // 腾空位移（跳越换位）：全程有速度、有衰减，落地时已到另一侧
      if (f.leap !== 0) {
        f.x += f.leap * dt;
        f.leap *= Math.exp(-dt * 2.1);
        if (Math.abs(f.leap) < 10) f.leap = 0;
        f.x = Math.max(f.minX, Math.min(f.maxX, f.x));
      }
      if (f.kb !== 0) {
        f.x += f.kb * dt;
        // 衰减越慢 = 飞得越远（原来 -9 太快，打完几乎没位移）
        f.kb *= Math.exp(-dt * 7.2);
        if (Math.abs(f.kb) < 3) f.kb = 0;
        f.x = Math.max(f.minX, Math.min(f.maxX, f.x));
      }

      /* --- 倒地（区分「被击倒」和「被打死」：以前混为一谈，重击倒地就按阵亡换人 = 异常死亡） --- */
      if (f.state === 'down') {
        f.downTimer += dt;
        stepRagdoll(f, dt);
        const dead = f.hp <= 0;
        if (f.downTimer > (dead ? 1.3 : 0.7)) {
          if (dead && opts.endless !== false) {
            // 真的战死：无限模式换下一个随机挑战者（登场动画 + 姓名）
            stats.deaths++;
            f.ragdoll = null;
            f.hp = f.maxHp;
            f.getupFade = 0;
            f.state = 'idle';
            f.pose = { ...GUARD };
            f.clipT = 0;
            f.clipDur = CLIPS.idle.dur;
            f.cool = rand(0.6, 1.4);
            f.stagger = 0;
            applyRoster(f, ROSTER[Math.floor(random() * ROSTER.length)]);
          } else {
            // 只是被击倒（hp>0）：躺一下撑地起身接着打，不换人、不回血
            f.ragdoll = null;
            if (dead) f.hp = f.maxHp; // 有限模式的演示：阵亡也满血起身
            f.knockdown = false;
            setState(f, 'getup');
            // 用 getup 第一帧(LIE_BACK)初始化 pose，避免从 ragdoll 散架姿态突变闪现
            f.pose = { ...LIE_BACK };
            f.cool = rand(0.5, 1.0);
          }
        }
        continue;
      }
      // getupFade 已移除（不再用 fade-in 模拟起身，直接由关键帧动画驱动）
      // 下蹲是有时限的规避动作，不是一直蹲着
      if (f.state === 'crouch' && f.clipT > 0.6) {
        setState(f, 'idle');
        f.cool = Math.max(f.cool, 0.12);
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
        const rush = oppRec || f.comboTimer > 0 || d > f.preferDist + 22;
        if (f.state === 'approach' && d > f.preferDist && f.clipT < 3.5) {
          f.x += f.facing * (rush ? 104 : 54) * dt;
          f.walkPhase += dt * 1.9;
          f.pose = lerpPose(f.pose, walkPose(f.walkPhase), 1 - Math.exp(-dt * 22));
        } else if (f.state === 'retreat' && f.clipT < f.clipDur) {
          // 后撤是短暂的规避动作：要撤得干脆，一脚退出对手射程
          f.x -= f.facing * 54 * dt;
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
      const clip = (f.state === 'idle' && f.hp < 30 ? CLIPS.tired : CLIPS[f.state]) ?? CLIPS.idle; // 残血弯腰喘
      const prog = f.clipDur > 0 ? f.clipT / f.clipDur : 1;
      const targetPose = sampleClip(clip, prog);
      f.pose = lerpPose(f.pose, targetPose, 1 - Math.exp(-dt * 30));

      /* --- PD 控制器：程序化受击反应叠加（可选增强） --- */
      // 如果角色启用了 PD 控制器且当前激活，将 PD 修正量混合到姿态上
      // 默认 pdController = null，不走此分支，行为与原来完全一致
      if (f.pdController && f.pdController.active) {
        f.pose = updatePDReaction(f.pdController, f.pose, dt);
      }

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
          f.landedHit = true; // 箭已出手，不按挥空惩罚（中不中看投射物碰撞）
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

          const { hit, at } = contactCheck(f, opp, h.reach, h.part ?? atk.part, h.tip ?? 0);
          if (!hit) {
            // 够不着 = 挥空
            spawn(at.x + f.facing * 12, at.y, 'rgba(120,120,120,0.45)', 'dust', 3, 0.4);
            continue;
          }

          // 架势值系统：格挡要付出代价，撑不住就破防（破防中无法格挡且挨打更疼）
          f.landedHit = true; // 打到人了（含被格挡），不算挥空
          const meta0 = MOVE_META[f.state];
          const guarding = opp.state === 'block' && opp.guardBreak <= 0 && !atk.throw; // 投技不可格挡
          const broken = opp.guardBreak > 0;
          // counter hit：打在对手起手途中（他这一下还没出来）= 破招，加伤加硬直
          const oppPhHit = movePhase(opp.state);
          const oppProgHit = opp.clipDur > 0 ? opp.clipT / opp.clipDur : 1;
          const isCounter = !!oppPhHit && !guarding && oppProgHit < oppPhHit.first;
          // 对拼 trade：对手这招也已经过了命中帧 = 互换，不改数值只给演出
          const isTrade = !!oppPhHit && !guarding && !isCounter;
          // 部位受击：按命中点在对手躯干上的高度分头/身/腿三段
          const oppWorld = place(opp).world;
          const zone = at.y < oppWorld.chest.y - 4 ? 'head' : at.y > oppWorld.pelvis.y + 3 ? 'leg' : 'body';
          const zoneMul = zone === 'head' ? 1.15 : zone === 'leg' ? 0.85 : 1;
          const mul = (guarding ? (meta0?.breakGuard ? 0.62 : 0.34) : broken ? 1.6 : 1) * (isCounter ? 1.35 : 1) * zoneMul;
          const dmg = Math.round(rand(h.dmg[0], h.dmg[1]) * mul);
          opp.hp = Math.max(0, opp.hp - dmg);
          popups.push({ x: at.x + rand(-6, 6), y: at.y - 26, text: '-' + dmg, life: 0, max: 0.9, color: guarding ? '#6BA8D6' : broken ? '#FFD24A' : isCounter ? '#FF9A3C' : '#E23B2E' });
          if (isCounter) popups.push({ x: at.x, y: at.y - 44, text: 'COUNTER', life: 0, max: 0.8, color: '#FF9A3C' });
          else if (isTrade) popups.push({ x: at.x, y: at.y - 44, text: 'TRADE', life: 0, max: 0.6, color: '#C9C9C9' });
          // 每招专属打击特效 + 流派配色（同一招不同流派颜色不同）
          burstFx(f.state, at.x, at.y, f.facing, guarding, 0, f.skin.trim);

          if (guarding) {
            stats.blocks++;
            // 格挡扣架势：重招、破防招扣得多
            const cost = (meta0?.breakGuard ? 80 : 54) * (h.knock > 300 ? 1.4 : 1);
            opp.guard -= cost;
            opp.guardDelay = 1.6; // 压制窗口：这段时间内再打在盾上会继续削架势
            const broke = opp.guard <= 0;
            spawn(at.x, at.y, broke ? '#FFD24A' : '#9AD9FF', 'block', broke ? 13 : 6, broke ? 1.5 : 0.8);
            opp.kb = f.facing * (h.knock > 300 ? 180 : 135); // 格挡也会被压退，不是钉在原地
            opp.sway = 0.3;
            opp.counterWindow = 0.16;
            f.comboSteps = null;
            f.kb = -f.facing * 72;
            hitstop = Math.max(hitstop, 0.03);

            if (broke) {
              stats.breaks++;
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
          stats.hits++;
          // 大伤害：击退更远 + 标记「站不稳要倒地」
          const bigHit = h.knock > 320;
          opp.kb = f.facing * (h.knock + (bigHit ? 170 : 0));
          if (bigHit) opp.knockdown = true;
          if (atk.throw) opp.knockdown = true; // 投技命中必倒
          opp.sway = h.knock > 320 ? 1 : 0.55;
          f.comboTimer = 0.45;
          // hitstop 按伤害缩放：这一下越疼，冻结越久
          hitstop = Math.max(hitstop, Math.min(0.22, atk.hitstop * (0.7 + dmg / 26)));

          if (opp.hp <= 0) {
            spawn(at.x, at.y, '#FAC901', 'hit', 14, 1.6);
            startRagdoll(opp, true);
            break;
          }

          // 被打断：对手的连招清零
          opp.comboSteps = null;
          opp.comboIndex = 0;

          // 连招：命中后按连招表接下一段
          if (f.comboSteps) {
            const nextIdx = f.comboIndex + 1;
            if (nextIdx < f.comboSteps.length && random() < 0.7) {
              f.comboIndex = nextIdx;
              f.cool = 0;
              f.intentLock = 0;
              f.pendingCombo = f.comboSteps[nextIdx]; // 等过了取消点再切，收招被"取消"掉
            } else {
              f.comboSteps = null;
              f.comboIndex = 0;
              f.disengage = rand(0.45, 0.85); // 一套打完：强制脱离，拉开喘口气
            }
          } else if (random() < (opp.stagger >= 0.35 ? 0.9 : 0.45)) {
            // 优先流派专属连招（居合收招、突刺接蹬腿…），没有再抽通用拳脚连
            const gc = GEAR_COMBOS[f.build];
            const steps = gc && gc.length ? gc[Math.floor(random() * gc.length)] : COMBOS[Math.floor(random() * COMBOS.length)].steps;
            f.comboSteps = steps;
            f.comboIndex = 0;
            f.cool = 0;
            f.intentLock = 0;
            f.pendingCombo = steps[0];
          } else if (random() < 0.5) {
            f.disengage = rand(0.45, 0.85); // 不接连招时也可能主动脱离，形成攻防节奏
          }

          // 霸体：重招起手后段不吃轻击硬直（照样掉血），只有重击/破招才打得断
          if (hasArmor(opp) && atk.react === 'light' && !isCounter) {
            popups.push({ x: at.x, y: at.y - 58, text: 'ARMOR', life: 0, max: 0.5, color: '#B9C4D6' });
            opp.stun = Math.max(opp.stun, 0.06);
            continue;
          }

          // 按招式 + 部位决定反应：头=仰头、身=弓身、腿=屈膝踉跄；counter 加深硬直
          opp.stagger = atk.react === 'light' ? 0.22 : 0.4;
          const reactState = zone === 'leg' && atk.react === 'light' ? 'hurtLeg' : atk.react === 'up' || zone === 'head' ? 'hurtUp' : atk.react === 'heavy' ? 'hurtHeavy' : 'hurtLight';
          setState(opp, reactState as State);
          opp.stun = (atk.react === 'light' ? 0.2 : atk.react === 'up' ? 0.5 : 0.42) + (isCounter ? 0.18 : 0);
          opp.cool = Math.max(opp.cool, 0.3);
          // PD 控制器：如果角色启用了 PD 受击增强，激活程序化反应
          // （pdController 非 null 时启用；默认为 null 保持原有行为不变）
          if (opp.pdController) {
            const pdPreset = reactState === 'hurtLeg' ? 'leg' : reactState === 'hurtUp' ? 'up' : reactState === 'hurtHeavy' ? 'heavy' : 'light';
            activatePDReaction(opp, pdPreset, isCounter ? 1.3 : 1.0);
          }
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
        if (f.stagger > 0 && (f.state === 'hurtLight' || f.state === 'hurtHeavy' || f.state === 'hurtUp' || f.state === 'hurtLeg')) {
          f.stagger = 0;
          setState(f, 'stumble');
          f.cool = Math.max(f.cool, 0.3);
        } else {
          // 大伤害踉跄结束：站不住，向后倒
          if (f.knockdown) {
            f.knockdown = false;
            startRagdoll(f);
          } else {
            // 挥空惩罚：整招没碰到人（含被闪避）就收招更慢，给对手一个确反窗口。
            // 原来打空只有一撮灰尘、零代价，是"贴脸互殴"节奏的根源之一。
          const whiff = !!atk && !f.landedHit;
          if (whiff) stats.whiffs++;
          setState(f, 'idle');
            f.cool = Math.max(f.cool, whiff ? 0.5 : rand(0.25, 0.8));
            // 打完一招后自动触发短后撤（disengae）：创造"进→打→退→试探"的武打节奏，
            // 避免两人一直贴脸互殴。连击中不退（保持压制），挥空才多退。
            if (!f.disengage) {
              f.disengage = whiff ? rand(0.35, 0.6) : rand(0.15, 0.35);
            }
          }
        }
      }

      /* --- 做决策（自主模式下自动出手，演示模式下关闭） --- */
      // 走位 / 举盾中也允许反悔重新判断 —— 否则「走着走着看见对方起手再躲」永远来不及
      const THINKABLE = f.state === 'idle' || f.state === 'approach' || f.state === 'retreat' || f.state === 'block';
      if (!opts.demo && THINKABLE) {
        f.cool -= dt;
        f.lastDecision += dt;
        // 站着时反应快，移动/举盾中反应慢一点（避免抽搐式反复横跳）
        const gap = f.state === 'idle' ? 0.14 : 0.24;
        // 出招冷却只限制"出招"，不限制"走位/格挡"。
        if (f.stun <= 0 && f.lastDecision > gap) {
          f.lastDecision = 0;
          // 承诺窗口（intentLock 已激活）：刚决定走位/举盾就坚持一下
          const ph2 = opp ? movePhase(opp.state) : null;
          const prog2 = opp && opp.clipDur > 0 ? opp.clipT / opp.clipDur : 1;
          const mustReact = !!opp && !!ph2 && prog2 < ph2.first && Math.abs(opp.x - f.x) < ph2.reach + 8;

          /* ===== 新流程：decide → pushToBuffer → tryConsumeBuffer → execute ===== */
          const decision = decide(f, opp);
          const now = elapsed;

          // 计算置信度（基于决策类型和局面紧迫性）
          let confidence = 0.7; // 默认置信度
          if (mustReact) confidence = 0.95; // 必须反应时高置信度
          else if (decision === 'jab' || decision === 'snapKick' || decision === 'palm') confidence = 0.8; // 快招高置信度
          else if (decision === 'spinKick' || decision === 'flyKick' || decision === 'iai') confidence = 0.55; // 大招低置信度

          // 推入输入缓冲区
          f.inputBuffer.push(decision, confidence, now);

          // 尝试从缓冲区消费决策
          let executedDecision: Decision | null = null;
          let executionSource = 'buffer';

          if (f.intentLock <= 0 || mustReact || f.state === 'idle') {
            // ---- 优先级 1: 投射物闪避（最高优先级反应） ----
            const snapForEvade = snapshot(f, opp);
            const incoming = snapForEvade.incoming[0];
            if (incoming && incoming.eta < 0.34) {
              const evaded = f.inputBuffer.consume((d) =>
                d === 'roll' || d === 'crouch' || d === 'jump' || d === 'block'
              );
              if (evaded) {
                executedDecision = evaded.decision;
                executionSource = 'buffer-evade';
              } else {
                // 缓冲中没有闪避指令时直接用当前决策（如果它是闪避类）
                if (decision === 'roll' || decision === 'crouch' || decision === 'jump' || decision === 'block') {
                  executedDecision = decision;
                  executionSource = 'react';
                }
              }
            }

            // ---- 优先级 2: 攻击决策消费 ----
            if (!executedDecision && f.cool <= 0) {
              const isAttack = (d: Decision): boolean =>
                d !== 'approach' && d !== 'retreat' && d !== 'block' &&
                d !== 'wait' && d !== 'jump' && d !== 'crouch' && d !== 'roll';

              // 如果当前决策是攻击且在取消窗口内（连招场景），优先消费攻击
              if (isAttack(decision) && f.comboTimer > 0) {
                const bufferedAtk = f.inputBuffer.consume(isAttack);
                if (bufferedAtk) {
                  executedDecision = bufferedAtk.decision;
                  executionSource = 'buffer-combo';
                }
              }

              // 普通攻击消费
              if (!executedDecision && isAttack(decision)) {
                // 检查缓冲区中是否有更高优先级的攻击（置信度更高的）
                const unconsumed = f.inputBuffer.getUnconsumed(now);
                const bestAtk = unconsumed.filter(isAttack)
                  .sort((a, b) => b.confidence - a.confidence)[0];
                if (bestAtk && bestAtk.confidence >= confidence * 0.9) {
                  bestAtk.consumed = true; // 标记消费
                  executedDecision = bestAtk.decision;
                  executionSource = 'buffer-best';
                } else {
                  executedDecision = decision;
                  executionSource = 'direct';
                }
              }
            }

            // ---- 优先级 3: 移动/防御决策 ----
            if (!executedDecision) {
              const isMove = (d: Decision): boolean =>
                d === 'approach' || d === 'retreat' || d === 'block' || d === 'wait' ||
                d === 'jump' || d === 'crouch' || d === 'roll';
              const bufferedMove = f.inputBuffer.consume(isMove);
              if (bufferedMove) {
                executedDecision = bufferedMove.decision;
                executionSource = 'buffer-move';
              } else {
                executedDecision = decision;
                executionSource = 'direct';
              }
            }
          }

          // 执行最终决策
          if (executedDecision) {
            trace.push({
              t: Number(elapsed.toFixed(2)),
              who: fighters.indexOf(f),
              build: f.build,
              snap: snapshot(f, opp),
              decision: executedDecision,
              confidence: Math.round(confidence * 100) / 100,
              source: executionSource,
              hp: f.hp,
              guard: f.guard,
              inCombo: f.comboTimer > 0 || f.comboSteps !== null,
              intentLockRemaining: Math.round(f.intentLock * 100) / 100,
            });
            if (trace.length > 4000) trace.splice(0, trace.length - 4000);

            // 记录决策历史
            f.decisionHistory.push({
              t: now,
              decision: executedDecision,
              confidence,
              source: executionSource,
              executed: true,
            });
            if (f.decisionHistory.length > 200) f.decisionHistory.splice(0, f.decisionHistory.length - 200);

            applyDecision(f, opp, executedDecision);

            // 出招时计算并缓存帧数据
            const atkRef = ATTACKS[executedDecision];
            if (atkRef) {
              const clipRef = CLIPS[executedDecision as keyof typeof CLIPS];
              if (clipRef) {
                f.currentFrameData = computeFrameData(executedDecision as string, atkRef, clipRef);
              }
            }
          } else {
            // 决策被 intentLock 抑制，仍记录
            f.decisionHistory.push({
              t: now,
              decision,
              confidence,
              source: 'suppressed',
              executed: false,
            });
            if (f.decisionHistory.length > 200) f.decisionHistory.splice(0, f.decisionHistory.length - 200);
          }
        }
      }

      /* ---- 每帧更新攻击阶段 ---- */
      if (f.currentFrameData && ATTACKS[f.state]) {
        const prog = f.clipDur > 0 ? f.clipT / f.clipDur : 1;
        f.attackPhase = getAttackPhase(prog, f.currentFrameData);
        // 招式结束时清除帧数据
        if (prog >= 1) {
          f.currentFrameData = null;
          f.attackPhase = 'none';
        }
      } else if (!ATTACKS[f.state]) {
        f.attackPhase = 'none';
        f.currentFrameData = null;
      }
    }

    // 位置约束：不许穿模
    for (const f of fighters) keepDistance(f, dt);

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
    const et = Math.max(0, Math.min(1, 1 - f.enterT / f.enterDur));
    const enterDrop = f.enterT > 0 ? -70 * f.scale * (1 - et * et) : 0;

    ctx.save();
    ctx.globalAlpha = 0.14 * sh;
    ctx.beginPath();
    ctx.ellipse(f.x, groundY() + 1, 15 * sh * f.scale, 3.4 * sh, 0, 0, TAU);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();

    // 受击挤压：横向张开、纵向压扁
    const ls = f.landSquash || 0;
    const sq = Math.min(1, f.flash);
    ctx.save();
    if (sq > 0.02 || ls > 0.02) {
      const baseY = groundY();
      ctx.translate(f.x, baseY);
      ctx.scale(1 + sq * 0.12 + ls * 0.10, 1 - sq * 0.14 - ls * 0.22);
      ctx.translate(-f.x, -baseY);
    }

    // getup 不再用 fade-in：动作本身已有完整的 躺→坐→跪→站 过渡，
    // 原来 getupFade 从 0 渐显会导致"倒地后消失再闪现"的视觉 bug。
    const alpha = 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (f.enterT > 0) ctx.translate(0, enterDrop);

    // 滚翻：骨架是 2D 的，所以用画布级旋转绕脚下触点转一整圈，配合团身姿态就是前/后滚翻
    if (f.state === 'roll') {
      const p = Math.min(1, f.clipT / Math.max(0.001, f.clipDur));
      const cy = groundY() - 13 * f.scale;
      ctx.translate(f.x, cy);
      ctx.rotate(f.facing * f.rollDir * p * TAU);
      ctx.translate(-f.x, -cy);
    }

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

    // 登场大字名牌已移除：名字只由页面左右上角的角标展示，不再压在角色头上
    if (opts.showNames) {
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

    // ── 增强调试叠加层（多级调试模式）──
    // 性能关键：所有 debug 分支在非调试模式下完全跳过，零开销
    const hasAnyDebug = debugBones || debugOptions.hitboxes || debugOptions.frames || debugOptions.hud || debugOptions.onionSkin;

    if (hasAnyDebug) {
      const BONE_LINKS: [keyof Joints, keyof Joints, string][] = [
        ['pelvis', 'chest', '#E74C3C'],   // 躯干-红
        ['chest', 'head', '#E74C3C'],
        ['shoulderB', 'chest', '#3498DB'], // 后臂-蓝
        ['shoulderB', 'elbowB', '#3498DB'],
        ['elbowB', 'handB', '#3498DB'],
        ['shoulderF', 'chest', '#2ECC71'], // 前臂-绿
        ['shoulderF', 'elbowF', '#2ECC71'],
        ['elbowF', 'handF', '#2ECC71'],
        ['hipB', 'pelvis', '#9B59B6'],     // 后腿-紫
        ['hipB', 'kneeB', '#9B59B6'],
        ['kneeB', 'footB', '#9B59B6'],
        ['hipF', 'pelvis', '#F39C12'],     // 前腿-橙
        ['hipF', 'kneeF', '#F39C12'],
        ['kneeF', 'footF', '#F39C12'],
        // 虚线：跨链辅助线（躯干→膝，帮助判断姿态平衡）
        ['chest', 'kneeB', 'rgba(149,53,206,0.3)'],
        ['chest', 'kneeF', 'rgba(243,156,18,0.3)'],
      ];

      const JOINT_LABELS: [keyof Joints, string][] = [
        ['head', '头'], ['chest', '胸'], ['pelvis', '骨盆'],
        ['shoulderB', '后肩'], ['elbowB', '后肘'], ['handB', '后手'],
        ['shoulderF', '前肩'], ['elbowF', '前肘'], ['handF', '前手'],
        ['hipB', '后髋'], ['kneeB', '后膝'], ['footB', '后脚'],
        ['hipF', '前髋'], ['kneeF', '前膝'], ['footF', '前脚'],
      ];

      for (const f of fighters) {
        let joints: Record<keyof Joints, Pt>;
        // down 状态用 ragdoll 坐标，其他状态用 fk 正向运动学
        if (f.state === 'down' && f.ragdoll) {
          joints = f.ragdoll as unknown as Record<keyof Joints, Pt>;
        } else {
          const { world } = place(f);
          joints = world;
        }

        ctx.save();

        // ── 1. 洋葱皮/鬼帧（在角色身后绘制）──
        if (debugOptions.onionSkin) {
          drawOnionSkin(ctx, f);
        }

        // ── 2. 骨骼显示（原有功能，bones 或 full 模式）──
        if (debugBones || debugOptions.bones) {
          // 绘制骨连线
          for (const [a, b, color] of BONE_LINKS) {
            const pa = joints[a];
            const pb = joints[b];
            if (!pa || !pb) continue;
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.strokeStyle = color;
            ctx.lineWidth = color.includes('rgba') ? 1 : 1.8;
            if (color.includes('rgba')) ctx.setLineDash([3, 3]);
            else ctx.setLineDash([]);
            ctx.stroke();
          }
          ctx.setLineDash([]);

          // 绘制关节点（圆点 + 标签）
          for (const [key, label] of JOINT_LABELS) {
            const pt = joints[key];
            if (!pt) continue;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 3.2, 0, TAU);
            ctx.fillStyle = '#FFFFFF';
            ctx.fill();
            ctx.strokeStyle = '#1a130e';
            ctx.lineWidth = 1.2;
            ctx.stroke();
            ctx.font = '10px ui-monospace, monospace';
            ctx.fillStyle = 'rgba(20,16,12,0.7)';
            ctx.textAlign = 'left';
            ctx.fillText(label, pt.x + 5, pt.y - 4);
          }
        }

        // ── 3. 6色命中盒系统（hitboxes 或 full 模式）──
        if (debugOptions.hitboxes) {
          const boxes = computeDebugHitboxes(f, joints);
          drawDebugHitboxes(ctx, boxes);

          // 攻击部位标记：当前状态是攻击招式时，标出命中点（增强版）
          const atk = ATTACKS[f.state];
          if (atk && f.state !== 'down' && f.state !== 'getup') {
            const prog = f.clipDur > 0 ? f.clipT / f.clipDur : 1;
            for (const h of atk.hits) {
              if (Math.abs(prog - h.at) < 0.12) {
                const ap = attackPoint(f, h.part ?? atk.part, (h as any).tipLen ?? 0);
                ctx.beginPath();
                ctx.arc(ap.x, ap.y, 7, 0, TAU);
                ctx.strokeStyle = HITBOX_COLORS[HitboxType.Attack].stroke;
                ctx.lineWidth = 2.5;
                ctx.stroke();
                ctx.fillStyle = HITBOX_COLORS[HitboxType.Attack].fill;
                ctx.fill();
                ctx.font = 'bold 11px ui-monospace, monospace';
                ctx.fillStyle = HITBOX_COLORS[HitboxType.Attack].stroke;
                ctx.textAlign = 'center';
                ctx.fillText(`⚔ ${h.part ?? atk.part}`, ap.x, ap.y - 12);
              }
            }
          }
        }

        // ── 4. 帧信息显示（frames 或 full 模式）──
        if (debugOptions.frames) {
          const infoY = 58 + fighters.indexOf(f) * 72;
          ctx.font = '11px ui-monospace, "Cascadia Mono", monospace';
          ctx.fillStyle = 'rgba(255,252,240,0.92)';
          ctx.fillRect(8, infoY, 240, 64);
          ctx.strokeStyle = 'rgba(20,16,12,0.2)';
          ctx.lineWidth = 1;
          ctx.strokeRect(8, infoY, 240, 64);
          ctx.fillStyle = '#1a130e';
          ctx.textAlign = 'left';
          const clipName = f.state;
          const clipProg = f.clipDur > 0 ? (f.clipT / f.clipDur * 100).toFixed(1) : '-';
          const poseStr = `lean:${(f.pose.lean||0).toFixed(2)} head:${(f.pose.head||0).toFixed(2)}`;
          ctx.fillText(`[${fighters.indexOf(f)}] ${f.name}  HP:${f.hp.toFixed(0)}/${f.maxHp}`, 14, infoY + 16);
          ctx.fillText(`state=${clipName.padEnd(14)} prog=${String(clipProg).padStart(5)}%  cool=${f.cool.toFixed(2)}s`, 14, infoY + 32);
          ctx.fillText(poseStr, 14, infoY + 48);
          ctx.fillStyle = 'rgba(20,16,12,0.55)';
          ctx.fillText(`face=${f.facing>0?'→':'←'}  x=${f.x.toFixed(0)}  invuln=${f.invuln.toFixed(2)}`, 14, infoY + 62);
        }

        ctx.restore();
      }

      // ── SF6 风格调试 HUD（hud 或 full 模式）──
      if (debugOptions.hud) {
        drawSF6HUD(ctx, W, H);
      }

      // ── 图例（命中盒模式下显示 6 色图例）──
      if (debugOptions.hitboxes) {
        ctx.save();
        const lgX = W - 120;
        const lgY = H - 180;
        ctx.fillStyle = 'rgba(255,252,240,0.92)';
        ctx.fillRect(lgX, lgY, 114, 172);
        ctx.strokeStyle = 'rgba(20,16,12,0.2)';
        ctx.lineWidth = 1;
        ctx.strokeRect(lgX, lgY, 114, 172);
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.fillStyle = '#1a130e';
        ctx.textAlign = 'left';
        ctx.fillText('HITBOX LEGEND', lgX + 8, lgY + 14);

        const hitboxLegends: [HitboxType, string][] = [
          [HitboxType.Attack, 'Attack (攻击盒)'],
          [HitboxType.Hurt, 'Hurt (受击盒)'],
          [HitboxType.Guard, 'Guard (格挡盒)'],
          [HitboxType.Vulnerable, 'Vulnerable (脆弱)'],
          [HitboxType.Sensor, 'Sensor (传感)'],
          [HitboxType.Projection, 'Projection (投射)'],
        ];
        hitboxLegends.forEach(([type, label], i) => {
          const ly = lgY + 30 + i * 22;
          const colors = HITBOX_COLORS[type];
          // 色块
          ctx.fillStyle = colors.fill;
          ctx.fillRect(lgX + 8, ly - 6, 16, 14);
          ctx.strokeStyle = colors.stroke;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(lgX + 8, ly - 6, 16, 14);
          // 标签
          ctx.font = '9px ui-monospace, monospace';
          ctx.fillStyle = colors.stroke;
          ctx.fillText(label, lgX + 30, ly + 5);
        });

        // 骨骼图例（如果同时启用了 bones）
        if (debugBones || debugOptions.bones) {
          const boneLy = lgY + 168;
          ctx.strokeStyle = 'rgba(20,16,12,0.3)';
          ctx.beginPath(); ctx.moveTo(lgX, boneLy); ctx.lineTo(lgX + 114, boneLy); ctx.stroke();
          ctx.font = '9px ui-monospace, monospace';
          ctx.fillStyle = '#666';
          ctx.fillText('BONES: skeleton overlay', lgX + 8, boneLy + 14);
        }

        ctx.restore();
      }

      // ── 传统骨骼图例（仅 bones 模式，无 hitbox 时）──
      if ((debugBones || debugOptions.bones) && !debugOptions.hitboxes) {
        ctx.save();
        const lgX = W - 100;
        const lgY = H - 110;
        ctx.fillStyle = 'rgba(255,252,240,0.9)';
        ctx.fillRect(lgX, lgY, 94, 102);
        ctx.strokeStyle = 'rgba(20,16,12,0.2)';
        ctx.strokeRect(lgX, lgY, 94, 102);
        ctx.font = '10px ui-monospace, monospace';
        const legends = [
          ['━', '#E74C3C', '躯干'],
          ['━', '#3498DB', '后臂'],
          ['━', '#2ECC71', '前臂'],
          ['━', '#9B59B6', '后腿'],
          ['━', '#F39C12', '前腿'],
        ];
        legends.forEach(([sym, col, txt], i) => {
          const ly = lgY + 14 + i * 16;
          ctx.strokeStyle = col;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(lgX + 8, ly); ctx.lineTo(lgX + 26, ly); ctx.stroke();
          ctx.fillStyle = '#1a130e'; ctx.textAlign = 'left'; ctx.fillText(txt, lgX + 32, ly + 4);
        });
        ctx.restore();
      }
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
        build: f.build,
        cool: Number(f.cool.toFixed(2)),
        sinceAttack: Number(f.sinceAttack.toFixed(2)),
        disengage: Number(f.disengage.toFixed(2)),
      })),
    /** 引擎内部计数器：大规模检测用（出招/命中/挥空/格挡/破防/倒地/真阵亡） */
    stats: () => ({ ...stats }),
    /** 决策轨迹（observation + action）：行为克隆的训练数据 */
    trace: () => trace,
    traceClear: () => { trace.length = 0; },
    /** 播种后整局可复现；seed(0) 恢复非确定随机 */
    seed: (n: number) => { rngState = n | 0; },
    /** 结束外部控制，回到本地 AI */
    reset: () => setController(null),
    /** 当前在场角色名（按顺序），供主页角标显示 */
    matchup: () => fighters.map((f) => f.name),
    /** 停止引擎（重新开打前调用） */
    destroy: () => {
      keyAbort.abort();
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
        if (opts.demo) startDemoEntry(demoIdx); // 换英雄后按新体型/武器重排距离
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
