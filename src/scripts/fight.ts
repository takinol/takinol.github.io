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

import { FsmProcess, STATE_ANY, STATE_INITIAL } from '@statewalker/fsm';
import type { FsmStateConfig } from '@statewalker/fsm';

// ── 招式库：每个英雄一份完整副本（见 moves/kits/*.ts）──
import { P } from './moves/types';
import { bladeCenterline, drawKatana } from './katana';
import type { Atk, AtkHit, Clip, Pose, StrikePart } from './moves/types';
import { ALL_ATKS, ALL_CLIPS, HERO_KITS } from './moves';
// ── 装饰挂载 + 布料物理（design-3-deco-cloth.md）：判定层不 import 这里的任何类型（G3）──
import { makeClothChain, stepChain, drawRibbon, bodyCircles, DECO_CFG } from './deco';
import type { Chain, DecoEnv, JointView } from './deco';
// 兼容旧的对外类型导出（原先这些类型定义在本文件里）
export type { Atk, AtkHit, Clip, Pose, StrikePart };

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

/* ============================================================
 * 状态片段（与英雄无关：待机/架势/受击/倒地/翻滚…）
 * 招式片段不在这里 —— 每个英雄的招式姿态在自己的 moves/kits/NN-*.ts 里
 * ============================================================ */
const STATE_CLIPS: Record<string, Clip> = {
  idle: { dur: 2.4, loop: true, keys: [{ t: 0, pose: IDLE_A }, { t: 0.5, pose: IDLE_B }, { t: 1, pose: IDLE_A }] },
  guard: { dur: 0.16, loop: false, keys: [{ t: 0, pose: IDLE_A }, { t: 1, pose: GUARD }] },
  // 举盾要能撑住（原来 0.16s 一闪而过，根本挡不到东西）；由 blockT 时限负责放下
  block: { dur: 0.7, loop: false, keys: [{ t: 0, pose: GUARD }, { t: 0.22, pose: BLOCK }, { t: 1, pose: BLOCK }] },

  // 拳法
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
};

/** 全局片段表：状态片段 + 所有英雄招式片段（供演示页/校验等与英雄无关的工具用；
 *  战斗时用的是 f.clips（= STATE_CLIPS + 本英雄的招式片段）） */
export const CLIPS: Record<string, Clip> = { ...STATE_CLIPS, ...ALL_CLIPS };

/**
 * State 枚举值 → FSM 事件名称映射表（模块级：BOOT_CHECKS 自检要读它）。
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
  lowSlash: 'LOW_SLASH', risingSlash: 'RISING_SLASH',
  palm: 'PALM', swing: 'SWING', iai: 'IAI', flailSwing: 'FLAIL_SWING',
  gearPunch: 'GEAR_PUNCH', bolt: 'BOLT', shuriken: 'SHURIKEN',
  block: 'BLOCK', crouch: 'CROUCH', roll: 'ROLL',
  idle: 'IDLE', walk: 'WALK', approach: 'APPROACH', retreat: 'RETREAT', jump: 'JUMP',
};

/** 战斗状态联合（模块级：STATE_EVENT_MAP 与 BOOT_CHECKS 都要用） */
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
     导致任何 Record<State, X> 的表漏项都不报错 —— 现在补齐，让类型重新能兜底。
     lowSlash/risingSlash 也是这里漏的：连 type State 都没有它们，
     STATE_EVENT_MAP/FX_SPEC 漏登记在类型层完全静默。 */
  | 'thrust'
  | 'smash'
  | 'bash'
  | 'slash'
  | 'lowSlash'
  | 'risingSlash'
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
  cloth: 'cape2' | 'sash' | 'apron' | 'shoulderCape' | 'hoodTail' | 'haori' | 'kilt' | 'coat' | null;
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
 * 物理增强模块：Two-Bone IK / PD Controller
 * （原 KawaiiPhysics 弹簧钟摆整块已删：从建成起零调用点，
 *   布料/挂件物理现在统一走 deco.ts 的柔体链，2026-10-25 审查后清理）
 * ============================================================ */

/** PD 控制器状态：用于程序化受击反应。
 *  ⚠️ @experimental：Fighter.pdController 恒初始化为 null，运行时从未激活。
 *  保留是因为它是「程序化受击」的预留接口；要启用需要在受击入口 activatePDReaction。
 *  若将来仍不启用，整条链路（本接口 + updatePDReaction + activatePDReaction + 字段）一起删。 */
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
export const twoBoneIK = (
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
 * 落地脚的两杆 IK —— fk 的 dir 角度系版（place() 的 Foot-IK 用这个，别直接调 twoBoneIK）。
 *
 * 背景（2026-10-25 步态审查修的 bug）：twoBoneIK 返回 atan2 系角度（0=+x 轴），
 * 而 fk 的 legU/legL 是 dir 系（0=正下方，正=向前）——之前把 atan2 角直接塞进
 * dir 字段，差了 π/2，下蹲/受击时大腿朝上翘、脚离目标 22px，视觉就是"反关节"。
 * bendDir=-1：膝朝角色前方弯（人类膝盖只向前弯；+1 会解出膝在身后的鸟腿）。
 */
export const solveFootIK = (
  hip: Pt,
  foot: Pt,
  len1: number,
  len2: number,
): { u: number; f: number; ok: boolean } => {
  const ik = twoBoneIK(hip, foot, len1, len2, -1);
  // atan2 系 → dir 系：dir 角 a 满足 (sin a, cos a) = (cos a₂, sin a₂)，即 a = π/2 − a₂
  const u = Math.PI / 2 - ik.angle1;
  // 小腿：从膝盖直接指向目标（长度已由 IK 保证可达），绝对方向反解出相对角 f
  const kx = hip.x + Math.sin(u) * len1;
  const ky = hip.y + Math.cos(u) * len1;
  const f = Math.atan2(foot.x - kx, foot.y - ky) - u;
  return { u, f, ok: ik.reachable };
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


/** 全部招式的并集（= 15 个英雄各自的库合并）。
 *  战斗判定/出招读的是 f.atks（本英雄自己的库），这里只作：
 *    · 演示页、数据校验、调试可视化等「与具体英雄无关」的工具兜底
 *    · atkOf(f, s) 在英雄没配某招时的回退 */
export const ATTACKS: Record<string, Atk> = ALL_ATKS;

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
  counterStrike:{ style: 'blade', ring: 20, wide: 2.4, lines: 11, len: 30, color: '#FFC27A', zoom: 0.03, dir: 2.4, sparksN: 11, spread: 0.4 },
  smash:       { style: 'heavy', ring: 30, wide: 3.6, lines: 12, len: 34, color: '#FFC46B', zoom: 0.045, dir: 3.2, sparksN: 16, spread: 1.3 },
  bash:        { style: 'heavy', ring: 22, wide: 3.0, lines: 7,  len: 22, color: '#CFE4FF', zoom: 0.02,  dir: 2.4, sparksN: 9,  spread: 0.5 },
  slash:       { style: 'blade', ring: 16, wide: 2.0, lines: 5,  len: 34, color: '#E8D9FF', zoom: 0.018, dir: 1.8, sparksN: 7,  spread: 0.5 },
  lowSlash:    { style: 'blade', ring: 15, wide: 2.0, lines: 6,  len: 28, color: '#D9F2E4', zoom: 0.014, dir: 1.6, sparksN: 7,  spread: 0.35 },
  risingSlash: { style: 'blade', ring: 18, wide: 2.2, lines: 8,  len: 30, color: '#FFE2C4', zoom: 0.02,  dir: 2.0, sparksN: 9,  spread: 0.4 },
  palm:        { style: 'punch', ring: 12, wide: 1.8, lines: 4,  len: 16, color: '#FFF2D0', zoom: 0,     dir: 1.0, sparksN: 5,  spread: 0.5 },
  swing:       { style: 'spin',  ring: 28, wide: 3.2, lines: 12, len: 30, color: '#FFE07A', zoom: 0.03,  dir: 2.8, sparksN: 12, spread: 1.6 },
  iai:         { style: 'blade', ring: 22, wide: 2.4, lines: 14, len: 46, color: '#EAF2FF', zoom: 0.04,  dir: 2.6, sparksN: 9,  spread: 0.25 },
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
  const maxKnock = Math.max(...atk.hits.map(h => h.knock ?? 0));

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
/**
 * 招架（Parry）—— 判定是**确定性**的，反击是**AI 决策**。
 *
 * 为什么不在招架上掷骰子：招架成功本身已经是一个概率事件（时机对不对），
 * 反击再掷一次 = 两次概率相乘，节奏会碎，而且观众会觉得"假"
 * （明明招架成功为什么没还手？因为随机）。所以：
 *   · 判定：进入防御后的 window 秒内被击中 = 100% 招架成功
 *   · 反击：给 AI 一个 counterWindow 的决策窗，由 love（性格）决定打不打
 * 这样观感是"这个角色爱不爱反击"，而不是"系统随机"。
 */
const PARRY_DEF = {
  /** 进入防御后多少秒内被击中算招架（0.07s ≈ 4 帧，越短越硬核） */
  window: 0.07,
  /** 招架成功时攻击者吃的大硬直（秒） */
  stun: 0.46,
  /** 招架成功后自己的反击窗口（秒） */
  counterWindow: 0.22,
  /** 招架姿态时长（秒）：这段时间内被打中 = 招架成功 */
  active: 0.14,
  /**
   * 招架落空的代价（秒）：姿态撑完还没被打中 → 进入防御封锁，
   * 这段时间既挡不住也招架不了。**这就是"赌招架"的风险**。
   * 没有这一条，招架就是无风险选项，AI 会一直按。
   */
  failRecovery: 0.32,
  /** 反击倾向（性格）：0~1，越高越爱在招架后立刻还手 */
  love: 0.55,
  /** 反击时优先出的招（按顺序找这个英雄会的） */
  moves: ['counterStrike', 'hook', 'cross', 'jab'] as string[],
};

/**
 * 角色表（模块级导出）。
 *
 * 为什么必须导出：页面的「左/右角色」下拉框要在**引擎初始化之前**就填好。
 * 以前它靠 `window.takinolFight.demo.roster()` 取，但那个 API 要引擎实例存在才有 ——
 * 结果首次进页面时下拉框是空的（一个 option 都没有），
 * 引擎又用 `Number('') = 0` 读走了值，两个人都变成 0 号角色。
 */
export const ROSTER = [
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

/**
 * 走路：用相位生成真实的迈步（前后腿反相摆动）。导出供步态几何自检/工具用。
 *
 * 膝关节生理约束（2026-10-25 步态审查修的 bug）：小腿相对大腿的角**只能 ≤ 0**
 * （脚跟朝后收）。旧实现 legLF = 0.25 + max(0,c)·0.75 恒为正 = 小腿一直朝前甩
 * = 全程反关节，这就是「走路像踢腿」的根源；后撤的 speed 负号又只翻大腿不翻
 * 小腿相位，相位脱节后更是彻底变成"向前踢"。现在：摆动期（大腿向前扫）屈膝
 * 最深（脚跟提起清理地面），触地/支撑期接近伸直 —— 与真实步态同相。
 */
export const walkPose = (phase: number, speed = 1): Pose => {
  const s = Math.sin(phase * TAU);
  const c = Math.cos(phase * TAU);
  // 屈曲量：swing>0（该腿正在向前摆）屈得深，支撑期只剩 0.18 的自然微屈
  const knee = (swing: number) => -(0.18 + 0.92 * Math.max(0, swing));
  return P({
    lean: 0.12 + Math.abs(s) * 0.04,
    head: -0.04,
    armUB: 0.35 - s * 0.5 * speed,
    armLB: 0.9,
    armUF: 0.9 + s * 0.35 * speed,
    armLF: 1.5,
    legUB: -s * 0.62 * speed,
    legLB: knee(-c),   // B 腿与 F 腿反相：F 向前扫时（c>0）B 正在支撑
    legUF: s * 0.62 * speed,
    legLF: knee(c),
  });
};

/* ============================================================
 * 3. 行为决策（自主 AI，可被外部替换）
 * ============================================================ */

export type Decision =
  | 'approach'
  | 'retreat'
  | 'block'
  | 'parry'
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
  /**
   * 感知层输出 = AI 能看到的一切（L1）。
   *
   * 铁律：AI 的所有判断只能读这份快照，不许去摸 `fighters[i]` 的真身。
   * 以前有 2 处穿墙直读，等于让延迟感知形同虚设 —— 也就没法通过调 perceiveLag
   * 来"让 AI 变笨/变聪明"。缺什么字段就往这里加，而不是绕过去。
   */
  self: {
    hp: number; x: number; state: string; distance: number;
    /** 自己的冷却/出招间隔/硬直，规划层要用 */
    cool: number; sinceAttack: number; stunLeft: number;
    /** 自己的防御姿态与招架/封锁状态 */
    guardLow: boolean; parryT: number; guardLock: number;
    /** 自己这一招的进度（收招还剩多少） */
    prog: number; attacking: boolean;
  };
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
    /** 对手当前招式的进度（已扣掉感知延迟）—— 差合/招架要按帧算 */
    prog: number;
    /** 对手剩余硬直（秒）：连招"来不来得及"的唯一依据（R-2） */
    stunLeft: number;
    /** 对手这一招是否已经打到过人：false + 收招中 = 真的挥空，可以惩罚 */
    landedHit: boolean;
    /** 对手现在站防还是蹲防（择的读点） */
    guardLow: boolean;
    /** 对手是否处于攻击状态（比 state 判断更直接） */
    attacking: boolean;
    /** 对手躺在地上：这时候任何招都打不到，只能等 —— 以前把 down 当普通硬直，AI 会疯狂对空气出招 */
    down: boolean;
    /** 对手正在起身：没有防御，是唯一能"压起身"的窗口（okizeme） */
    gettingUp: boolean;
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
  /**
   * 关闭引擎内置的演示键盘监听（←→/空格/S）。
   * 宿主页面（fight.astro）自带一套带 UI 同步的键盘处理 —— 两套同开时
   * ←→ 会一次跳两招、空格/S 抵消成无操作。宿主页面必须传 true。
   */
  disableDemoKeys?: boolean;
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

/**
 * 格斗角色的全部运行时状态（模块级：activatePDReaction / rankMoves 等
 * 模块层函数也引用 Fighter —— 之前声明在 initFightBand 体内，TS2304。
 */
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
  /**
   * 出招瞬间的记录位置 —— 前冲位移`的基准点。
   * 位移改成「帧的纯函数」后，命中帧的位置完全可预测（DEMO 反推定位依赖这个）。
   */
  atkStartX: number;
  /** 当前帧的攻击判定体（每个 hit 一个），扫掠检测需要 */
  hitVols: HitVolume[];
  /** 上一帧的攻击判定体（用于 prev→curr 扫掠） */
  hitPrevVols: HitVolume[];
  /**
   * 命中后冻结前冲：武器顶到人就不该继续往前走，
   * 否则长枪/长刀会从对手身体里穿过去（就是"穿模"的根源）。
   */
  advanceFrozen: boolean;
  /**
   * 命中瞬间的进度（-1 = 还没命中）。
   * 命中后位移钉在这一刻，不再往前顶（长枪/长刀不会从身体里穿过去），
   * 但因为是「进度封顶」而不是「关掉位移」，seek/DEMO 重算时仍然完全一致。
   */
  lungeCapProg: number;
  /** 跟进步剩余距离（px）：招式收招后够不到时由 locomotion 垫的短时位移 */
  stepInLeft: number;
  /**
   * 这一招的「确认结果」：命中 / 被格挡 / 挥空。
   * 连招图的第一道分叉就读它 —— 打中了能接轻连，被挡了只能接破防或退，
   * 打空了什么都不接（必须吃收招硬直）。以前没有这个字段，
   * 等于把 block 和 whiff 都当 hit 处理，这是「连招看着乱」的根源。
   */
  lastConfirm: 'hit' | 'block' | 'whiff' | null;
  /** 本招是否已经查过连招图（每招只查一次，避免每帧重复抽签） */
  comboTried: string | null;
  /**
   * 本帧刀刃的几何（手在哪、朝哪个角度、多长、多弯）。
   * **渲染和判定都读这一个对象** —— 以前两边各算一遍，只要有一处不一致，
   * 画面上就会出现「剑在上、判定在下」这种分离。现在物理上不可能分叉。
   */
  bladeDraw: { hand: Pt; angle: number; len: number; sori: number } | null;
  /** 翻滚起点 + 滚动半径：让「转过的角度」和「走过的距离」严格对应（不打滑） */
  rollX0: number;
  rollR: number;
  /** 本英雄的招式库（来自 moves/kits/NN-*.ts，各英雄独立） */
  atks: Record<string, Atk>;
  /** 本英雄的片段表：状态片段 + 自己的招式片段 */
  clips: Record<string, Clip>;
  /** AI 可选的招式名单 = 本英雄招式库的键 */
  movePool: string[];
  /** 当前套用的招式库编号（= ROSTER 索引，调试用） */
  kitId: number;
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
  /**
   * 命中瞬间的挤压量（Squash & Stretch，0~1）。
   * 和 landSquash 分开：落地缓冲是"慢慢压"，命中的挤压是"炸开 2~3 帧就收"。
   * 打击感的一半来自这里 —— Q 版小人不被压扁，打上去就像打棉花。
   */
  squash: number;
  /** 顿帧期间的局部抖动（0~1）。整体冻结，但肌肉还在震。 */
  hitShake: number;
  /** 倒地时是否已经弹过（只弹一次，之后贴地不起） */
  landedBounce: boolean;
  /** 已经连续防御了多久（秒）。招架判定读它：刚进防御那几帧被打中 = 招架 */
  blockT: number;
  /** 招架成功后的反击窗口剩余时间（秒）。到 0 就作废 */
  counterT: number;
  /**
   * 战斗阶段：试探 → 交锋 → 重置。
   * 步法的节奏来自阶段切换（什么时候进内线、什么时候撤），
   * 而不是"把速度调快调慢"。之前 AI 永远待在交锋期，
   * 所以看起来一直在动却没有节奏。
   */
  phase: 'probing' | 'engagement' | 'reset';
  /** 当前阶段已经持续了多久（秒） */
  phaseT: number;
  /** 防御高度：false = 站防（挡中段），true = 蹲防（挡下段）。择的另一半 */
  guardLow: boolean;
  /** 招架姿态剩余时间（秒）。>0 时被打中 = 招架成功；耗尽没被打中 = 招架失败 */
  parryT: number;
  /** 防御封锁（秒）：招架失败后这段时间内挡不住也招架不了 —— 赌输的代价 */
  guardLock: number;
  /** 共享的空间真相（四段距离）：步法 / 连招图 / AI 都读它 */
  spatial: 'out' | 'edge' | 'in' | 'close';
  /** 假动作剩余时间（秒）：前走一步立刻后撤，用来诱对手出招 */
  feintT: number;
  /** 对手防御习惯读数：最近看到对手蹲防 / 站防的次数（缓慢衰减） */
  readsLow: number;
  readsHigh: number;
  /** 最近一次看到对手出招的段位（决定自己站防还是蹲防） */
  lastSeenHeight: 'high' | 'mid' | 'low';
  /**
   * 规划层（L3）：当前意图。有意图就照它执行，没有才重新规划。
   * 这是"从反射变成设计"的关键 —— 单帧反射永远表达不了「试探→观察→调整」。
   */
  intent: { kind: string; until: number; move?: string; punishWith?: string; tag?: string } | null;
  /** 最近一次「被我打倒」的时间戳：用于击倒递减（2.5s 内重复击倒要更难触发） */
  lastKdAt: number;
  /** 最近用过的招（novelty 惩罚用，最多留 4 条） */
  recentMoves: { k: string; t: number }[];
  /**
   * 对手画像（R-8）：滑动计数，记的是「我看到他爱怎么防 / 多爱抢 / 多常挥空」。
   * 只用于规划层的针对性决策，不参与选招打分（避免又变成乘法塔）。
   */
  oppModel: {
    guardLow: number; guardHigh: number;
    /** 他挡下我的招之后又抢招的次数 / 我被他挡下的总次数 */
    counter: number; blockN: number;
    /** 他挥空的次数 / 我看到的他出招总次数 */
    whiff: number; atkN: number;
    /** 最近一次记录时间 / 最近一次被挡时间 / 最近一次他出招时间 */
    at: number; blkAt: number; atkAt: number;
  };
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
  /** 动态件 A：布片柔体链（披风/袈裟/围裙）—— 极坐标解算 + 碰撞 + 硬复位（design-3） */
  clothChain: Chain | null;
  /** 受击风脉冲（px/s²）：命中瞬间朝击退方向掀布料，hitstop 冻结帧里布还在飘 */
  windPulse: number;
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

export function initFightBand(opts: FightOptions = {}): void {
  const canvas = document.getElementById(opts.canvasId ?? 'fight-canvas') as HTMLCanvasElement | null;
  if (!canvas) { console.error('[fight] canvas #', (opts.canvasId ?? 'fight-canvas'), 'not found!'); return; }
  const ctx = canvas.getContext('2d');
  if (!ctx) { console.error('[fight] cannot get 2d context'); return; }

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

  /*
   * MOVE_META 数据一致性验证。
   * ⚠️ 2026-10-25 改为模块加载时无条件跑一次（见文件底部 BOOT_CHECKS）——
   * 之前只在 debug 模式跑，「表分叉了也只有调试页看得到」，
   * lowSlash/risingSlash 漏登记就是从盲区里长出来的。
   */

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

  /** 把角色表里的设定套到一个斗士身上，并触发登场。preferDist 由行为 archetype 自动计算 */
  /** 按角色名取该英雄的招式库（15 份完整副本，见 moves/kits/） */
  const kitOf = (name: string) => HERO_KITS.find((k) => k.name === name) ?? HERO_KITS[0];

  /**
   * 把某个英雄的招式库装到斗士身上。
   *
   * 这是「分库」的落点：f.atks / f.clips / f.movePool 全部来自该英雄自己的那份数据，
   * 所以改 A 英雄的突刺不会影响 B 英雄 —— 判定、AI 选招、动画姿态都跟着各走各的。
   */
  const applyKit = (f: Fighter, kit: (typeof HERO_KITS)[number]) => {
    f.kitId = kit.id;
    f.atks = kit.atks;
    f.clips = { ...STATE_CLIPS, ...(kit.stateClips ?? {}), ...kit.clips };
    f.movePool = Object.keys(kit.atks);
  };

  const applyRoster = (f: Fighter, r: (typeof ROSTER)[number]) => {
    f.name = r.name;
    f.build = r.build;
    f.skin = SKINS[r.skin];
    f.aggression = r.aggression;
    f.guardChance = r.guardChance;
    f.preferDist = computePreferDist(GEAR_SPEC[r.build].behavior);
    f.enterT = f.enterDur;
    applyKit(f, kitOf(r.name));
  };

  /** 取本英雄的招式数据（英雄没配这招时回退到全局并集，保证演示/工具兜底） */
  const atkOf = (f: Fighter, s: string): Atk | undefined => f.atks[s] ?? ATTACKS[s];
  /** 取本英雄的动画片段（同上回退） */
  const clipOf = (f: Fighter, s: string): Clip | undefined => f.clips[s] ?? CLIPS[s];

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
          [STATE_INITIAL, '', 'idle'],
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
          [STATE_INITIAL, '', 'idle'],
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
          [STATE_INITIAL, '', 'idle'],
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
          [STATE_INITIAL, '', 'idle'],
          ['idle', 'WALK', 'walk'], ['idle', 'APPROACH', 'approach'],
          ['idle', 'RETREAT', 'retreat'], ['idle', 'JUMP', 'jump'],
          ['walk', 'IDLE', 'idle'], ['walk', 'APPROACH', 'approach'],
          ['walk', 'RETREAT', 'retreat'], ['walk', 'JUMP', 'jump'],
          ['approach', 'IDLE', 'idle'], ['approach', 'WALK', 'walk'],
          ['approach', 'JUMP', 'jump'],
          ['retreat', 'IDLE', 'idle'], ['retreat', 'WALK', 'walk'],
          ['retreat', 'JUMP', 'jump'],
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
   * State 枚举值 → FSM 事件名称映射表（已上移到模块级，供 BOOT_CHECKS 自检）
   */


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
  /** 最近一次几何判定的命中点（调试可视化用：白点 + 重叠量） */
  let debugHitPoint: { x: number; y: number; pen: number; life: number; zone: string } | null = null;
  /** 每帧的几何判定读数（画在画布顶部，逐招微调时直接看这行） */
  let debugGeo: {
    move: string; prog: number; pen: number; hit: boolean; zone: string; r: number;
    v1: number; v2: number; tx: number; ax: number; parts: string; a0: number;
  } | null = null;
  /** DEMO 定位的中间量（只在 ?debug=frames 时显示，用于排查站位算错） */
  let debugDemo = '';
  /** 本次演示的「目标站位」：定格/截图时用它把两人钉回设计位置 */
  let demoPin: { a: number; d: number } | null = null;
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
    const atk = atkOf(fighter, fighter.state);
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
  let running = false; // 引擎运行标志：destroy 时设为 false 防止 rAF 竞态
  let visible = true; // 默认可见，IntersectionObserver 会修正；避免初始 false 导致首帧永远不更新
  let tabVisible = document.visibilityState !== 'hidden';
  /*
   * 生命周期资源的声明**必须**在这里 —— 曾经 destroy() 里直接引用了三个
   * 从未声明的标识符（onResize / intersectionObs / resizeTimerId），
   * 一调 destroy 就 ReferenceError → 页面 boot() 中断 → 新引擎永远建不起来，
   * 表现就是「切模式画面定住」。声明和清理必须成对出现在同一处。
   */
  /** 引擎自己的 window resize 防抖定时器 */
  let resizeTimerId = 0;
  /** 视口观察器：舞台滚出视口就暂停 update/render（省电省 CPU） */
  let intersectionObs: IntersectionObserver | null = null;
  /** 是否被显式 destroy 过：区分「切模式重建」和「bfcache 离开」—— 前者不许 pageshow 复活 */
  let destroyedByApi = false;

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
    atkStartX: 0,
    hitVols: [],
    hitPrevVols: [],
    advanceFrozen: false,
    lungeCapProg: -1,
    stepInLeft: 0,
    lastConfirm: null,
    comboTried: null,
    bladeDraw: null,
    rollX0: 0,
    rollR: 0,
    atks: ATTACKS,
    clips: CLIPS,
    movePool: [],
    kitId: 0,
    flash: 0,
    bob: rand(0, 10),
    stun: 0,
    cool: rand(0.4, 1.6),
    walkPhase: rand(0, 1),
    partner: i % 2 === 0 ? i + 1 : i - 1,
    skin,
    scale: (i % 2 === 0 ? rand(0.98, 1.06) : rand(0.94, 1.02)),
    build: (i % 2 === 0 ? 'swordsman' : 'ranger') as Gear,
    clothChain: null,
    windPulse: 0,
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
    squash: 0,
    hitShake: 0,
    landedBounce: false,
    counterT: 0,
    phase: 'probing',
    phaseT: 0,
    guardLow: false,
    parryT: 0,
    guardLock: 0,
    spatial: 'out',
    feintT: 0,
    readsLow: 0,
    readsHigh: 0,
    lastSeenHeight: 'high',
    intent: null,
    lastKdAt: -9,
    recentMoves: [],
    oppModel: { guardLow: 0, guardHigh: 0, counter: 0, blockN: 0, whiff: 0, atkN: 0, at: 0, blkAt: -9, atkAt: -9 },
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
      f.fsm.dispatch('').catch((err: Error) => console.warn('[fight] FSM init error for fighter', i, err.message));
    }
    if (count % 2 !== 0) fighters[count - 1].partner = -1;
  };

  /** 两个一组摆在一格里，彼此站在交战距离上 */
  /** 上次 layout 时的画布宽：宽没变就不重写 x（否则每次 resize 防抖到期都会把人瞬移回中央） */
  let lastLayoutW = -1;
  const layout = () => {
    const n = fighters.length;
    const pairs = Math.max(1, Math.floor(n / 2));
    const slot = W / pairs;
    // 只有宽度真的变了（或角色还没站稳）才重写站位；minX/maxX/facing 照常更新。
    // 之前每次 layout 都无条件 a.x = cx - …，窗口拖动/切模式的合成 resize
    // 都会把正在对打的人拽回中心 —— 这就是「画面偶尔自己跳一下」。
    const reposition = W !== lastLayoutW;
    lastLayoutW = W;
    for (let p = 0; p < pairs; p++) {
      const cx = slot * (p + 0.5);
      const half = slot / 2 - 16;
      const a = fighters[p * 2];
      const b = fighters[p * 2 + 1];
      const entering = (a && a.enterT > 0) || (b && b.enterT > 0);
      if (a) {
        if (reposition || (a && a.enterT > 0)) a.x = cx - (entering ? 80 : a.preferDist / 2);
        a.facing = 1;
        a.minX = cx - half;
        a.maxX = cx + half;
      }
      if (b) {
        if (reposition || (b && b.enterT > 0)) b.x = cx + (entering ? 80 : b.preferDist / 2);
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

    // 打击线：旋踢是 360° 环形破线，刀类是「刀光扇形」，其余沿打击方向放射
    const base = facing > 0 ? 0 : Math.PI;
    if (fx.style === 'blade') {
      // 刀光：沿挥砍弧线排一圈「切向」短划 —— 连起来读作一道月牙，而不是放射线
      const nBlade = 13;
      const dirSign = facing > 0 ? 1 : -1;
      for (let i = 0; i < nBlade; i++) {
        const t = i / (nBlade - 1);
        const ang = base + (t - 0.5) * 1.9;          // 弧上的位置
        const bulge = Math.sin(t * Math.PI);          // 中间最饱满
        const rad = (10 + 16 * bulge) * p;            // 弧半径
        const px = x - Math.cos(ang) * rad;
        const py = y - Math.sin(ang) * rad;
        const tan = ang + (Math.PI / 2) * dirSign;    // 切线方向
        speedLines.push({
          x: px, y: py, a: tan,
          life: 0.02,
          max: 0.2,
          len: fx.len * (0.35 + 0.75 * bulge) * p * 0.55,
          color: col,
          w: 2.2 + 2.0 * bulge,
        });
      }
      // 刃口最亮的一道
      speedLines.push({ x, y, a: base, life: 0.01, max: 0.16, len: fx.len * 1.05 * p, color: '#FFFFFF', w: 2.2 });
    } else {
      for (let i = 0; i < fx.lines; i++) {
        const a = fx.style === 'spin' ? rand(0, TAU) : base + rand(-0.95, 0.95);
        speedLines.push({ x, y, a, life: rand(0.07, 0.15) * phase, max: rand(0.07, 0.15), len: fx.len * rand(0.65, 1.3) * p, color: col, w: rand(1, 2.3) });
      }
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

  // 环境风（px/s²）：布料常驻微风，命中时再叠加 windPulse 脉冲
  const WIND_AMBIENT = 40;

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
      // 目标：脚应该在地面高度（y = groundY() - lift 偏移）
      // IK 在局部坐标空间工作，地面相对于骨盆的位置
      const hip = jRaw[supportHip as keyof Joints];
      const footTarget: Pt = { x: jRaw[supportFoot as keyof Joints].x, y: Math.max(jRaw[supportFoot as keyof Joints].y, hip.y + L.thigh + L.shin - 1), z: 0 };
      // 只有当脚明显低于自然伸展位置时才应用 IK
      if (footTarget.y > jRaw[supportFoot as keyof Joints].y + 0.5) {
        // solveFootIK 输出的就是 fk 的 dir 系角度（u=大腿、f=小腿相对角），
        // 并保证膝朝角色前方弯 —— 别再直接用 twoBoneIK 的 atan2 角（差 π/2）
        const ik = solveFootIK(hip, footTarget, L.thigh, L.shin);
        if (ik.ok) {
          // 创建姿态副本，修改对应腿的角度
          const modPose = { ...pose };
          if (supportFoot === 'footF') {
            modPose.legUF = ik.u;
            modPose.legLF = ik.f;
          } else {
            modPose.legUB = ik.u;
            modPose.legLB = ik.f;
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
   * 新版碰撞检测：体积碰撞 + 扫描判定（替代针尖戳气球）
   * ------------------------------------------------------------
   * 架构：逻辑与表现分离
   *   - HitVolume:  攻击方的命中体（胶囊/线段+半径），从骨骼采样但独立于骨骼
   *   - Hurtbox:    受击方的受击体（胶囊：骨盆→头），替代原来的单线段
   *   - SweptHit:   连续碰撞检测——把上一帧到当前帧的 HitVolume 路径扫过空间，
   *                 测试与 Hurtbox 是否有重叠。解决高速攻击穿模问题。
   *   - 判定标准：几何重叠量 > 0 就是命中，不需要 magic threshold
   *
   * 迁移记录（已完成）：旧 contactCheck 已删除（见下方【已废弃】块），
   * sweptHit 是唯一判定路径 —— 这里保留的是历史说明，别再照着"新旧并行"找代码。
   * ============================================================ */

  /** 命中体积形状 */
  interface HitVolume {
    /** 胶囊/线段的起点（世界坐标） */
    p1: Pt;
    /** 胶囊/线段的终点（世界坐标） */
    p2: Pt;
    /** 半径（px）：攻击部位的粗细。拳头≈5~7，脚≈6~9，武器尖端≈3~4 */
    radius: number;
    /**
     * 折线中心线（弯刀/软鞭这类有弧度的兵器用）。
     * 有 path 时判定按「折线胶囊链」逐段求交，p1/p2 只是首尾两点；
     * 直兵器/拳脚不写 path，等价于一条线段（退化情形）。
     */
    path?: Pt[];
  }

  /** 受击盒：角色躯干的碰撞体 */
  interface Hurtbox {
    /** 躯干胶囊起点（骨盆，世界坐标） */
    p1: Pt;
    /** 躯干胶囊终点（头，世界坐标） */
    p2: Pt;
    /** 半径（px）：躯干厚度。scale=1 时约 8~10 */
    radius: number;
  }

  /** 扫描命中结果 */
  interface SweptHitResult {
    /** 是否发生碰撞 */
    hit: boolean;
    /** 碰撞点（世界坐标，用于打击特效/伤害定位） */
    point: Pt;
    /** 两体积间的最小距离（负值 = 渗透深度） */
    penetration: number;
    /** 哪一帧命中的：'prev'(扫描路径中) | 'curr'(当前帧) */
    when: 'prev' | 'curr';
  }

  /**
   * 两条线段之间的最近点对（Dan Sunday 的标准解法）
   * 用于胶囊vs胶囊、线段vs胶囊的核心几何原语
   *
   * 参数化：P(s) = a1 + s*d1，Q(t) = b1 + t*d2，s,t ∈ [0,1]
   * 最小化 |P(s)-Q(t)|² ⇒ 解下面的 2x2 线性系统。
   * 注意：s 的分子是 (b*f - c*e)，符号写反会导致最近点永远落在端点，
   *      长武器（枪/锤）会因此判不中，是"抡砸完全没反应"的直接原因。
   */
  const closestPointsBetweenSegments = (
    a1: Pt, a2: Pt, b1: Pt, b2: Pt,
  ): { pa: Pt; pb: Pt; t: number; u: number } => {
    const d1 = { x: a2.x - a1.x, y: a2.y - a1.y, z: a2.z - a1.z };
    const d2 = { x: b2.x - b1.x, y: b2.y - b1.y, z: b2.z - b1.z };
    const r = { x: a1.x - b1.x, y: a1.y - b1.y, z: a1.z - b1.z };

    const A = d1.x * d1.x + d1.y * d1.y + d1.z * d1.z; // |d1|²
    const E = d2.x * d2.x + d2.y * d2.y + d2.z * d2.z; // |d2|²
    const B = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z; // d1·d2
    const C = d1.x * r.x + d1.y * r.y + d1.z * r.z;    // d1·r
    const F = d2.x * r.x + d2.y * r.y + d2.z * r.z;    // d2·r

    const EPS = 1e-8;
    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

    let s: number;
    let t: number;

    if (A <= EPS && E <= EPS) {
      // 两条线段都退化成点
      s = 0;
      t = 0;
    } else if (A <= EPS) {
      // A 退化成点
      s = 0;
      t = clamp01(F / E);
    } else if (E <= EPS) {
      // B 退化成点
      t = 0;
      s = clamp01(-C / A);
    } else {
      const denom = A * E - B * B;
      s = denom > EPS ? clamp01((B * F - C * E) / denom) : 0;
      t = (B * s + F) / E;
      if (t < 0) {
        t = 0;
        s = clamp01(-C / A);
      } else if (t > 1) {
        t = 1;
        s = clamp01((B - C) / A);
      }
    }

    return {
      pa: { x: a1.x + d1.x * s, y: a1.y + d1.y * s, z: a1.z + d1.z * s },
      pb: { x: b1.x + d2.x * t, y: b1.y + d2.y * t, z: b1.z + d2.z * t },
      t: s,
      u: t,
    };
  };

  /**
   * 把一个判定体拆成若干线段。
   * 弯刀 = 折线胶囊链（多段），直兵器/拳脚 = 单段 —— 统一成同一个接口，
   * 判定、扫掠、调试绘制都不需要分情况写。
   */
  const volSegments = (v: HitVolume): { a: Pt; b: Pt }[] => {
    if (v.path && v.path.length >= 2) {
      const out: { a: Pt; b: Pt }[] = [];
      for (let i = 0; i < v.path.length - 1; i++) out.push({ a: v.path[i], b: v.path[i + 1] });
      return out;
    }
    return [{ a: v.p1, b: v.p2 }];
  };

  /**
   * 静态胶囊 vs 胶囊相交测试（支持折线胶囊链：逐段求交，取最深的一段）
   * @returns penetration 深度（负值=分离，正值=渗透）
   */
  const capsuleVsCapsule = (
    volA: HitVolume, volB: HitVolume,
  ): { hit: boolean; point: Pt; penetration: number } => {
    const sa = volSegments(volA);
    const sb = volSegments(volB);
    const sumR = volA.radius + volB.radius;
    let bestPen = -Infinity;
    let bestPoint: Pt = volA.p1;
    for (const A of sa) {
      for (const B of sb) {
        const { pa, pb } = closestPointsBetweenSegments(A.a, A.b, B.a, B.b);
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const dz = pb.z - pa.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const pen = sumR - dist; // 正值 = 重叠
        if (pen > bestPen) {
          bestPen = pen;
          const nx = dist > 0.001 ? dx / dist : 1;
          const ny = dist > 0.001 ? dy / dist : 0;
          const nz = dist > 0.001 ? dz / dist : 0;
          // 碰撞点取最深那一段的最近点，沿法向推到球面交界
          bestPoint = {
            x: pa.x + nx * volA.radius,
            y: pa.y + ny * volA.radius,
            z: pa.z + nz * volA.radius,
          };
        }
      }
    }
    if (!Number.isFinite(bestPen)) return { hit: false, point: volA.p1, penetration: -Infinity };
    return { hit: bestPen > 0, point: bestPoint, penetration: bestPen };
  };

  /**
   * 从 Fighter 的骨骼姿态构建命中体积（HitVolume）
   *
   * 设计原则：
   *   - 骨骼仅作为「可视化锚点」提供位置参考
   *   - HitVolume 是独立的几何体，有自己的 radius
   *   - 对于带 tip 的武器招式，p2 沿前臂方向延伸 tipLen
   *
   * @param f       攻击方
   * @param part    攻击部位（手/脚/肘/膝）
   * @param tipLen  武器尖端延伸长度（px，已含 scale）
   * @returns HitVolume 命中体积
   */
  /**
   * 统一的「持械规则」：渲染和判定必须用同一个判断。
   * 招式上写了 armed 就用它；没写就看流派默认（收刀流的拳脚不持械）。
   */
  const armedOf = (f: Fighter, atk: Atk | undefined): boolean =>
    atk ? (atk.armed ?? GEAR_SPEC[f.build].weaponInHand) : GEAR_SPEC[f.build].weaponInHand;

  /** 本招的刀刃长度（px）：优先用这一段的 tip，没有就用本招最长的 tip */
  const bladeLenOf = (atk: Atk | undefined, h?: AtkHit): number => {
    if (!atk) return 0;
    if (h && h.tip && h.tip > 0) return h.tip;
    let m = 0;
    for (const x of atk.hits) if (x.tip && x.tip > 0) m = Math.max(m, x.tip);
    return m;
  };

  /** 从当前姿态算出刀刃的几何（手、前臂角度、长度、反り） */
  const bladeGeometryFor = (
    f: Fighter, part: StrikePart, len: number, sori: number,
  ): { hand: Pt; angle: number; len: number; sori: number } | null => {
    if (len <= 0) return null;
    const aw = place(f).world;
    const hand = aw[part as keyof Joints];
    const elbowKey = part === 'handB' ? 'elbowB' : part === 'handF' ? 'elbowF' : null;
    if (!elbowKey) return null;
    const elbow = aw[elbowKey as keyof Joints];
    return { hand, angle: Math.atan2(hand.y - elbow.y, hand.x - elbow.x), len, sori };
  };

  const buildHitVolume = (f: Fighter, part: StrikePart, tipLen = 0, radiusPx = 0, sori = 0): HitVolume => {
    const aw = place(f).world;
    const hand = aw[part as keyof Joints];

    // 拳脚判定的默认粗细：按体型缩放（大个子拳头更大）
    const baseRadius = 4.5 + f.scale * 2.5;

    // 链锤：用甩动球 trinket 的位置当球心（半径 5）
    if (tipLen === -1) {
      const tr = f.trinket;
      if (tr && !Number.isNaN(tr.x)) {
        return { p1: { x: tr.x, y: tr.y, z: 0 }, p2: { x: tr.x, y: tr.y, z: 0 }, radius: radiusPx || 5 };
      }
      tipLen = 14; // 演示定位时链球还没甩出去，用手前 14px 近似
    }

    if (tipLen > 0) {
      // 有武器尖端：从手沿前臂方向延伸 → 形成长条形命中体
      const elbowKey = part === 'handB' ? 'elbowB' : part === 'handF' ? 'elbowF' : null;
      if (elbowKey) {
        const elbow = aw[elbowKey as keyof Joints];
        const dx = hand.x - elbow.x;
        const dy = hand.y - elbow.y;
        const d = Math.hypot(dx, dy) || 1;
        const ang = Math.atan2(dy, dx);
        const r = radiusPx || baseRadius * 0.65;
        // 弯刀：折线胶囊链（4 段），与绘制用的是同一条弧
        if (sori > 0) {
          // 传 f.facing：弯曲方向必须和绘制完全一致（否则转身后刀和判定一上一下）
          const path = bladeCenterline(hand, ang, tipLen, sori, 4, f.facing);
          return { p1: path[0], p2: path[path.length - 1], radius: r, path };
        }
        const dz = hand.z - elbow.z;
        // 武器尖端终点
        const tip: Pt = {
          x: hand.x + (dx / d) * tipLen,
          y: hand.y + (dy / d) * tipLen,
          z: hand.z + (dz / d) * tipLen,
        };
        // 武器判定体：手→尖端，粗细由招式数据 w 决定（不填则按体型）
        return { p1: hand, p2: tip, radius: r };
      }
    }

    // 无尖端：用肢体近端（肘/肩/膝）到手/脚作为短胶囊
    let nearKey: keyof Joints | null = null;
    if (part.startsWith('hand')) nearKey = part === 'handB' ? 'elbowB' : 'elbowF';
    else if (part.startsWith('foot')) nearKey = part === 'footB' ? 'kneeB' : 'kneeF';
    else if (part.startsWith('elbow')) nearKey = part === 'elbowB' ? 'shoulderB' : 'shoulderF';
    else if (part.startsWith('knee')) nearKey = part === 'kneeB' ? 'hipB' : 'hipF';

    if (nearKey) {
      const near = aw[nearKey];
      /*
       * 拳脚：判定体只包住「末端那一小段」= 拳头/脚掌本身。
       * 以前取的是肘→手的正中点，一旦出拳时手臂是弯的（受击帧、收招帧），
       * 这个起点就跑到胸口去了，看起来就是「判定从胸口开始平推」。
       * 现在固定贴住末端 38%：不管手臂什么角度，判定都只在拳头上。
       */
      const t0 = 0.62;
      const p0: Pt = {
        x: near.x + (hand.x - near.x) * t0,
        y: near.y + (hand.y - near.y) * t0,
        z: near.z + (hand.z - near.z) * t0,
      };
      return { p1: p0, p2: hand, radius: radiusPx || baseRadius };
    }

    // 兜底：退化成以手为中心的小球
    return { p1: hand, p2: { ...hand }, radius: baseRadius };
  };

  /**
   * 从 Fighter 构建受击盒（Hurtbox）
   *
   * 升级自旧版 pelvis→head 单线段：
   *   - 现在是真正的胶囊体（线段 + radius）
   *   - radius 按 scale 缩放，反映角色体型
   *   - 未来可扩展为多胶囊组合（头/躯干/腿分开）
   */
  const buildHurtbox = (f: Fighter): Hurtbox => {
    const tw = place(f).world;
    // 躯干厚度：scale=1 时约 9px（比旧 threshold 的 ~7*reach*scale 更直观）
    const radius = 7 + f.scale * 3;
    return { p1: tw.pelvis, p2: tw.head, radius };
  };

  /** 受击部位标签：命中哪个框就播哪个部位的反应，不再靠坐标阈值猜 */
  type HurtZone = 'head' | 'body' | 'leg';

  /** 一个带部位标签的受击框 */
  interface HurtPart {
    vol: HitVolume;
    zone: HurtZone;
  }

  /**
   * 构建多部位受击框：头（球）+ 躯干（胶囊）+ 腿（胶囊）
   *
   * 这是「人有身体」的落地：不再是骨盆一个点，
   * 打中哪个框就返回哪个部位，受击反应按部位分派，几何上自洽。
   */
  const buildHurtParts = (f: Fighter): HurtPart[] => {
    const tw = place(f).world;
    const s = f.scale;
    // 半径随体型缩放，数值来自骨骼比例（L.headR / 躯干宽度 / 大腿）
    const headR = 5.2 + s * 2.2;
    const torsoR = 7 + s * 3;
    const legR = 5.6 + s * 2.4;

    // 头：以 head 关节为中心的球（p1==p2）
    const head: HitVolume = { p1: tw.head, p2: { ...tw.head }, radius: headR };
    // 躯干：pelvis → chest 的胶囊（比 pelvis→head 更贴合真实身体）
    const torso: HitVolume = { p1: tw.pelvis, p2: tw.chest, radius: torsoR };
    // 腿：取「更靠前」的那条腿（朝向方向上更突出的那条），髋 → 膝
    const frontIsF = (tw.hipF.x - tw.hipB.x) * f.facing >= 0;
    const legHip = frontIsF ? tw.hipF : tw.hipB;
    const legKnee = frontIsF ? tw.kneeF : tw.kneeB;
    const legs: HitVolume = { p1: legHip, p2: legKnee, radius: legR };

    return [
      { vol: head, zone: 'head' },
      { vol: torso, zone: 'body' },
      { vol: legs, zone: 'leg' },
    ];
  };

  /** 在两个判定体之间线性插值（扫掠子步用） */
  const lerpVol = (a: HitVolume, b: HitVolume, t: number): HitVolume => ({
    p1: {
      x: a.p1.x + (b.p1.x - a.p1.x) * t,
      y: a.p1.y + (b.p1.y - a.p1.y) * t,
      z: a.p1.z + (b.p1.z - a.p1.z) * t,
    },
    p2: {
      x: a.p2.x + (b.p2.x - a.p2.x) * t,
      y: a.p2.y + (b.p2.y - a.p2.y) * t,
      z: a.p2.z + (b.p2.z - a.p2.z) * t,
    },
    radius: a.radius + (b.radius - a.radius) * t,
    // 折线胶囊链也要插值，否则弯刀扫掠时路径会跳
    path:
      a.path && b.path && a.path.length === b.path.length
        ? a.path.map((p, i) => ({
            x: p.x + (b.path![i].x - p.x) * t,
            y: p.y + (b.path![i].y - p.y) * t,
            z: p.z + (b.path![i].z - p.z) * t,
          }))
        : undefined,
  });

  /** 扫掠命中结果（带部位） */
  interface SweptPartResult {
    hit: boolean;
    point: Pt;
    penetration: number;
    zone: HurtZone;
    /** 命中的是哪个受击框（调试用） */
    subStep: number;
  }

  /**
   * 「面撞面」的核心判定：攻击体扫掠 × 多部位受击框
   *
   * 与旧 contactCheck 的根本区别：
   *   - 旧：枪尖一个点 vs 躯干中心点，算距离 < 魔法阈值
   *   - 新：有粗度的武器胶囊 vs 有体积的身体框，算几何重叠量
   *
   * 扫掠：把 prev 和 curr 两个胶囊按子步插值（1/4..4/4），
   * 任何一个子步叠上了就算命中 —— 高速挥击不会再「跳过」身体。
   *
   * @returns penetration > 0 即命中；越大表示打得越实
   */
  const sweptHitParts = (
    prevVol: HitVolume | null,
    currVol: HitVolume,
    parts: HurtPart[],
  ): SweptPartResult => {
    // 位移量决定子步数：移动越远，插值越密（最多 8 步，足够覆盖 60fps 下的挥击）
    let moveDist = 0;
    if (prevVol) {
      moveDist = Math.hypot(currVol.p2.x - prevVol.p2.x, currVol.p2.y - prevVol.p2.y);
    }
    const steps = Math.max(1, Math.min(8, Math.ceil(moveDist / 4)));

    let best: SweptPartResult = {
      hit: false,
      point: currVol.p2,
      penetration: -Infinity,
      zone: 'body',
      subStep: 0,
    };

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const vol = prevVol && s < steps ? lerpVol(prevVol, currVol, t) : currVol;
      // 同一子步内三个部位都测，取「叠得最深」的那个：
      // 戳胸口就判 body、砸到脚就判 leg、顶到下巴才判 head —— 几何说了算，不靠检测顺序。
      for (const p of parts) {
        const r = capsuleVsCapsule(vol, p.vol);
        if (r.penetration > best.penetration) {
          best = { hit: false, point: r.point, penetration: r.penetration, zone: p.zone, subStep: s };
        }
      }
      if (best.penetration > 0) {
        // 这一子步已经叠上了：返回最早接触 + 最深部位
        return { hit: true, point: best.point, penetration: best.penetration, zone: best.zone, subStep: s };
      }
    }
    return best;
  };

  /**
   * 扫描命中检测（Swept Hit Detection）—— 旧接口保留（单受击框）
   * 新代码请用 sweptHitParts（多部位）
   */
  const sweptHit = (
    prevVol: HitVolume | null,
    currVol: HitVolume,
    hurtbox: Hurtbox,
  ): SweptHitResult => {
    const r = sweptHitParts(prevVol, currVol, [{ vol: hurtbox as unknown as HitVolume, zone: 'body' }]);
    return { hit: r.hit, point: r.point, penetration: r.penetration, when: r.subStep >= 1 ? 'curr' : 'curr' };
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

  /*
   * 【已废弃】contactCheck —— 旧的「点对点距离 + 魔法阈值」判定，已删除。
   *
   * 为什么删掉：它把「枪有没有捅进身体」简化成「枪尖一个点离骨盆一个点多远」，
   * 容差还是 7*reach*scale 这种拍出来的数，导致：
   *   · 差 0.07px 就判不中（边界极其脆弱）
   *   · 高速挥击会「跳过」对手（无扫掠）
   *   · 长兵器从身体里穿过去也无法识别
   * 现在的判定是 sweptHitParts()：有粗度的攻击胶囊（扫掠子步）
   * ∩ 头/躯干/腿三个受击框，重叠量 > 0 即命中。阈值不再存在。
   */

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

    /*
     * 查找对应 FSM 事件。
     *
     * 注意：**没有映射也必须允许切换**。
     * 以前这里是 `if (!event && !force) return false;` —— 造成一个非常隐蔽的坑：
     * 新加一招只要忘了往 STATE_EVENT_MAP 里登记，setState 就静默返回 false，
     * 状态不变、动画不播，看起来就是「这招不动」（实际连状态都没进去）。
     * FSM 在这里只是状态的镜像（没有任何地方读 f.fsm.state），所以缺事件时
     * 照常改状态、只跳过 dispatch 即可。
     */
    const event = STATE_EVENT_MAP[newState];
    if (!event) {
      // 合法性兜底：只放行「招式表里真实存在」或「基础状态片段」的写法，
      // 这样既不会因为漏登记 STATE_EVENT_MAP 而静默失效，也挡得住拼错的状态名。
      const isKnown = !!(ATTACKS as Record<string, unknown>)[newState] || !!STATE_CLIPS[newState];
      if (!isKnown && !force) return false;
      if (debugOptions.frames) {
        console.warn(`[fight] ${newState} 没有 FSM 事件映射（不影响播放，建议补进 STATE_EVENT_MAP）`);
      }
    }

    // ===== 执行状态转换副作用 =====

    // 起跳同时进入闪避无敌帧（保留原有行为）
    if (newState === 'jump') f.invuln = 0.34;

    // 更新扁平 state（向后兼容 — 所有读取 f.state 的代码不受影响）
    f.state = newState;
    f.clipT = 0;
    f.clipDur = dur ?? clipOf(f, newState)?.dur ?? 0.3;
    f.hitDone = [];
    f.landedHit = false;
    f.pendingCombo = null;
    // 前冲位移的基准点：每次换招（clipT 归零）都重锚，保证 f.x 是帧的纯函数
    f.atkStartX = f.x;
    // 判定体缓存清空：换招后不能拿上一招的体积做扫掠
    f.hitVols = [];
    f.hitPrevVols = [];
    f.advanceFrozen = false;
    f.lungeCapProg = -1;
    f.lastConfirm = null;
    f.comboTried = null;
    // 注意：stepInLeft 故意不在这里清 —— 跟进步要跨过「收招 → 下一招」的换招点，
    // 清了就等于没跟。它自己会走完（见 update 里的消耗逻辑）。

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
    f.landedBounce = false;
    if (lethal) stats.lethalDowns++;
    else stats.nonlethalDowns++;
    stats.downs++;
    const w = place(f).world;
    const rd: Fighter['ragdoll'] = {};
    for (const k of Object.keys(w) as (keyof Joints)[]) {
      // 初始速度沿用当下的击退速度（verlet 用"上一帧位置"表示速度）：
      // 被重锤砸飞的人，落地时应该还带着冲量，而不是原地散架。
      const kick = Math.max(-900, Math.min(900, f.kb)) / 60;
      rd[k] = { x: w[k].x, y: w[k].y, px: w[k].x - f.facing * kick, py: w[k].y - 3.2 };
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
  /** 这个英雄有没有连招图（有就按图走，没有就退回旧的概率连招） */
  const comboGraphOf = (f: Fighter) => HERO_KITS.find((k) => k.id === f.kitId)?.combo ?? null;

  /**
   * 连招图查询：当前这一招、这个确认结果、这个帧、这个距离，能接什么？
   *
   * 返回 null = 没有可接的边（该吃收招硬直，或者打完就退）。
   * 这就是「连招是图不是链」的落地：同一招命中后可能有三条出边，
   * 按窗口/距离过滤后加权抽一个，而不是"命中就按 70% 概率随便接"。
   */
  const pickComboEdge = (f: Fighter, opp: Fighter | null, prog: number): string | null => {
    const edges = comboGraphOf(f);
    if (!edges || !edges.length) return null;
    const gap = opp ? Math.abs(opp.x - f.x) : 999;
    const r = reachOf(f.state);
    // 空间关系：外线 / 边缘 / 内线 / 贴身（连招图的 range 条件读的是这个）
    const spatial: 'out' | 'edge' | 'in' | 'close' =
      gap <= 22 ? 'close' : gap <= r * 0.72 ? 'in' : gap <= r + 8 ? 'edge' : 'out';
    const confirm = f.lastConfirm ?? 'hit';
    const cands = edges.filter(
      (e) =>
        e.from === f.state &&
        e.confirm === confirm &&
        prog >= e.window[0] &&
        prog <= e.window[1] &&
        (!e.range || e.range === spatial) &&
        // 目标要么是这个英雄真的会的招，要么是"退开/待机"这类收尾状态
        (!!atkOf(f, e.to) || e.to === 'retreat' || e.to === 'idle')
    );
    if (!cands.length) return null;
    /*
     * R-2 时间预算 + R-6 风险决策
     * ------------------------------------------------------------
     * 以前这里是「过滤完直接按 weight 抽签」，于是"赌拔刀斩"和"接轻招"
     * 在结构上是同一类选项，只是权重不同 —— 风险被一个常数抹平了。
     * 现在两把闸门：
     *   ① 来不及就不接：下一招的起手必须早于对手硬直结束（canLandBefore）
     *   ② 确认不够就不贪：高 conviction 的边只有打康才放行
     * 最后按期望值加权（收益 × 命中率 − 打空代价 × 风险）而不是按常数权重。
     */
    const pers = personalityOf(f);
    const stunLeft = opp ? Math.max(0, opp.stun) : 0;
    const confirmStrength = confirm === 'counter' ? 1 : confirm === 'hit' ? 0.6 : 0.25;
    const pos = opp ? evaluatePosition(f, snapshot(f, opp)) : 0;
    const evOf = (e: (typeof cands)[number]): number => {
      const isAtk = !!atkOf(f, e.to);
      const payoff = e.payoff ?? (isAtk ? (f.atks[e.to]?.hits ?? []).reduce((a2, h) => a2 + (h.dmg[0] + h.dmg[1]) / 2, 0) : 2);
      const whiffCost = e.onWhiff === 'punished' ? 16 : 4;
      const p = confirm === 'counter' ? 0.85 : confirm === 'hit' ? 0.62 : 0.3;
      return payoff * p - (1 - p) * whiffCost * pers.risk;
    };
    const gated = cands.filter((e) => {
      if (e.to === 'retreat' || e.to === 'idle') return true;      // 收尾状态随时可以走
      if (!opp) return true;
      // ① 时间预算：来不来得及
      if (!canLandBefore(f, e.to, stunLeft)) return false;
      // ② 确认强度：只有打康才敢接高 conviction 的边
      const conviction = e.conviction ?? (e.onWhiff === 'punished' ? 1 : 0.3);
      if (conviction > confirmStrength + 0.001) return false;
      // ③ 落后时不许赌大（领先时才允许打空也无所谓）
      if (e.onWhiff === 'punished' && pos < -0.2 && pers.risk < 0.5) return false;
      return true;
    });
    const pool2 = gated.length ? gated : cands.filter((e) => e.to === 'retreat' || e.to === 'idle');
    if (!pool2.length) return null;
    // 期望值加权（负分压到 0.2，避免"必须选一个最不烂的"变成永远同一招）
    const w = pool2.map((e) => Math.max(0.2, evOf(e)));
    let total = 0;
    for (const x of w) total += x;
    let t = random() * total;
    for (let i = 0; i < pool2.length; i++) {
      t -= w[i];
      if (t <= 0) return pool2[i].to;
    }
    return pool2[pool2.length - 1].to;
  };

  /**
   * 招式位移的三段划分（归一化进度）：
   *   [0, sEnd)      起手：重心前压 / 蓄力
   *   [sEnd, aEnd)   判定：蹬地、转胯、武器扫过
   *   [aEnd, 1]      收招：站定 / 退半步
   * 边界直接取第一段的命中帧与判定窗结束 —— 位移曲线和判定窗天然对齐，
   * 不会再出现「判定在 0.42 帧、位移却按整招平均分配」这种错位。
   */
  const lungePhases = (atk: Atk): { sEnd: number; aEnd: number } => {
    const h0 = atk.hits[0];
    const at = h0 ? h0.at : 0.5;
    const act = h0 ? (h0.act ?? 0.14) : 0.14;
    const sEnd = Math.max(0.02, Math.min(0.9, at));
    const aEnd = Math.max(sEnd + 0.02, Math.min(0.995, at + act));
    return { sEnd, aEnd };
  };

  /**
   * prog 时刻的累计位移（px）—— 纯函数。
   *
   * 这是「位移粒度」的修正：一个拳不是「整招净位移 N px」，
   * 而是「起手 +a → 判定 +b → 收招 +c」，净位移 = a+b+c。
   * 因为段边界连续（上一段刚好走满），曲线在任意 prog 都连续可算，
   * 同一个 prog 在任何帧率下位置完全相同 → DEMO 可以精确反推起手位置。
   *
   * 不写 lunge 的老招式回退到 forward（整招一条曲线，0.62 后不再推进）。
   */
  const lungeDistAt = (atk: Atk, prog: number, clipDur: number): number => {
    const p = Math.max(0, Math.min(1, prog));
    const cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    if (atk.lunge) {
      const { sEnd, aEnd } = lungePhases(atk);
      return (
        (atk.lunge.startup ?? 0) * cl(p / sEnd) +
        (atk.lunge.active ?? 0) * cl((p - sEnd) / (aEnd - sEnd)) +
        (atk.lunge.recovery ?? 0) * cl((p - aEnd) / (1 - aEnd))
      );
    }
    return (atk.forward ?? 0) * clipDur * Math.min(p, 0.62);
  };

  /** 本英雄所有招里最长的标定量程：四段空间划分的基准 */
  const bestReachCache: Record<number, number> = {};
  const bestReachOf = (f: Fighter): number => {
    const c = bestReachCache[f.kitId];
    if (c) return c;
    let m = 30;
    for (const k of f.movePool.length ? f.movePool : ATTACK_KEYS) m = Math.max(m, reachOf(k));
    bestReachCache[f.kitId] = m;
    return m;
  };

  /** 在射程内、起手最快的招（差合/打康用：抓破绽要快，不要抡重招） */
  const fastestWithin = (f: Fighter, d: number): string | null => {
    let best: string | null = null;
    let bestT = 9;
    for (const k of f.movePool.length ? f.movePool : ATTACK_KEYS) {
      const a = f.atks[k] ?? ATTACKS[k];
      if (!a || a.projectile) continue;
      if (d > reachOf(k) + 12) continue;
      const t = MOVE_META[k]?.startup ?? 0.3;
      if (t < bestT) {
        bestT = t;
        best = k;
      }
    }
    return best;
  };

  /** 这个角色有多爱"读招赌招架"（性格参数，不是随机数） */
  const parryLoveOf = (f: Fighter): number => {
    const b = GEAR_SPEC[f.build].behavior;
    return b === 'turtle' ? 0.5 : b === 'punisher' ? 0.38 : b === 'trickster' ? 0.3 : 0.18;
  };

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
    const selfProg = f.clipDur > 0 ? f.clipT / f.clipDur : 1;
    return {
      self: {
        hp: f.hp, x: f.x, state: f.state, distance: dist,
        cool: f.cool,
        sinceAttack: f.sinceAttack,
        stunLeft: Math.max(0, f.stun),
        guardLow: f.guardLow,
        parryT: f.parryT,
        guardLock: f.guardLock,
        prog: selfProg,
        attacking: !!atkOf(f, f.state),
      },
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
        prog,
        // 剩余硬直也是"被感知延迟过的"：我看到的是 lag 秒前的硬直量
        stunLeft: Math.max(0, (opp?.stun ?? 0) - lag),
        landedHit: opp?.landedHit ?? true,
        guardLow: opp?.guardLow ?? false,
        attacking: !!ph,
        down: opp?.state === 'down',
        gettingUp: opp?.state === 'getup',
      },
      // 朝我飞来的投射物，按到达时间排序，最近的在前（含 kind 供 AI 区分 bolt/shuriken）
      incoming: projectiles
        .filter((p) => p.owner !== fighters.indexOf(f) && Math.sign(p.vx) === Math.sign(f.x - p.x))
        .map((p) => ({ x: p.x, y: p.y, vx: p.vx, eta: Math.abs(f.x - p.x) / Math.max(1, Math.abs(p.vx)), kind: p.kind }))
        .sort((a, b) => a.eta - b.eta)
        .slice(0, 3),
    };
  };

  /** 全部招式的键（并集）。注意：AI 实际选招用的是 f.movePool（本英雄自己的库） */
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

  /* ══════════════════════════════════════════════════════════════════════════
   * AI 决策：四层流水线
   * ──────────────────────────────────────────────────────────────────────────
   *    L1 感知  snapshot()（唯一信息源，带 perceiveLag）
   *    L2 评估  timingOf / windowOf / evalMove / evaluatePosition
   *    L3 规划  planIntent / runIntent（Intent 有生命周期，能被打断）
   *    L4 执行  pickBestMove / 连招期望值 / 决策日志
   *
   * 为什么重写而不是继续打补丁：
   *   旧实现是「每 0.14~0.24 秒从零跑一遍 185 行 if 链 + 15 条 w*= 连乘」。
   *   它表达不了三件事：① 计划（下一步干什么）② 时间预算（来不来得及）
   *   ③ 期望值（这一下的收益 × 命中率 − 风险）。每加一种战术就要加一条 if，
   *   所以只能推倒重来。
   *
   * 设计约束（刻意保持）：
   *   · 全部是规则 + 数值，没有学习、没有随机黑箱，每一步都能解释；
   *   · 评估层是纯函数，可单独测；
   *   · 只读 snapshot，不碰 fighters[i] 真身。
   * ══════════════════════════════════════════════════════════════════════════ */

  /** 正在挨打/站不稳的状态：这些时候对手没有防守能力，是白送的输出窗口 */
  const HURT_STATES = ['hurtLight', 'hurtHeavy', 'hurtUp', 'hurtLeg', 'stumble'];

  const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  // ───────────────────────────── L2 评估层 ─────────────────────────────

  /** 招式的帧结构（秒）。全部从数据推出来，不手填 —— 少一份要同步的清单。 */
  interface MoveTiming {
    /** 起手：从出招到第一个判定帧 */
    startup: number;
    /** 判定帧结束 */
    activeTo: number;
    /** 收招：判定结束到动作播完（挥空代价的来源） */
    recovery: number;
    total: number;
  }
  const timingCache = new Map<string, MoveTiming>();
  const timingOf = (f: Fighter, key: string): MoveTiming => {
    const ck = `${f.kitId}:${key}`;
    const hit = timingCache.get(ck);
    if (hit) return hit;
    const a = f.atks[key] ?? ATTACKS[key];
    const dur = clipOf(f, key)?.dur ?? CLIPS[key]?.dur ?? 0.4;
    let first = 0.5;
    let lastAct = 0.5;
    if (a && a.hits.length) {
      first = Math.min(...a.hits.map((h) => h.at));
      lastAct = Math.max(...a.hits.map((h) => h.at + (h.act ?? 0.14)));
    }
    const t: MoveTiming = { startup: first * dur, activeTo: lastAct * dur, recovery: Math.max(0, dur - lastAct * dur), total: dur };
    timingCache.set(ck, t);
    return t;
  };

  /**
   * R-2 时间预算：这一招的判定帧能不能赶在对手硬直结束前落到身上？
   * 这是所有"接招/打康/追击"的合法性前置条件 —— 距离够了不等于能打中，时间也要够。
   */
  const canLandBefore = (f: Fighter, key: string, targetStunLeft: number): boolean =>
    timingOf(f, key).startup <= targetStunLeft + 0.02;

  /** 招式的有效距离窗口（R-5）：不是"够得着就打"，而是"越接近 best 越准" */
  interface MoveWindow { maxGap: number; bestGap: number }
  const windowCache = new Map<string, MoveWindow>();
  const windowOf = (f: Fighter, key: string): MoveWindow => {
    const ck = `${f.kitId}:${key}`;
    const hit = windowCache.get(ck);
    if (hit) return hit;
    const a = f.atks[key] ?? ATTACKS[key];
    const r = reachOf(key);
    const adv = a?.lunge
      ? (a.lunge.startup ?? 0) + (a.lunge.active ?? 0)
      : (a?.forward ?? 0) * 0.3;
    const maxGap = r + Math.max(0, adv);
    const w: MoveWindow = { maxGap, bestGap: Math.max(12, maxGap - 8) };
    windowCache.set(ck, w);
    return w;
  };

  /** R-9 性格参数集中定义：所有"倾向"只在这里出现，不散落在乘子里 */
  interface AIPersonality {
    /** 冒险倾向 0~1：直接乘在 risk 上 */
    risk: number;
    /** 贴脸倾向 0~1：影响是否愿意走近再打 */
    greed: number;
    /** 防御倾向 0~1 */
    guard: number;
    /** 赌招架倾向 0~1 */
    parry: number;
  }
  const personalityOf = (f: Fighter): AIPersonality => {
    const b = GEAR_SPEC[f.build].behavior;
    const g = clampN(f.guardChance, 0, 1);
    if (b === 'turtle') return { risk: 0.3, greed: 0.35, guard: Math.max(0.72, g), parry: 0.55 };
    if (b === 'rusher') return { risk: 0.82, greed: 0.85, guard: Math.min(0.3, g), parry: 0.12 };
    if (b === 'punisher') return { risk: 0.45, greed: 0.5, guard: g, parry: 0.45 };
    if (b === 'zoner') return { risk: 0.32, greed: 0.25, guard: g, parry: 0.28 };
    if (b === 'trickster') return { risk: 0.62, greed: 0.6, guard: g * 0.85, parry: 0.34 };
    return { risk: 0.6, greed: 0.75, guard: g, parry: 0.22 }; // brawler
  };

  /**
   * R-11 局面分：−1（我快输了）… +1（我占优）。
   * 它只提供一个宏观偏置，具体"该冒险还是该收手"由规划层读它。
   */
  const evaluatePosition = (f: Fighter, snap: FightSnapshot): number => {
    const hpEdge = (f.hp - snap.opponent.hp) / 100;                 // 血量差（主项）
    const guardEdge = (f.guard - snap.opponent.guard) / 220;         // 架势差（次项）
    const d = snap.self.distance;
    // 距离优势：站在自己舒服的间距上加分，被贴身或太远都略吃亏
    const spacing = d > f.preferDist + 26 ? -0.1 : d < 14 ? -0.12 : 0.08;
    return clampN(hpEdge * 0.72 + guardEdge * 0.2 + spacing, -1, 1);
  };

  /** 单招评估结果（决策日志也用它，所以字段要能解释得分） */
  interface MoveEval {
    key: string;
    gap: number;
    hitChance: number;
    reward: number;
    risk: number;
    style: number;
    score: number;
    note: string;
  }

  /**
   * R-3 四元组评分：score = style × (命中率 × 收益 − (1−命中率) × 风险)
   *
   * 取代原来 15 条 `w *=` 的乘法塔：
   *   · 命中率：距离窗口（R-5）+ 段位 vs 对手防御 + 对手是否硬直
   *   · 收益：期望伤害 + 击倒/击退的位置价值
   *   · 风险：收招时长（挥空被反打的代价）
   *   · 风格：只做线性加权，不参与乘 —— 保证调风格不改变收益/风险排序
   */
  const evalMove = (f: Fighter, key: string, snap: FightSnapshot, pers: AIPersonality, pos: number): MoveEval => {
    const a = f.atks[key] ?? ATTACKS[key];
    const meta = MOVE_META[key];
    const ob = snap.opponent;
    const gap = snap.self.distance;
    const win = windowOf(f, key);
    const t = timingOf(f, key);
    const power = a.hits.reduce((sum, h) => sum + (h.dmg[0] + h.dmg[1]) / 2, 0);
    const height: 'high' | 'mid' | 'low' = a.hits[0]?.height ?? 'high';

    // ── ① 命中率 ──
    let hc = 0.5;
    let note = '';
    if (a.projectile) {
      hc = gap > 26 ? 0.7 : 0.08;
      note = 'projectile';
    } else if (gap > win.maxGap) {
      return { key, gap, hitChance: 0, reward: 0, risk: 0, style: 0, score: -999, note: 'out-of-window' };
    } else {
      // 越偏离「最舒服的间距」越难命中；贴到窗口边缘再打一次折
      const dev = Math.abs(gap - win.bestGap) / Math.max(6, win.maxGap);
      hc = 0.9 - dev * 0.55;
      if (gap > win.maxGap * 0.9) {
        hc *= 0.55;
        note = 'edge';
      }
    }
    if (ob.state === 'block') {
      // 择：他站防我打下段/他蹲防我打中段 → 几乎必中；上段会被稳稳挡下
      if (height === 'low' && !ob.guardLow) hc = Math.max(hc, 0.86);
      else if (height === 'mid' && ob.guardLow) hc = Math.max(hc, 0.86);
      else if (height === 'high') {
        hc *= 0.3;
        note = note || 'blocked';
      }
    }
    // 对手处于「能自由行动」的状态时，命中率必须打折 —— 他会挡、会躲、会跑
    const neutral = !HURT_STATES.includes(ob.state) && !ob.guardBreak && ob.state !== 'block' && !ob.recovering;
    if (neutral) {
      const slow = t.startup > 0.22 ? 0.62 : 0.82;   // 越慢的招越容易被看穿
      hc *= slow;
      note = note || 'neutral';
    }
    // 他躺在地上：任何招都打不到（以前把 down 当普通硬直，于是疯狂对空气出招）
    if (ob.down) {
      hc *= 0.08;
      note = 'target-down';
    } else if (ob.gettingUp) {
      // 起身动作本身没有防御 —— 这是唯一能"压起身"的窗口
      hc = Math.min(0.98, hc * 1.2);
      note = note || 'okizeme';
    }
    if (ob.guardBreak) hc = Math.min(0.98, hc * 1.4);
    if (HURT_STATES.includes(ob.state)) hc = Math.min(0.98, hc * 1.45);
    hc = clampN(hc, 0.02, 0.98);

    // ── ② 收益（伤害取 0.8 次幂：边际收益递减，避免"伤害最高那招"通吃） ──
    let reward = Math.pow(Math.max(1, power), 0.8) + (a.hits[0].knock > 320 ? 3 : 0);
    if (ob.guardBreak) reward *= 1.3;
    if (HURT_STATES.includes(ob.state)) reward *= 1.15;

    // ── ③ 风险：挥空后暴露的收招时间。收招越长、越容易被反打 ──
    let risk = 4 + t.recovery * 30;
    if (meta?.breakGuard) risk *= 0.8; // 破防招即使被挡也有价值

    // ── ④ 风格（线性） ──
    let style = 1;
    const spec = GEAR_SPEC[f.build];
    if ((spec.moves ?? []).includes(key)) style *= 1.2;  // 招牌招稍微偏爱
    if (pos < -0.3 && t.startup > 0.25) style *= 0.7;    // 落后时不赌慢招
    if (pos > 0.3 && t.recovery > 0.3) style *= 0.85;    // 领先时少冒大险
    style *= 0.9 + pers.greed * 0.2;

    let score = style * (hc * reward - (1 - hc) * risk * pers.risk);

    /*
     * 复读惩罚（Novelty）：最近 3 秒内用过的招打折。
     * 没有它，AI 会一直刷期望值最高的那一招（拔刀斩/侧踹），看起来像复读机。
     */
    const recent = f.recentMoves.find((r) => r.k === key);
    if (recent) {
      const age = elapsed - recent.t;
      if (age < 3) score *= 0.55 + 0.15 * (age / 3);
    }
    return { key, gap, hitChance: hc, reward, risk, style, score, note };
  };

  /** 评估整池（本英雄自己的招），按分数降序 */
  const evalMoves = (f: Fighter, snap: FightSnapshot, pers: AIPersonality, pos: number): MoveEval[] => {
    const pool = f.movePool.length ? f.movePool : ATTACK_KEYS;
    const out: MoveEval[] = [];
    for (const k of pool) {
      if (!f.atks[k]) continue;
      out.push(evalMove(f, k, snap, pers, pos));
    }
    return out.sort((x, y) => y.score - x.score);
  };

  /**
   * 从评估表里挑一个（L4）。不直接取第一名 ——
   * 取前 3 名按分数加权抽，既有偏好又不至于每局一模一样。
   */
  const pickBestMove = (
    f: Fighter,
    snap: FightSnapshot,
    pers: AIPersonality,
    pos: number,
    opts2?: { fastOnly?: boolean; allowRisky?: boolean },
  ): { key: string | null; table: MoveEval[] } => {
    const table = evalMoves(f, snap, pers, pos);
    let cands = table.filter((e) => e.score > -900 && (e.hitChance > 0.05 || e.key && (f.atks[e.key]?.projectile)));
    if (opts2?.fastOnly) {
      // 差合/打康：只要起手快的，慢招在对手恢复前根本出不来
      cands = cands.filter((e) => timingOf(f, e.key).startup <= 0.22).sort((x, y) => timingOf(f, x.key).startup - timingOf(f, y.key).startup);
    }
    if (opts2?.allowRisky === false) cands = cands.filter((e) => e.risk < 14);
    if (!cands.length) return { key: null, table };
    const top = cands.slice(0, opts2?.fastOnly ? 2 : 3);
    const w = top.map((e) => Math.max(0.5, e.score));
    const total = w.reduce((x, y) => x + y, 0);
    let r = random() * total;
    for (let i = 0; i < top.length; i++) {
      r -= w[i];
      if (r <= 0) return { key: top[i].key, table };
    }
    return { key: top[0].key, table };
  };

  // ───────────────────────────── L3 规划层 ─────────────────────────────

  /** 对手画像的三个比率（R-8），带平滑避免小样本失真 */
  const oppRates = (f: Fighter) => {
    const m = f.oppModel;
    const n = m.guardLow + m.guardHigh;
    return {
      guardLowRate: (m.guardLow + 1) / (n + 2),
      counterRate: (m.counter + 0.5) / (m.blockN + 2),
      whiffRate: (m.whiff + 0.5) / (m.atkN + 2),
      samples: n,
    };
  };

  /**
   * 记录「对手」的一次行为（R-8）。f 是观察者。
   * 滑动计数：超过 30 就对折，保证记的是"最近的习惯"而不是历史总量。
   */
  const noteOpp = (f: Fighter, ev: 'blockLow' | 'blockHigh' | 'atkStart' | 'whiff') => {
    const m = f.oppModel;
    m.at = elapsed;
    if (ev === 'blockLow' || ev === 'blockHigh') {
      m.blockN += 1;
      m.blkAt = elapsed;
      if (ev === 'blockLow') m.guardLow += 1; else m.guardHigh += 1;
      if (m.blockN > 30) { m.blockN *= 0.5; m.counter *= 0.5; }
      if (m.guardLow + m.guardHigh > 30) { m.guardLow *= 0.5; m.guardHigh *= 0.5; }
    } else if (ev === 'atkStart') {
      m.atkN += 1;
      // 关键读点：他是不是"刚挡下我就立刻抢招"——爱抢的人可以用骗招治
      if (elapsed - m.blkAt < 0.4) m.counter += 1;
      m.atkAt = elapsed;
      if (m.atkN > 30) { m.atkN *= 0.5; m.whiff *= 0.5; }
    } else {
      m.whiff += 1;
    }
  };

  type IntentKind = 'probe' | 'bait' | 'pressure' | 'punish' | 'whiffPunish' | 'defend' | 'parryBait' | 'reset';
  interface Intent { kind: IntentKind; until: number; move?: string; punishWith?: string; tag?: string }

  /** 这些情况必须打断当前意图、立刻重新规划（"秒切"的来源） */
  const mustReact = (snap: FightSnapshot): boolean => {
    const ob = snap.opponent;
    if (ob.recovering && !ob.landedHit) return true;              // 他挥空了 → 差合
    if (HURT_STATES.includes(ob.state)) return true;              // 他硬直了 → 白送
    if (ob.windingUp && snap.self.distance < ob.threatRange + 8) return true; // 他要打我了
    return false;
  };

  /**
   * 规划：根据「局面分 + 对手画像 + 当前距离」选一个意图。
   * 意图是"接下来这 0.3~1.2 秒我要干什么"，不是"这一帧出什么招"。
   */
  const planIntent = (f: Fighter, snap: FightSnapshot, pers: AIPersonality, pos: number): Intent => {
    const ob = snap.opponent;
    const d = snap.self.distance;
    const rates = oppRates(f);
    const now = elapsed;

    // ⓪ 他躺在地上：别空挥，等他起来（或者贴上去准备压起身）
    if (ob.down) {
      return { kind: 'reset', until: now + 0.3 };
    }
    // ⓪·二 他正在起身：唯一能压起身的窗口 —— 贴上去打，但只能用来得及的招
    if (ob.gettingUp) {
      return { kind: 'pressure', until: now + 0.35 };
    }

    // ① 破绽类（优先级最高，因为窗口最短）
    if (ob.recovering && !ob.landedHit && d < ob.threatRange + 30) {
      // 差合：他挥空了。用最快的招去抓，抓完再补一手
      return { kind: 'whiffPunish', until: now + 0.55 };
    }
    if (ob.recovering) return { kind: 'punish', until: now + 0.45 };
    if (HURT_STATES.includes(ob.state)) return { kind: 'pressure', until: now + 0.65 };

    // ② 他在起手：要么防，要么赌招架（看性格 + 他爱不爱抢）
    if (ob.windingUp && d < ob.threatRange + 10) {
      const gamble = pers.parry * (0.6 + rates.counterRate * 0.8);
      return { kind: random() < gamble ? 'parryBait' : 'defend', until: now + 0.32 };
    }

    // ③ 局面落后 → 重置；领先 → 压制
    if (pos < -0.28) return { kind: 'reset', until: now + 0.8 };
    if (pos > 0.32 && d < f.preferDist + 26) return { kind: 'pressure', until: now + 1.0 };

    // ④ 对手爱抢招（挡下我的招之后会还手）→ 故意抛一招骗他，然后招架
    if (rates.counterRate > 0.45 && rates.samples >= 3 && d < f.preferDist + 20 && random() < 0.5) {
      return { kind: 'bait', until: now + 0.8 };
    }

    // ⑤ 默认：试探
    return { kind: 'probe', until: now + 0.85 };
  };

  /**
   * 执行意图 → 具体 Decision。
   * 每个意图只负责"这一步"；跨步骤的记忆放在 intent 上（tag/move）。
   */
  const runIntent = (f: Fighter, snap: FightSnapshot, pers: AIPersonality, pos: number, it: Intent): Decision => {
    const d = snap.self.distance;
    const canAct = snap.self.cool <= 0 && snap.self.stunLeft <= 0;

    switch (it.kind) {
      case 'whiffPunish': {
        if (!canAct) return 'wait';
        if (d > f.preferDist + 8) return 'approach'; // 先贴近，别在射程外干挥
        const { key } = pickBestMove(f, snap, pers, pos, { fastOnly: true });
        if (key) {
          it.tag = 'thrown';
          return key as Decision;
        }
        return 'wait';
      }

      case 'punish':
      case 'pressure': {
        if (!canAct) {
          // 冷却中：贴上去等（别站原地发呆，也别越走越远）
          return d > f.preferDist ? 'approach' : 'wait';
        }
        if (d > f.preferDist + 10) return 'approach';
        const { key } = pickBestMove(f, snap, pers, pos, { allowRisky: pos > -0.2 });
        if (key) {
          it.tag = 'thrown';
          return key as Decision;
        }
        return 'wait';
      }

      case 'probe': {
        // 试探 = 抛一记轻招，然后看他是怎么防的（观察期不换意图）
        if (it.tag === 'thrown') {
          if (d > f.preferDist + 6) return 'approach';
          return random() < 0.5 ? 'wait' : 'retreat'; // 抛完就后撤半步，看他反应
        }
        if (!canAct) return d > f.preferDist + 10 ? 'approach' : 'wait';
        const { key, table } = pickBestMove(f, snap, pers, pos, { allowRisky: false });
        if (key) {
          it.tag = 'thrown';
          it.move = key;
          it.punishWith = table[0]?.key;
          return key as Decision;
        }
        // 没有能安全打的招（距离不对/都在大硬直）→ 先挪到能打的间距
        return d > f.preferDist ? 'approach' : 'retreat';
      }

      case 'bait': {
        // 骗招：故意抛一记快的（哪怕打空），然后立刻准备招架他反打
        if (it.tag === 'thrown') {
          // 抛完：他如果抢进来，就赌招架；否则退开重置
          if (snap.opponent.attacking && snap.self.guardLock <= 0) return 'parry';
          return 'retreat';
        }
        if (!canAct) return 'wait';
        const { key } = pickBestMove(f, snap, pers, pos, { allowRisky: false });
        if (key) {
          it.tag = 'thrown';
          return key as Decision;
        }
        return 'wait';
      }

      case 'defend': {
        const corRate = oppRates(f).counterRate;
        // 被压到角落 + 他贴身起手 → 翻滚脱离（带无敌帧）
        const cornered = f.x <= f.minX + 40 || f.x >= f.maxX - 40;
        if (cornered && d < 40 && snap.self.cool <= 0) return 'roll';
        // 一般情况：举盾（站/蹲防由 applyDecision 按他最近段位选）
        if (random() < pers.guard || corRate > 0.5) return 'block';
        return 'retreat';
      }

      case 'parryBait': {
        // 赌招架一次；赌完就转防御/后撤（不连续赌）
        if (snap.self.guardLock > 0 || snap.self.parryT > 0) return 'block';
        return 'parry';
      }

      case 'reset': {
        if (d < f.preferDist + 18) return 'retreat';
        return random() < 0.5 ? 'wait' : 'approach';
      }

      default:
        return 'wait';
    }
  };

  // ───────────────────────────── L4 决策日志 ─────────────────────────────

  interface AILogRec {
    t: number;
    who: number;
    gap: number;
    pos: number;
    intent: string;
    picked: string;
    top: { k: string; s: number; hc: number }[];
  }
  const aiLog: AILogRec[] = [];
  const logAI = (rec: AILogRec) => {
    aiLog.push(rec);
    if (aiLog.length > 240) aiLog.shift();
  };

  /* ───────────────────────────── 决策入口 ───────────────────────────── */

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

    const pers = personalityOf(f);
    const pos = evaluatePosition(f, snap);

    // 战斗阶段（用于步法脉冲与调试面板）：暂时由局面分驱动
    {
      const want: 'probing' | 'engagement' | 'reset' = pos < -0.25 ? 'reset' : pos > 0.2 ? 'engagement' : 'probing';
      if (f.phase !== want) {
        f.phase = want;
        f.phaseT = 0;
      }
    }

    // 意图：过期或被"必须反应"的事件打断 → 重新规划
    if (f.intent && (elapsed >= f.intent.until || mustReact(snap))) {
      f.intent = null;
    }
    if (!f.intent) f.intent = planIntent(f, snap, pers, pos);

    let d = runIntent(f, snap, pers, pos, f.intent);

    // 出招饥饿保护：太久没出手且冷却好了，必须打一下（否则两个 AI 会互相干瞪眼）
    if (
      d === 'wait' &&
      snap.self.cool <= 0 &&
      snap.self.sinceAttack > 1.1 &&
      snap.self.distance < 70
    ) {
      const { key } = pickBestMove(f, snap, pers, pos);
      if (key) d = key as Decision;
    }

    // 记下这次出的招（novelty 惩罚的输入）
    if (atkOf(f, d)) {
      f.recentMoves.unshift({ k: d, t: elapsed });
      if (f.recentMoves.length > 4) f.recentMoves.length = 4;
    }

    if (debugOptions.frames) {
      const table = evalMoves(f, snap, pers, pos).slice(0, 3);
      logAI({
        t: elapsed,
        who: fighters.indexOf(f),
        gap: snap.self.distance,
        pos,
        intent: `${f.intent.kind}${f.intent.tag ? '/' + f.intent.tag : ''}`,
        picked: d,
        top: table.map((e) => ({ k: e.key, s: Math.round(e.score * 10) / 10, hc: Math.round(e.hitChance * 100) / 100 })),
      });
    }

    return d;
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
      case 'block': {
        // 破防中举不起盾，改成后撤（低架势是否举盾由 heuristic 的 guardUp 决定）
        if (f.guardBreak > 0 || f.guardLock > 0) {
          setState(f, 'retreat', rand(0.3, 0.5));
          break;
        }
        setState(f, 'block');
        // 站防 / 蹲防：读对手最近用的段位来猜（猜错就吃满伤害，这是"择"）
        const seen = f.lastSeenHeight;
        f.guardLow = seen === 'low' ? random() < 0.78 : seen === 'mid' ? random() < 0.12 : random() < 0.34;
        f.cool = Math.max(f.cool, 0.25);
        f.intentLock = 0.25;
        break;
      }
      case 'parry':
        // 赌招架：进入招架姿态 active 秒。这期间被打中 = 招架成功；
        // 撑完没被打中 = 防御封锁 failRecovery 秒（挡不住也招架不了）。
        if (f.guardBreak > 0 || f.guardLock > 0) {
          setState(f, 'retreat', rand(0.3, 0.5));
          break;
        }
        setState(f, 'block');
        f.parryT = PARRY_DEF.active;
        f.guardLow = f.lastSeenHeight === 'low';
        f.cool = Math.max(f.cool, 0.18);
        f.intentLock = 0.12;
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
        // 翻滚不用 leap（那会给一个会衰减的初速度 = 打滑）。
        // 位移改由「转过的角度 × 滚动半径」算出来，见 update 里的 roll 分支。
        f.leap = 0;
        f.rollX0 = f.x;
        f.rollR = 26 * f.scale;
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
          // 落地弹一下：接触瞬间把竖直速度乘以 -0.32 反弹（弹两下就躺平）。
          // 一帧直接拍死在地上 = "纸片人"，是受击手感发虚的常见原因。
          const vy = p.y - p.py;
          p.y = gy;
          // 沉稳的倒地：只轻轻回弹一次（0.22），之后立刻吃掉竖直速度 → 贴地不起
          if (vy > 2.8 && !f.landedBounce) {
            f.landedBounce = true;
            p.py = p.y + vy * 0.22;
          } else {
            p.py = p.y;
          }
          // 地面摩擦：横向速度砍半
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
    const fighting = atkOf(f, f.state) || atkOf(opp, opp.state) || f.state === 'down' || f.state === 'stumble';
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
    kind: 'attack' | 'react' | 'jump' | 'roll' | 'ko';
    /** 演示站位距离（仅 attack 用） */
    gap?: number;
  }

  /** 招式展示名与演示站位（全局目录；具体叫法以各英雄 kit 里的 label 为准） */
  const MOVE_INFO: Record<string, { name: string; gap?: number }> = {
    // 拳
    jab: { name: '刺拳 Jab' },
    cross: { name: '直拳 Cross' },
    hook: { name: '摆拳 Hook' },
    uppercut: { name: '上勾拳 Uppercut' },
    elbow: { name: '肘击 Elbow', gap: 44 },
    // 腿
    snapKick: { name: '弹腿 Snap Kick' },
    pushKick: { name: '正蹬 Push Kick' },
    sideKick: { name: '侧踹 Side Kick' },
    roundKick: { name: '鞭腿 Round Kick' },
    axeKick: { name: '下劈腿 Axe Kick' },
    spinKick: { name: '后旋踢 Spin Kick' },
    flyKick: { name: '飞踢 Flying Kick' },
    scissorKick: { name: '双飞脚 Scissor Kick' },
    knee: { name: '膝撞 Knee', gap: 40 },
    // 兵器
    thrust: { name: '突刺 Thrust', gap: 86 },
    smash: { name: '抡砸 Smash', gap: 56 },
    bash: { name: '盾击 Bash', gap: 48 },
    slash: { name: '横斩 Slash', gap: 50 },
    lowSlash: { name: '下段斩 Low Slash', gap: 52 },
    risingSlash: { name: '上撩斩 Rising Slash', gap: 52 },
    palm: { name: '推掌 Palm', gap: 44 },
    swing: { name: '横扫 Swing', gap: 66 },
    iai: { name: '居合斩 Iai', gap: 88 },
    flailSwing: { name: '链锤 Flail', gap: 48 },
    gearPunch: { name: '机关拳 Gear Punch', gap: 54 },
    bolt: { name: '弩箭 Bolt' },
    shuriken: { name: '飞镖 Shuriken' },
    // 特殊
    throw: { name: '投技 Throw', gap: 40 },
    counterStrike: { name: '反击 Counter', gap: 56 },
  };

  /** 演示里的排列顺序：拳 → 肘膝 → 腿 → 兵器 → 投/反击 */
  const DEMO_ORDER = [
    'jab', 'cross', 'hook', 'uppercut', 'elbow', 'knee',
    'snapKick', 'pushKick', 'sideKick', 'roundKick', 'axeKick', 'spinKick', 'flyKick', 'scissorKick',
    'thrust', 'smash', 'bash', 'slash', 'lowSlash', 'risingSlash', 'palm', 'swing', 'iai', 'flailSwing', 'gearPunch', 'bolt', 'shuriken',
    'throw', 'counterStrike',
  ];

  /** 与具体英雄无关的状态/受击演示项（永远排在列表最后） */
  const STATE_ENTRIES: DemoEntry[] = [
    { key: 'idle', name: '待机 Idle', kind: 'react' },
    { key: 'block', name: '格挡 Block', kind: 'react' },
    { key: 'crouch', name: '下蹲 Crouch', kind: 'react' },
    { key: 'jump', name: '跳跃 Jump', kind: 'jump' },
    { key: 'roll', name: '翻滚 Roll', kind: 'roll' },
    { key: 'hurtLight', name: '受击·轻 Hurt Light', kind: 'react' },
    { key: 'hurtHeavy', name: '受击·重 Hurt Heavy', kind: 'react' },
    { key: 'hurtUp', name: '受击·下巴 Hurt Up', kind: 'react' },
    { key: 'hurtLeg', name: '受击·腿 Hurt Leg', kind: 'react' },
    { key: 'tired', name: '喘息 Tired', kind: 'react' },
    { key: 'ko', name: '倒地 → 起身 KO & Get Up', kind: 'ko' },
  ];

  /**
   * 当前演示列表 = 本英雄自己的招式（按 DEMO_ORDER 排）+ 通用状态项。
   *
   * 关键：只列「这个英雄真的会的招」。剑客的列表里不会出现大锤，
   * 想看别的英雄的招就换角色（下拉框），而不是让演示偷偷换人。
   */
  const buildDemoList = (): DemoEntry[] => {
    const a = fighters[0];
    const kit = a ? a.atks : {};
    const own = Object.keys(kit);
    const ordered = [
      ...DEMO_ORDER.filter((k) => own.includes(k)),
      ...own.filter((k) => !DEMO_ORDER.includes(k)).sort(),
    ];
    const attacks: DemoEntry[] = ordered.map((k) => {
      const info = MOVE_INFO[k];
      const label = kit[k]?.label;
      return {
        key: k,
        name: label ? label : info ? info.name : k,
        kind: 'attack',
        gap: info?.gap,
      };
    });
    return [...attacks, ...STATE_ENTRIES];
  };

  let demoIdx = 0;
  let demoTimer = 0;
  let demoPaused = false;
  let demoSlow = false;
  /**
   * 自动轮播开关。
   * - true：播完一招自动切下一招（首次进入时的"巡演"模式）
   * - false：锁定当前招式，反复只播这一招（用户点了某一招之后就该是这样）
   */
  let demoAuto = true;

  const demoDur = (e: DemoEntry) => {
    if (e.kind === 'attack') return (clipOf(fighters[0], e.key)?.dur ?? 0.6) + 0.65;
    if (e.kind === 'react') return (clipOf(fighters[0], e.key)?.dur ?? 0.4) + 0.55;
    if (e.kind === 'ko') return 3.0;
    return 1.3;
  };

  const startDemoEntry = (i: number) => {
    if (!opts.demo) return;
    const list = buildDemoList();
    const n = list.length || 1;
    demoIdx = ((i % n) + n) % n;
    demoTimer = 0;
    // 换招时清掉上一招的判定读数，避免读数条显示过期数据误导调参
    debugGeo = null;
    debugHitPoint = null;
    debugDemo = '';
    // 换招时清掉上一招残留的特效/伤害数字，避免串味
    popups = [];
    sparks = [];
    impactRings = [];
    speedLines = [];
    const e = list[demoIdx];
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

    // 受击/状态演示不需要对手贴脸站着，往边上挪开，单独看英雄自己的动作
    d.x = cx + demoGap + (e.kind === 'react' ? 110 : 0);
    d.facing = -1;
    d.kb = 0;
    d.hp = d.maxHp;
    d.ragdoll = null;
    d.pose = { ...GUARD };
    d.state = 'idle';
    d.clipT = 0;
    d.clipDur = CLIPS.idle.dur;

    if (e.kind === 'attack') {
      const atk0 = atkOf(a, e.key);
      const h0 = atk0?.hits[0];
      if (atk0 && h0 && !atk0.projectile) {
        /*
         * DEMO 定位：反推起手位置，不是预估攻击点
         * ------------------------------------------------------------
         * 旧做法：先算「命中帧攻击点」，再把目标放到攻击点旁边。
         *   但预估用的姿态/位移和运行时不一致 → 要么隔空，要么穿模。
         * 新做法：目标位置固定，倒推出招者的起手 x ——
         *   因为前冲已是 prog 的纯函数，命中帧位置完全可预测，
         *   所以「几何上一定重叠」可以精确算出来，一个 offset 参数都不需要。
         */
        const clip0 = clipOf(a, e.key) ?? CLIPS.idle;
        const savedPose = a.pose;
        const savedX = a.x;

        // ① 目标固定在画面右侧的「受击位」
        const targetX = Math.max(a.minX + 30, Math.min(a.maxX - 30, cx + 96));
        d.x = targetX;

        // ② 让出招者摆出「命中帧姿态」，临时挪到原点量出武器几何的相对位置
        a.x = 0;
        a.pose = sampleClip(clip0, h0.at);
        const relVol = buildHitVolume(a, h0.part ?? atk0.part, h0.tip ?? 0, (h0.w ?? 0) * a.scale, h0.sori ?? 0);
        a.x = savedX;
        a.pose = savedPose;

        // ③ 命中帧相对起手点的前冲量（与运行时同一公式，含 0.62 封顶）
        // 反推用的位移量必须和运行时同一个函数算，否则 DEMO 的站位和实跑差几像素就判不中
        const fwdAtHit = lungeDistAt(atk0, h0.at, clip0.dur);

        // ④ 反推：先按躯干半径给一个解析初值，再用「真实几何」做线性修正。
        //    修正过程直接调 buildHurtParts + capsuleVsCapsule（和运行时同一套代码），
        //    所以不依赖任何半径假设，任何体型/任何姿态都能精确定位。
        const torsoR = 7 + d.scale * 3;
        const overlapPx = 6;
        const extreme = a.facing > 0
          ? Math.max(relVol.p1.x, relVol.p2.x)
          : Math.min(relVol.p1.x, relVol.p2.x);
        const startX0 = targetX - a.facing * fwdAtHit - extreme - a.facing * (torsoR - overlapPx);

        const axHit0 = startX0 + a.facing * fwdAtHit;
        const volAt = (px: number): HitVolume => ({
          p1: { x: relVol.p1.x + px, y: relVol.p1.y, z: relVol.p1.z },
          p2: { x: relVol.p2.x + px, y: relVol.p2.y, z: relVol.p2.z },
          radius: relVol.radius,
        });
        const partsNow = buildHurtParts(d);
        let bestOff = 0;
        let bestPen = -Infinity;
        for (let k = 0; k <= 200; k++) {
          const off = k * 0.5; // 沿朝向最多挪 100px
          const v = volAt(axHit0 + a.facing * off);
          let pen = -Infinity;
          for (const p of partsNow) pen = Math.max(pen, capsuleVsCapsule(v, p.vol).penetration);
          if (pen > bestPen) { bestPen = pen; bestOff = off; }
          if (pen >= 5) break; // 压进身体 5px 就够，再往里就变穿模
        }
        a.x = Math.max(a.minX, Math.min(a.maxX, startX0 + a.facing * bestOff));
        demoPin = { a: a.x, d: d.x };

        if (debugOptions.frames) {
          debugDemo =
            `demo ${e.key} tgt=${targetX.toFixed(0)} ext=${extreme.toFixed(0)} ` +
            `s0=${startX0.toFixed(0)} off=${bestOff.toFixed(1)} pen=${bestPen.toFixed(1)} ax=${a.x.toFixed(0)}`;
          console.log(`[DEMO] ${debugDemo}`);
        }
      }
      setState(a, e.key as State);
    } else if (e.kind === 'react') {
      // 受击/格挡/待机这类状态演示，要演「本英雄自己」的动作（受击动作是分英雄的）
      setState(a, e.key as State);
    } else if (e.kind === 'roll') {
      // 翻滚要连「方向 + 横向位移」一起给，否则只有团身姿态、没有滚动
      a.rollDir = 1;
      a.leap = a.facing * 165;
      setState(a, 'roll');
    } else if (e.kind === 'jump') {
      setState(a, 'jump');
    } else if (e.kind === 'ko') {
      d.hp = 0;
      startRagdoll(d);
    }
  };

  const update = (dt: number) => {
    elapsed += dt;
    if (debugHitPoint) {
      debugHitPoint.life -= dt;
      if (debugHitPoint.life <= 0) debugHitPoint = null;
    }

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
        // 布片柔体链（design-3 §2）：极坐标解算 + 身体碰撞 + 瞬移硬复位。
        // 替代旧的单点 stepDangle —— 单点只有末端一根弹簧，中间永远是直线（「棍化」根源）。
        if (!f.clothChain) f.clothChain = makeClothChain(spec.cloth, f.scale);
        const env: DecoEnv = {
          joints: world as unknown as JointView,
          facing: f.facing as 1 | -1,
          k: f.scale,
          t: elapsed,
          windX: WIND_AMBIENT,
          windPulse: f.windPulse,
          circles: f.clothChain.spec.collide
            ? bodyCircles(world as unknown as JointView, f.scale)
            : [],
        };
        // 根锚点局部偏移：披风根略偏背后（facing 镜像），兜帽尾贴后脑
        const ox = spec.cloth === 'apron' ? 0 : spec.cloth === 'hoodTail' ? -2 : spec.cloth === 'shoulderCape' ? 3 : 2;
        const root = {
          x: a.x - f.facing * ox * f.scale,
          y: a.y + (spec.cloth === 'hoodTail' ? 2 : -1) * f.scale,
          z: a.z,
        };
        stepChain(f.clothChain, root, env, effectiveDt);
        // 风脉冲衰减（帧率无关，半衰期 ≈115ms）：hitstop 冻结帧里布还在飘
        if (f.windPulse !== 0) f.windPulse *= Math.exp(-DECO_CFG.windPulse.decay * effectiveDt);
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

    // 演示模式：按需切换 / 循环当前招式，并保持防守方不死
    if (opts.demo) {
      demoTimer += dt * (demoSlow ? 0.35 : 1);
      const dd = fighters[1];
      if (dd && dd.state !== 'down' && dd.state !== 'getup') dd.hp = dd.maxHp;
      const dl = buildDemoList();
      if (!demoPaused && demoTimer > demoDur(dl[Math.min(demoIdx, dl.length - 1)])) {
        // demoAuto=false（用户点了某一招）= 只反复播这一招，不往后跳
        startDemoEntry(demoAuto ? demoIdx + 1 : demoIdx);
      }
    }

    for (const f of fighters) {
      f.bob += dt;

      // 闪白只该闪 2~3 帧：衰减到 0 约 0.11s，配合 >0.55 才变白 → 白身持续约 3 帧。
      // 以前 dt*4.5 让整个人白了 0.16s，看着像打了个高光灯。
      f.flash = Math.max(0, f.flash - dt * 9);
      // 挤压 2.4 帧左右收干（dt*26 ≈ 0.038s），抖动跟着顿帧一起收
      f.squash = Math.max(0, f.squash - dt * 26);
      f.hitShake = Math.max(0, f.hitShake - dt * 30);
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
      if (oppF && !atkOf(f, f.state) && f.state !== 'approach' && f.state !== 'retreat' && f.state !== 'jump' && f.state !== 'down') {
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
      // 跟进步（step-in）：招式收招后「距离不够就垫半步」的那部分位移。
      // 它属于 locomotion（步法），和招式自己的 lunge 分开：
      // 刺拳打不到是「该垫步」，不是「刺拳的 forward 该调大」。
      if (f.stepInLeft > 0 && f.state !== 'down') {
        const step = Math.min(f.stepInLeft, 320 * dt);
        f.x = Math.max(f.minX, Math.min(f.maxX, f.x + f.facing * step));
        f.stepInLeft -= step;
        if (f.stepInLeft < 0.5) f.stepInLeft = 0;
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
            // 起身保护：前 60% 无敌，避免"倒地 → 起手瞬间又被踩"的无限连。
            // 剩下的 40% 故意不给无敌，留着让人压起身（这是格斗游戏的攻防节奏）。
            f.invuln = Math.max(f.invuln, (clipOf(f, 'getup')?.dur ?? 0.4) * 0.6);
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
      // 连续防御时长：招架判定读它（进入防御后的头几帧被打中才算招架）
      if (f.state === 'block') f.blockT += dt;
      else f.blockT = 0;
      f.phaseT += dt;
      if (f.feintT > 0) f.feintT = Math.max(0, f.feintT - dt);

      // 招架姿态：撑完还没被打中 = 赌输了 → 进入防御封锁（比普通格挡更长的硬直）
      if (f.parryT > 0) {
        f.parryT = Math.max(0, f.parryT - dt);
        if (f.parryT === 0) {
          f.guardLock = PARRY_DEF.failRecovery;
          if (f.state === 'block') {
            setState(f, 'idle');
            f.cool = Math.max(f.cool, PARRY_DEF.failRecovery);
          }
          popups.push({ x: f.x, y: groundY() - 74, text: 'PARRY MISS', life: 0, max: 0.6, color: '#8899AA' });
        }
      }
      if (f.guardLock > 0) f.guardLock = Math.max(0, f.guardLock - dt);

      // 共享的空间真相（四段距离）：步法 / 连招图 / AI 都读它
      {
        const oS = fighters[f.partner];
        if (oS) {
          const gS = Math.abs(oS.x - f.x);
          const rS = bestReachOf(f);
          f.spatial = gS > rS + 14 ? 'out' : gS > rS - 10 ? 'edge' : gS > 26 ? 'in' : 'close';
          // 看到对手在出招 → 记下段位，决定自己下一次站防还是蹲防
          const oAtkS = atkOf(oS, oS.state);
          if (oAtkS) f.lastSeenHeight = oAtkS.hits[0]?.height ?? 'high';
        }
      }

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
          /*
           * 步法脉冲：试探期是「进几步 → 停半拍 → 再进」，不是匀速滑过去。
           * 停顿本身就是节奏；匀速前进看久了就是"两个人黏在一起平移"。
           */
          const pulse = f.phase === 'engagement'
            ? 1
            : Math.sin(f.phaseT * 7.5) > -0.15 ? 1 : 0.12;
          f.x += f.facing * (rush ? 104 : 54) * pulse * dt;
          f.walkPhase += dt * 1.9;
          f.pose = lerpPose(f.pose, walkPose(f.walkPhase), 1 - Math.exp(-dt * 22));
        } else if (f.state === 'retreat' && f.clipT < f.clipDur) {
          // 后撤是短暂的规避动作：要撤得干脆，一脚退出对手射程。
          // 后撤步 = 步态周期**倒放**（相位递减）：脚先向后伸、再向后蹬 —— 大腿
          // 和小腿的相位天然同步。旧的 speed=-0.85 只翻转大腿摆动、小腿屈曲
          // 相位不跟着翻，两段脱节，看起来就是"身体后退、腿朝前踢"。
          f.x -= f.facing * 54 * dt;
          f.walkPhase -= dt * 1.6;
          f.pose = lerpPose(f.pose, walkPose(f.walkPhase), 1 - Math.exp(-dt * 22));
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
      const clip = (f.state === 'idle' && f.hp < 30 ? CLIPS.tired : clipOf(f, f.state)) ?? CLIPS.idle; // 残血弯腰喘
      const prog = f.clipDur > 0 ? f.clipT / f.clipDur : 1;
      const targetPose = sampleClip(clip, prog);
      // 演示模式用更高的收敛率：让运行时姿态尽快贴到采样姿态，
      // 这样 DEMO 的反推定位（按 sampleClip 精确算的）和实际运行一致，不会因平滑滞后而判不中。
      f.pose = lerpPose(f.pose, targetPose, 1 - Math.exp(-dt * (opts.demo ? 60 : 30)));

      /*
       * 翻滚：位移和旋转由**同一个 q** 驱动。
       * 真实滚动满足 v = ωR（不打滑），所以 走过的距离 = 半径 × 转过的角度。
       * 旧实现是「leap 给个初速度 + 按进度旋转」，两者各走各的，
       * 看起来既像滑行又像弹跳 —— 这是"不像翻跟头"的根因。
       */
      if (f.state === 'roll') {
        const rp = Math.min(1, f.clipT / Math.max(0.001, f.clipDur));
        const rq = Math.min(1, Math.max(0, (rp - 0.14) / 0.72));
        const R = f.rollR || 26 * f.scale;
        f.x = f.rollX0 + f.facing * f.rollDir * R * TAU * rq;
        f.x = Math.max(f.minX, Math.min(f.maxX, f.x));
      }

      // 蹲防：同一个 block 状态，但身体要压下去 —— 否则玩家看不出自己在蹲防。
      // 这也是"择"的视觉反馈：蹲防挡下段、站防挡中段，姿态必须可分辨。
      if (f.state === 'block' && f.guardLow) {
        f.pose = lerpPose(f.pose, CROUCH, 0.6);
      }

      /* --- PD 控制器：程序化受击反应叠加（可选增强） --- */
      // 如果角色启用了 PD 控制器且当前激活，将 PD 修正量混合到姿态上
      // 默认 pdController = null，不走此分支，行为与原来完全一致
      if (f.pdController && f.pdController.active) {
        f.pose = updatePDReaction(f.pdController, f.pose, dt);
      }

      /* --- 观察对手：他刚起手 → 记一笔（并判断"他是不是挡完我立刻就抢"） --- */
      {
        const obs = fighters[f.partner];
        if (obs) {
          const oAtk = atkOf(obs, obs.state);
          const oProg = obs.clipDur > 0 ? obs.clipT / obs.clipDur : 1;
          if (oAtk && oProg < 0.08 && elapsed - f.oppModel.atkAt > 0.25) noteOpp(f, 'atkStart');
        }
      }


      /* --- 攻击命中判定（几何扫掠：攻击体体积 ∩ 身体框体积） --- */
      const atk = atkOf(f, f.state);
      if (!atk) f.bladeDraw = null;
      if (atk) {
        /*
         * 攻击位移（attackLunge）：帧的纯函数，按阶段分段推进
         * ------------------------------------------------------------
         * 位移粒度 = 动作阶段，不是整招：
         *   起手 +a（重心前压）→ 判定 +b（蹬地转胯）→ 收招 +c（站定/退半步）
         * 本帧只推进两个 prog 之间的差值，所以：
         *   · 与帧率无关（总量恒等于 lungeDistAt(prog)）
         *   · 与击退/腾空等外部位移天然叠加（它们各自累加，互不覆盖）
         *   · DEMO 可以用同一个函数反推起手位置，而不是估一个数碰运气
         * 命中后 lungeCapProg 把进度钉住 —— 武器顶住人就不再往前顶（不穿模），
         * 但位置仍然是 prog 的函数，seek 定格不会失真。
         */
        if ((atk.lunge || atk.forward) && f.clipDur > 0) {
          // 命中后进度封顶：武器顶到人就不再往前顶，位置的「函数性」保持不变
          const capP = f.lungeCapProg >= 0 ? Math.min(prog, f.lungeCapProg) : prog;
          const prevP = Math.min(prog - dt / f.clipDur, capP);
          const cur = lungeDistAt(atk, capP, f.clipDur);
          const prev = lungeDistAt(atk, prevP, f.clipDur);
          if (cur !== prev) {
            f.x += f.facing * (cur - prev);
            f.x = Math.max(f.minX, Math.min(f.maxX, f.x));
          }
        }


        /*
         * 每帧把攻击体几何算一次，并**同时**存下「刀刃在哪」。
         * 渲染层不再自己算一遍 —— 它直接读 f.bladeDraw 这份几何去画刀。
         * 这样「画出来的刀」和「判定用的胶囊」用的是同一组数字，
         * 不存在"剑在上、判定在下"的可能。
         */
        const armedNow = armedOf(f, atk);
        f.bladeDraw = null;
        for (let hi = 0; hi < atk.hits.length; hi++) {
          const h = atk.hits[hi];
          f.hitPrevVols[hi] = f.hitVols[hi] ?? null;
          const part = h.part ?? atk.part;
          // 持械就用刀的长度判定，空手就用拳头（数据里的 tip 只描述"有没有兵刃"）
          const tipEff = armedNow ? bladeLenOf(atk, h) : h.tip === -1 ? -1 : 0;
          f.hitVols[hi] = buildHitVolume(f, part, tipEff, (h.w ?? 0) * f.scale, h.sori ?? 0);
          if (!f.bladeDraw && tipEff > 0) {
            f.bladeDraw = bladeGeometryFor(f, part, tipEff, h.sori ?? 0);
          }
        }

        for (let hi = 0; hi < atk.hits.length; hi++) {
          const h = atk.hits[hi];
          if (f.hitDone[hi]) continue;
          if (prog < h.at) continue;

          // ── 判定窗口：[h.at, h.at + act] ──
          // 不是"恰好那一帧"，而是整段窗口内武器扫过就在判。
          // 窗口结束还没叠上 = 真挥空，才标记 hitDone。
          const actSpan = h.act ?? 0.14;
          if (prog > h.at + actSpan) {
            f.hitDone[hi] = true;
            continue;
          }
          if (!opp || opp.state === 'down') continue;

          // 对方在闪避无敌帧内 -> 打空
          if (opp.invuln > 0) {
            f.hitDone[hi] = true;
            spawn(opp.x - f.facing * 8, groundY() - 36, 'rgba(120,200,255,0.75)', 'dust', 5, 0.55);
            continue;
          }

          // 弹道招式：不做接触判定，发射投射物（弩箭/飞镖），朝对手胸口做一次方向修正
          if (atk.projectile) {
            f.hitDone[hi] = true;
            f.landedHit = true; // 箭已出手，不按挥空惩罚（中不中看投射物碰撞）
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

          // ── 核心判定：武器胶囊（含扫掠子步） vs 头/躯干/腿三个身体框 ──
          const hurtParts = buildHurtParts(opp);
          const swept = sweptHitParts(f.hitPrevVols[hi] ?? null, f.hitVols[hi], hurtParts);
          const at = swept.point;

          if (debugOptions.frames) {
            const cv0 = f.hitVols[hi];
            const tw0 = place(opp).world;
            const per = hurtParts
              .map((p) => `${p.zone[0]}:${capsuleVsCapsule(cv0, p.vol).penetration.toFixed(0)}`)
              .join(' ');
            debugGeo = {
              move: f.state,
              prog,
              pen: swept.penetration,
              hit: swept.hit,
              zone: swept.zone,
              r: cv0?.radius ?? 0,
              v1: cv0?.p1.x ?? 0,
              a0: f.atkStartX,
              v2: cv0?.p2.x ?? 0,
              tx: opp.x,
              ax: f.x,
              parts: `y${cv0.p1.y.toFixed(0)}-${cv0.p2.y.toFixed(0)} ${per.replace(/ /g, '')} T${tw0.pelvis.x.toFixed(0)},${tw0.head.y.toFixed(0)}/${tw0.chest.y.toFixed(0)}/${tw0.pelvis.y.toFixed(0)}`,
            };
            console.log(
              `[GEO] ${f.state} h${hi} prog=${prog.toFixed(3)} ax=${f.x.toFixed(1)} opp=${opp.x.toFixed(1)} ` +
              `vol=(${cv0.p1.x.toFixed(1)},${cv0.p1.y.toFixed(1)})→(${cv0.p2.x.toFixed(1)},${cv0.p2.y.toFixed(1)}) r=${cv0.radius.toFixed(1)} ` +
              `pen=${swept.penetration.toFixed(2)} zone=${swept.zone} hit=${swept.hit} | ${per}`,
            );
          }

          if (!swept.hit) {
            // 窗口内还没叠上：武器还在扫，等下一帧继续判（不消耗这次 hit）
            continue;
          }

          // 真的叠上了：这次 hit 用掉
          f.hitDone[hi] = true;
          // 武器顶到人了 → 位移钉在这一刻，避免长兵器继续推进从身体里穿过去
          f.advanceFrozen = true;
          f.lungeCapProg = prog;
          debugHitPoint = { x: at.x, y: at.y, pen: swept.penetration, life: 1.2, zone: swept.zone };

          // 瞬移跟进（多段招专用）：第一段把对手打退后立刻贴上去，
          // 否则第二段够不着 —— 这就是"连斩第二下隔空打"的根因。
          if (h.chase) {
            const gapNow = Math.abs(opp.x - f.x);
            const step = Math.max(0, Math.min(h.chase, gapNow - 10)); // 停在对手身前 10px，不穿过去
            if (step > 0.5) {
              f.x += f.facing * step;
              f.x = Math.max(f.minX, Math.min(f.maxX, f.x));
              // 残影：一排短速度线，读作"贴上去"而不是滑过去
              for (let k = 0; k < 4; k++) {
                speedLines.push({
                  x: f.x - f.facing * (6 + k * 7),
                  y: groundY() - 46 + k * 10,
                  a: f.facing > 0 ? Math.PI : 0,
                  life: 0.1, max: 0.12,
                  len: 14 + k * 4,
                  color: 'rgba(255,255,255,0.75)', w: 2,
                });
              }
            }
          }

          // 架势值系统：格挡要付出代价，撑不住就破防（破防中无法格挡且挨打更疼）
          f.landedHit = true; // 打到人了（含被格挡），不算挥空
          const meta0 = MOVE_META[f.state];
          /*
           * ── 防御高度（择）──
           * 中段(mid) 只能站防挡 / 下段(low) 只能蹲防挡 / 上段(high) 两种都挡。
           * 猜错不是"少减一点伤"，而是**直接吃满伤害** —— 这样防御才有猜拳压力，
           * 进攻才有"该打下段还是中段"的真实困境。
           * 另外 guardLock > 0（招架赌输了）期间根本挡不住。
           */
          const atkHeight: 'high' | 'mid' | 'low' = h.height ?? atk.hits[0]?.height ?? 'high';
          const canGuard = opp.state === 'block' && opp.guardBreak <= 0 && !atk.throw && opp.guardLock <= 0;
          const heightOk =
            atkHeight === 'high' ? true : atkHeight === 'low' ? opp.guardLow : !opp.guardLow;
          const guarding = canGuard && heightOk;
          const guardWrong = canGuard && !heightOk;
          const broken = opp.guardBreak > 0;

          /*
           * ── 招架（Parry）──
           * 确定性窗口：对手刚进防御的 window 秒内被打中 → 招架成功。
           * 结果：自己不受伤、对手吃大硬直、自己拿到一个反击窗。
           * 反击不在这里发生 —— 这里只是"发一个窗口给 AI"，由 AI 的性格决定打不打。
           */
          if (guarding && f.state !== 'block' && opp.parryT > 0) {
            opp.counterT = PARRY_DEF.counterWindow;
            opp.counterWindow = Math.max(opp.counterWindow ?? 0, PARRY_DEF.counterWindow);
            opp.parryT = 0; // 用掉这次招架
            opp.blockT = 999;
            f.stun = Math.max(f.stun, PARRY_DEF.stun);
            f.pendingCombo = null;
            f.comboSteps = null;
            f.cool = Math.max(f.cool, PARRY_DEF.stun);
            hitstop = Math.max(hitstop, 0.1);
            popups.push({ x: at.x, y: at.y - 40, text: 'PARRY', life: 0, max: 0.8, color: '#7FE3FF' });
            impactRings.push({ x: at.x, y: at.y, r0: 6, r1: 34, life: 0, max: 0.28, color: '#7FE3FF', wide: 2.5 });
            for (let k = 0; k < 6; k++) {
              spawn(at.x + rand(-8, 8), at.y + rand(-8, 8), 'rgba(140,230,255,0.9)', 'dust', 3, 0.7);
            }
            continue;
          }
          // counter hit：打在对手起手途中（他这一下还没出来）= 破招，加伤加硬直
          const oppPhHit = movePhase(opp.state);
          const oppProgHit = opp.clipDur > 0 ? opp.clipT / opp.clipDur : 1;
          const isCounter = !!oppPhHit && !guarding && oppProgHit < oppPhHit.first;
          // 惩罚挥空：对手这一招已经过了判定窗还没碰到人 = 收招破绽，打上去是"差合"
          const isPunish = !!oppPhHit && !guarding && !opp.landedHit && oppProgHit > oppPhHit.last + 0.02;
          // 对拼 trade：对手这招也已经过了命中帧 = 互换，不改数值只给演出
          const isTrade = !!oppPhHit && !guarding && !isCounter;
          // 部位受击：几何说了算 —— 命中哪个身体框就是哪个部位，不再按 y 阈值猜
          const zone = swept.zone;
          const zoneMul = zone === 'head' ? 1.15 : zone === 'leg' ? 0.85 : 1;
          const mul = (guarding ? (meta0?.breakGuard ? 0.62 : 0.34) : broken ? 1.6 : 1) * (isCounter ? 1.35 : 1) * zoneMul;
          const dmg = Math.round(rand(h.dmg[0], h.dmg[1]) * mul);
          if (guardWrong) {
            // 挡错高度 = 直接吃满伤害，必须给明确反馈
            popups.push({
              x: at.x, y: at.y - 34,
              text: atkHeight === 'low' ? 'LOW HIT' : 'OVERHEAD',
              life: 0, max: 0.7, color: '#FF9A3C',
            });
            if (opp.guardLow) f.readsLow += 1;
            else f.readsHigh += 1;
          }
          opp.hp = Math.max(0, opp.hp - dmg);
          popups.push({ x: at.x + rand(-6, 6), y: at.y - 26, text: '-' + dmg, life: 0, max: 0.9, color: guarding ? '#6BA8D6' : broken ? '#FFD24A' : isCounter ? '#FF9A3C' : '#E23B2E' });
          if (isCounter) popups.push({ x: at.x, y: at.y - 44, text: 'COUNTER', life: 0, max: 0.8, color: '#FF9A3C' });
          else if (isTrade) popups.push({ x: at.x, y: at.y - 44, text: 'TRADE', life: 0, max: 0.6, color: '#C9C9C9' });
          // 每招专属打击特效 + 流派配色（同一招不同流派颜色不同）
          burstFx(f.state, at.x, at.y, f.facing, guarding, 0, f.skin.trim);

          if (guarding) {
            stats.blocks++;
            // 记对手的防御习惯：这次他是蹲防还是站防，积少成多 → 下次选段位用
            if (opp.guardLow) f.readsLow += 1;
            else f.readsHigh += 1;
            f.readsLow *= 0.99;
            f.readsHigh *= 0.99;
            noteOpp(f, opp.guardLow ? 'blockLow' : 'blockHigh');
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
          // 挤压量按「伤害 + 击退」算：轻拳轻微一缩，重锤整个被压扁
          opp.squash = Math.min(1, 0.32 + dmg / 42 + (h.knock > 320 ? 0.28 : 0));
          opp.hitShake = 1;
          stats.hits++;
          // 大伤害：击退更远 + 标记「站不稳要倒地」
          /*
           * 击倒递减（Knockdown Scaling）
           * 2.5 秒内重复击倒 ⇒ 击倒阈值抬高 130。
           * 目的：打断「打倒 → 起身 → 再打倒」的无限循环，
           * 让重招在连段里第一次值钱、第二次开始不值钱。
           */
          const kdRecent = elapsed - f.lastKdAt < 2.5;
          const bigHit = h.knock > 320 + (kdRecent ? 130 : 0);
          if (bigHit) f.lastKdAt = elapsed;
          opp.kb = f.facing * (h.knock + (bigHit ? 170 : 0));
          if (bigHit) opp.knockdown = true;
          if (atk.throw) opp.knockdown = true; // 投技命中必倒
          opp.sway = h.knock > 320 ? 1 : 0.55;
          // 布料风脉冲（design-3 §2.4）：防守方的布被掀向身后，进攻方的布反向回甩。
          // hitstop 冻结帧里布料是唯一还在动的东西 —— 用它补足「全身僵住」缺的运动。
          opp.windPulse = -f.facing * DECO_CFG.windPulse.impulse;
          f.windPulse = f.facing * DECO_CFG.windPulse.impulse * 0.4;
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
          // 演示模式不接 —— 否则正在演示的这一招会被 AI 的连招在取消点顶掉，
          // 屏幕上就会出现「标题是刺拳、人在打直拳」这种错位。
          if (opts.demo) {
            f.comboSteps = null;
            f.comboIndex = 0;
          } else if (comboGraphOf(f)) {
            /*
             * 有连招图：这一刻只记录「打成了什么」，接什么等取消点再定。
             * 因为连招的窗口是"判定窗之后那几帧"，命中帧时窗口还没开，
             * 在这里查图必然查不到 —— 这是很容易踩的一个时序坑。
             */
            f.lastConfirm = guarding ? 'block' : isCounter || isPunish ? 'counter' : 'hit';
          } else if (f.comboSteps) {
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
          // 打康 / 差合都额外加硬直 —— 这正是"解锁平时接不上的连招"的来源
          opp.stun =
            (atk.react === 'light' ? 0.2 : atk.react === 'up' ? 0.5 : 0.42) +
            (isCounter ? 0.18 : 0) +
            (isPunish ? 0.14 : 0);
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
      // 有连招图的英雄：到取消点时按「图 + 确认结果 + 帧窗口 + 距离」查一次能接什么
      if (atk && !opts.demo && comboGraphOf(f) && !f.pendingCombo && f.comboTried !== f.state) {
        f.comboTried = f.state;
        const nx = pickComboEdge(f, opp, prog);
        if (nx) {
          f.pendingCombo = nx;
          f.cool = 0;
          f.intentLock = 0;
        } else if (random() < 0.45) {
          f.disengage = rand(0.35, 0.7); // 没有可接的边：打完就退，拉开喘口气
        }
      }
      if (atk && f.pendingCombo && prog >= (atk.cancelFrom ?? 0.78)) {
        const nx = f.pendingCombo;
        f.pendingCombo = null;
        f.cool = 0;
        /*
         * 连招位移规划（可行性检查在这一刻做，而不是打到一半才发现够不到）
         * ------------------------------------------------------------
         * A→B 时 B 的起手位置 = A 结束时把人打到的地方。A 的位移不够、对手被击退，
         * B 的固定位移又不够，连招就断在半空（隔空打）。
         * 这里用 B 的真实标定量程核一次：够不到就把差额交给跟进步（最多 B.stepIn），
         * 而不是去把 B 的 forward 调大 —— 那样单发 B 会冲过头。
         */
        if (opp && !opts.demo) {
          const nxAtk = atkOf(f, nx);
          const gap = Math.abs(opp.x - f.x);
          /*
           * 目标间距 = 下一招的几何量程 + 它在命中帧之前自己会走掉的位移 - 2px 余量
           * ------------------------------------------------------------------
           * reachOf 量的是「站着不动时攻击点能到多远」，但 B 自己还有起手前压/蹬地，
           * 命中那一刻人已经往前走了 dHit。漏掉这一项就会垫过头（冲进人身体里），
           * 所以必须从差额里扣掉它。
           */
          const nxHitAt = nxAtk?.hits[0]?.at ?? 0.5;
          const nxDur = clipOf(f, nx)?.dur ?? 0.3;
          const dHit = nxAtk ? lungeDistAt(nxAtk, nxHitAt, nxDur) : 0;
          const want = reachOf(nx) + dHit - 2;
          const cap = nxAtk?.stepIn ?? 30;
          if (gap > want && gap < want + 90 && cap > 0) {
            // 再兜一层：最多只吃掉当前间距的 85%，绝不垫到人身上（防穿模/防冲过头）
            const safe = Math.max(0, Math.min(gap - want, cap, gap * 0.85));
            f.stepInLeft = Math.max(f.stepInLeft, safe);
          }
        }
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
          if (whiff) {
            stats.whiffs++;
            const oW = fighters[f.partner];
            if (oW) noteOpp(oW, 'whiff');
          }
          // 挥空 = 这一招的确认结果是 whiff：连招图里 whiff 的出边通常只有"收招硬直"
          if (atk && whiff) f.lastConfirm = 'whiff';
          // 收招结束再做一次距离检查：差一点没够到 = 下一帧垫一步，而不是站着发呆。
          // 跟进步是 locomotion 的事，触发条件却是「攻击结束 + 距离不够」——
          // 这正是两个系统的交界，以前这里什么都没有。
          if (atk && opp && !opts.demo && atk.stepIn) {
            const gapEnd = Math.abs(opp.x - f.x);
            const wantEnd = reachOf(f.state) + 2;
            if (gapEnd > wantEnd && gapEnd < wantEnd + 70) {
              const safe = Math.max(0, Math.min(gapEnd - wantEnd, atk.stepIn, gapEnd * 0.85));
              f.stepInLeft = Math.max(f.stepInLeft, safe);
            }
          }
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

      /*
       * 演示模式：对手只当沙包。
       * 演示是"看这一招长什么样"，不是对打 —— 沙包一旦还手，
       * 画面就变成"两个人在打架"，根本没法看清单招的判定和动作。
       * 之前只靠 AI 决策被关掉来保证，现在再加一道硬保险。
       */
      if (opts.demo && f !== fighters[0] && atkOf(f, f.state)) {
        setState(f, 'idle');
      }

      /* --- 做决策（自主模式下自动出手，演示模式下关闭） --- */
      // 走位 / 举盾中也允许反悔重新判断 —— 否则「走着走着看见对方起手再躲」永远来不及
      const THINKABLE = f.state === 'idle' || f.state === 'approach' || f.state === 'retreat' || f.state === 'block';
      if (!opts.demo && THINKABLE) {
        /*
         * 招架成功后的反击窗：AI 用性格（PARRY_DEF.love）决定要不要还手。
         * 不是"系统自动反击"，也不是"系统掷骰子"—— 是一个给 AI 的 0.22s 决策窗，
         * 窗口内可以选一个反击招，也可以放弃（继续防、或者退）。
         * love 高的角色看起来"爱反击"，低的看起来"保守"，这是可解释的。
         */
        if (f.counterT > 0) {
          f.counterT = Math.max(0, f.counterT - dt);
          const cm = PARRY_DEF.moves.find((k) => !!atkOf(f, k));
          if (cm && f.stun <= 0 && random() < PARRY_DEF.love * dt * 16) {
            f.counterT = 0;
            f.cool = 0;
            f.intentLock = 0;
            f.pendingCombo = null;
            setState(f, cm as State);
            continue;
          }
        }
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
            const atkRef = atkOf(f, executedDecision);
            if (atkRef) {
              const clipRef = clipOf(f, executedDecision);
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
      if (f.currentFrameData && atkOf(f, f.state)) {
        const prog = f.clipDur > 0 ? f.clipT / f.clipDur : 1;
        f.attackPhase = getAttackPhase(prog, f.currentFrameData);
        // 招式结束时清除帧数据
        if (prog >= 1) {
          f.currentFrameData = null;
          f.attackPhase = 'none';
        }
      } else if (!atkOf(f, f.state)) {
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
    cloth: Chain | null,
    trinket: Dangle | null,
    /** 武器是否握在手上（false = 收刀/背在身后，只画拳脚） */
    armed: boolean = false,
    /** 手中兵刃的长度（px）：跟当前招式的 tip 对齐，视觉与判定一致 */
    bladeLen: number = 20,
    /**
     * 本帧的刀刃几何（判定层算好的那一份）。
     * 必须是**参数**而不是外部变量 —— 之前直接引用了 drawFighter 里的局部变量，
     * 持械招式一画就 ReferenceError，整个渲染中断（人和读数条一起消失）。
     */
    blade: { hand: Pt; angle: number; len: number } | null = null
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
      /*
       * 刀的两个状态，靠 armed（招式级）切换：
       *   收刀（armed=false）：鞘（saya）斜背在背后，刀柄从肩后伸出 —— 打拳脚时就是这样
       *   拔刀（armed=true） ：刀握在前手上，背后只留空鞘
       * 两者都不画 "一根线"，而是真的鞘 + 镡 + 弯刀身。
       */
      const sB = get('shoulderB');
      const hB = get('hipB');
      const dxg = sB.x - hB.x;
      const dyg = sB.y - hB.y;
      const lg = Math.hypot(dxg, dyg) || 1;
      const ux = dxg / lg;
      const uy = dyg / lg;
      // 鞘按剑客体侧的角度斜挂，带一点弧度（别像根木棍）
      const bowX = -uy * 2.6 * k;
      const bowY = ux * 2.6 * k;
      const sayaFrom = { x: hB.x + ux * 1.5, y: hB.y + uy * 1.5 };
      const sayaTo = { x: sB.x - ux * 2.5, y: sB.y - uy * 2.5 };
      const sayaMid = {
        x: (sayaFrom.x + sayaTo.x) / 2 + bowX,
        y: (sayaFrom.y + sayaTo.y) / 2 + bowY,
      };
      // 鞘：深色描边 + 漆面
      ctx.beginPath();
      ctx.moveTo(sayaFrom.x, sayaFrom.y);
      ctx.quadraticCurveTo(sayaMid.x, sayaMid.y, sayaTo.x, sayaTo.y);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 4.6 * k;
      ctx.stroke();
      ctx.strokeStyle = '#39434E';
      ctx.lineWidth = 3.1 * k;
      ctx.stroke();
      // 鞘口（鲤口）与鞘尾（石突）：两道金环
      ctx.fillStyle = '#C9A227';
      ctx.beginPath();
      ctx.arc(sayaFrom.x, sayaFrom.y, 1.5 * k, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sayaTo.x, sayaTo.y, 1.2 * k, 0, TAU);
      ctx.fill();
      if (!armed) {
        // 收刀：刀柄从肩后伸出（柄 + 镡 + 柄头）
        const hx0 = sayaFrom.x + ux * 0.2;
        const hy0 = sayaFrom.y + uy * 0.2;
        const hx1 = hx0 + ux * 8.5 * k;
        const hy1 = hy0 + uy * 8.5 * k;
        ctx.beginPath();
        ctx.moveTo(hx0, hy0);
        ctx.lineTo(hx1, hy1);
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 3.6 * k;
        ctx.stroke();
        ctx.strokeStyle = '#232931';
        ctx.lineWidth = 2.6 * k;
        ctx.stroke();
        // 镡：垂直于柄的短横
        ctx.strokeStyle = '#C9A227';
        ctx.lineWidth = 1.8 * k;
        ctx.beginPath();
        ctx.moveTo(hx0 - uy * 2.6 * k, hy0 + ux * 2.6 * k);
        ctx.lineTo(hx0 + uy * 2.6 * k, hy0 - ux * 2.6 * k);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hx1, hy1, 1.5 * k, 0, TAU);
        ctx.fillStyle = '#C9A227';
        ctx.fill();
      } else if (blade) {
        // 拔刀：手、角度、长度全部来自判定层那份几何 → 刀和红胶囊必然同一条线
        drawKatana(ctx, blade.hand, blade.angle, blade.len, k, facing, OUTLINE);
      }

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

      /* --- 布片动态件（L2 柔体链：链管弯曲，这里只管宽度轮廓与分片） --- */
      if (cloth && spec.cloth && Number.isFinite(cloth.nodes[cloth.nodes.length - 1]?.x)) {
        const nEnd = cloth.spec.nodes;
        const tip = cloth.nodes[nEnd];
        // 每种布片：[根部半宽, 尖部半宽] px（×k）；cape2/haori 左右两片沿法线横向错开
        const W: Partial<Record<string, [number, number]>> = {
          cape2: [3, 4], apron: [5, 6.5], hoodTail: [2.5, 1.5], shoulderCape: [3.5, 2],
          haori: [6, 7], kilt: [4, 2.5], coat: [6, 5.5], sash: [2.5, 2],
        };
        const [w0, w1] = W[spec.cloth] ?? [4, 3];
        const tint = spec.cloth === 'apron' ? '#8B5E3C' : trim;
        const splits = spec.cloth === 'cape2' || spec.cloth === 'haori' ? [-1, 1] : [0];
        for (const s of splits) {
          drawRibbon(ctx, cloth, tint, 1, [w0 * k, w1 * k], s * 2.2 * k);
        }
        if (spec.cloth === 'coat') {
          // 机关师兜袋：画在链末端
          ctx.strokeStyle = trim;
          ctx.lineWidth = 1.2 * k;
          ctx.strokeRect(tip.x - 3.5 * k, tip.y - 3 * k, 7 * k, 4 * k);
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
    const flashing = f.flash > 0.55;
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

    /*
     * 受击形变（Squash & Stretch）—— 打击感的主要来源之一
     * ------------------------------------------------------------------
     * 两套变形分开算，因为它们的"物理"不一样：
     *   squash    命中瞬间：横向炸开、纵向压扁，2~3 帧收干（被打扁的那一瞬）
     *   landSquash 落地缓冲：缓慢压一下再回弹（体重压下去的感觉）
     * 之前挤压是绑在 flash 上的，跟着闪白一起持续 0.16s，看起来像整个人被拉伸了半秒。
     * 另外加了顿帧抖动：逻辑冻结时整体不位移，但身体左右震 1~2px，读作"扛了一下"。
     */
    const ls = f.landSquash || 0;
    const sq = f.squash || 0;
    const shk = (f.hitShake || 0) * 2.2 * f.scale;
    ctx.save();
    if (shk > 0.05) {
      ctx.translate(Math.sin((f.clipT + f.x) * 92) * shk, Math.cos((f.clipT + f.x) * 78) * shk * 0.4);
    }
    if (sq > 0.02 || ls > 0.02) {
      const baseY = groundY();
      ctx.translate(f.x, baseY);
      ctx.scale(1 + sq * 0.24 + ls * 0.10, 1 - sq * 0.28 - ls * 0.22);
      ctx.translate(-f.x, -baseY);
    }

    // getup 不再用 fade-in：动作本身已有完整的 躺→坐→跪→站 过渡，
    // 原来 getupFade 从 0 渐显会导致"倒地后消失再闪现"的视觉 bug。
    const alpha = 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (f.enterT > 0) ctx.translate(0, enterDrop);

    /*
     * 滚翻：2D 骨架没有「整体旋转」这个自由度，所以在画布层绕**身体重心**转一整圈。
     * 之前绕的是「脚下 13px」那个点 —— 半径等于身高，一转起来整个人被甩到天上，
     * 所以看起来不是翻滚而是弹跳（用户反馈）。
     * 现在绕骨盆（团身后的球心，约离地 27px）转，团身姿态本身就是一个球，
     * 转起来才是「就地滚」；前进/后退交给 leap 的横向位移。
     */
    if (f.state === 'roll') {
      const p = Math.min(1, f.clipT / Math.max(0.001, f.clipDur));
      // 只在团身阶段转：0.14 起转、0.86 转完，前面留出「下沉」，后面留出「起身」
      const q = Math.min(1, Math.max(0, (p - 0.14) / 0.72));
      // 支点高度 = 滚动半径（球心离地 R），转动中不做任何额外起伏 ——
      // 真实的球心是匀速直线的，加了"起伏"反而像在弹。
      const R = f.rollR || 26 * f.scale;
      const pivotY = groundY() - R;
      // 绕球心转：转角 q*TAU 与 update 里的位移 (R*TAU*q) 严格对应，不打滑
      const cxRoll = f.rollX0 + f.facing * f.rollDir * R * TAU * q;
      ctx.translate(cxRoll, pivotY);
      ctx.rotate(-f.facing * f.rollDir * q * TAU);
      ctx.translate(-cxRoll, -pivotY);
    }

    // 当前招式的持械状态：斩/刺类手持兵刃，拳脚类收刀（招式没写则沿用流派默认）
    const curAtk = atkOf(f, f.state);
    const armedNow = armedOf(f, curAtk);
    // 刀刃几何直接用判定层这一帧算好的那一份（f.bladeDraw），不再自己重算：
    // 一旦两边各算一遍，迟早会出现"剑在上一格、判定在下一格"的分离。
    const bd = f.bladeDraw;
    const bladeNow = bd ? bd.len : 0;

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
        null,
        false,
        0,
        null
      );
    } else {
      const { world } = place(f);
      drawFigure((key) => world[key as keyof Joints], f.scale * bulk, body, trim, dark, expr, f.facing, faceCam, f.build, side, torsoScale, f.sway, f.clothChain, f.trinket, armedNow, bladeNow, bd);
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

    // 单个角色绘制失败不能拖垮整屏（以前会只剩背景，人全部消失）
    for (const f of fighters) {
      try {
        drawFighter(f);
      } catch (err) {
        reportErr('drawFighter', err);
      }
    }

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
      const hudList = buildDemoList();
      const e = hudList[Math.min(demoIdx, hudList.length - 1)] ?? hudList[0];
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = 'bold 15px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(20,16,12,0.78)';
      ctx.fillText(`${demoIdx + 1} / ${hudList.length}   ${e.name}`, W / 2, 24);
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

        // ── 2.5 判定几何可视化（几何判定的真凭实据）──
        // 绿 = 受击框（头/躯干/腿）  红 = 攻击判定体（带粗细）
        // 黄虚线 = 上一帧攻击体（扫掠前位置）  白点 = 实际命中点 + 重叠量
        // 用法：?debug=frames 或 ?debug=hitboxes
        if (debugOptions.frames || debugOptions.hitboxes) {
          /**
           * 画判定体。**必须按 path 折线画**：弯刀是折线胶囊链，
           * 只连 p1→p2 会画出一根笔直的「激光」，跟弯刀对不上，
           * 看起来就像判定飘在武器外面（用户原话：像在发激光）。
           * 另外补起点（绿）终点（白）两个点，肉眼就能确认
           * 「起点在护手、终点在刀尖」。
           */
          const drawVol = (vol: HitVolume, color: string, dash: number[] = []) => {
            const pts = vol.path && vol.path.length >= 2 ? vol.path : [vol.p1, vol.p2];
            ctx.save();
            ctx.setLineDash(dash);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            // 体积本体：**空心套袖** —— 只填很淡的一层，再描上下两条边界。
            // 之前是实心半透明粗线，正好把刀盖住，根本看不出判定和武器是否重合。
            ctx.lineWidth = Math.max(1.5, vol.radius * 2);
            ctx.strokeStyle = color.replace(/[\d.]+\)$/, '0.16)');
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
            // 上下两条边界线：判定体的"外形"
            const off = vol.radius;
            for (const side of [-1, 1]) {
              ctx.beginPath();
              for (let i = 0; i < pts.length; i++) {
                const a = pts[Math.max(0, i - 1)];
                const b = pts[Math.min(pts.length - 1, i + 1)];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d = Math.hypot(dx, dy) || 1;
                const nx = (-dy / d) * off * side;
                const ny = (dx / d) * off * side;
                if (i === 0) ctx.moveTo(pts[i].x + nx, pts[i].y + ny);
                else ctx.lineTo(pts[i].x + nx, pts[i].y + ny);
              }
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.1;
              ctx.stroke();
            }
            // 中轴：细白线。判定如果和武器贴合，这条线就应该压在中轴/刀刃上
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(255,255,255,0.8)';
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
            // 端点：绿=起点（手/护手），白=终点（刀尖/拳锋）
            const dot = (q: Pt, fill: string) => {
              ctx.beginPath();
              ctx.arc(q.x, q.y, 2.6, 0, TAU);
              ctx.fillStyle = fill;
              ctx.fill();
              ctx.strokeStyle = 'rgba(20,16,12,0.75)';
              ctx.lineWidth = 1;
              ctx.stroke();
            };
            const last = pts[pts.length - 1];
            dot(pts[0], 'rgba(120,255,150,0.95)');
            dot(last, 'rgba(255,255,255,0.95)');
            ctx.restore();
          };

          // 受击框：任何状态都画（始终存在，这是「人有身体」）
          for (const hp of buildHurtParts(f)) {
            const col =
              hp.zone === 'head' ? 'rgba(120,230,140,0.34)' :
              hp.zone === 'leg' ? 'rgba(120,190,255,0.30)' :
              'rgba(110,220,150,0.26)';
            drawVol(hp.vol, col);
          }

          // 攻击判定体：仅在本角色处于攻击状态时存在
          const atkD = atkOf(f, f.state);
          if (atkD) {
            for (let vi = 0; vi < f.hitVols.length; vi++) {
              const pv = f.hitPrevVols[vi];
              if (pv) drawVol(pv, 'rgba(255,214,90,0.45)', [4, 4]);
              const cv = f.hitVols[vi];
              if (cv) drawVol(cv, 'rgba(255,70,60,0.42)');
            }
          }

          // 顶部读数条：逐招微调时先看这两行
          // 行1 = 招式/进度/判定体粗细   行2 = 判定体世界端点 → 目标中心 / 重叠量
          if (debugGeo && fighters.indexOf(f) === 0) {
            const g = debugGeo;
            ctx.save();
            ctx.font = 'bold 11px ui-monospace, monospace';
            ctx.fillStyle = g.hit ? 'rgba(28,132,66,0.92)' : 'rgba(150,60,40,0.88)';
            ctx.fillRect(6, 6, Math.min(W - 12, 330), 59);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(`${g.move} ${(g.prog * 100).toFixed(0)}%  r=${g.r.toFixed(1)}  ax=${g.ax.toFixed(0)} a0=${g.a0.toFixed(0)}`, 12, 8);
            ctx.fillText(
              `vol ${g.v1.toFixed(0)}→${g.v2.toFixed(0)}  tgt ${g.tx.toFixed(0)}  pen=${g.pen.toFixed(2)} ${g.hit ? 'HIT ' + g.zone : 'MISS'}`,
              12,
              21,
            );
            ctx.fillText(g.parts, 12, 34);
            if (debugDemo) ctx.fillText(debugDemo, 12, 47);
            ctx.restore();
          }

          if (lastErr && fighters.indexOf(f) === 0) {
            ctx.save();
            ctx.font = 'bold 11px ui-monospace, monospace';
            ctx.fillStyle = 'rgba(160,30,20,0.92)';
            ctx.fillRect(6, H - 26, Math.min(W - 12, 560), 20);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(`JS ERROR → ${lastErr.slice(0, 90)}`, 12, H - 16);
            ctx.restore();
          }

          // 命中点：白点 + 重叠量
          if (debugHitPoint) {
            const dp = debugHitPoint;
            ctx.save();
            ctx.beginPath();
            ctx.arc(dp.x, dp.y, 4.5, 0, TAU);
            ctx.fillStyle = 'rgba(255,255,255,0.95)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(20,16,12,0.7)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.font = 'bold 10px ui-monospace, monospace';
            ctx.fillStyle = 'rgba(255,255,255,0.95)';
            ctx.textAlign = 'center';
            ctx.fillText(`∩${dp.pen.toFixed(1)}px`, dp.x, dp.y - 9);
            ctx.restore();
          }
        }

        // ── 3. 6色命中盒系统（hitboxes 或 full 模式）──
        if (debugOptions.hitboxes) {
          const boxes = computeDebugHitboxes(f, joints);
          drawDebugHitboxes(ctx, boxes);

          // 攻击部位标记：当前状态是攻击招式时，标出命中点（增强版）
          const atk = atkOf(f, f.state);
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
          // 站蹲防 / 招架窗 / 防御封锁：这两条演示里也有意义（择就是靠它看出来的）
          ctx.fillText(
            `guard=${f.guardLow ? '蹲防' : '站防'}  pT=${f.parryT.toFixed(2)}  lock=${f.guardLock.toFixed(2)}`,
            14,
            infoY + 76,
          );
          // phase / spatial / reads 只有真打（?auto / 竞技场）才有意义 ——
          // 演示模式不显示，否则会被误认为"AI 在打架"
          if (!opts.demo) {
            ctx.fillText(
              `intent=${f.intent?.kind ?? '-'}${f.intent?.tag ? '/' + f.intent.tag : ''}  phase=${f.phase}  sp=${f.spatial}` +
            `  opp(抢${(f.oppModel.counter)}/挡${f.oppModel.blockN}/空${f.oppModel.whiff})`,
              14,
              infoY + 90,
            );
          }
        }

        ctx.restore();
      }

      /*
       * 模式角标：一眼看出现在是「演示（单招，沙包站着不动）」还是「AI 对打」。
       * 这两件事经常被搞混 —— 演示页加 ?auto 就是在对打，不加才是单招演示。
       */
      ctx.save();
      ctx.font = 'bold 11px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      const tag = opts.demo ? '演示 DEMO · 单招' : 'AI 对打 AUTO';
      const tw0 = ctx.measureText(tag).width + 12;
      ctx.fillStyle = opts.demo ? 'rgba(30,90,160,0.72)' : 'rgba(150,50,30,0.72)';
      ctx.fillRect(W - tw0 - 6, 6, tw0, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(tag, W - 12, 9);
      ctx.restore();

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
    /*
     * 量的是**父容器**，不是 canvas 自己 —— 这条很关键。
     * 如果量 canvas.getBoundingClientRect()，会形成一个正反馈：
     *   canvas.width（缓冲区）= W*dpr → 元素的「内在尺寸」变大 →
     *   父容器（宽度跟内容走）变宽 → 下次 rect.width 更大 → …
     * 结果 canvas 被撑到远超视口（实测 679px 的窗口里撑到 1358px），
     * 整个场景连同判定体一起被推到画面外，看起来就像「判定在另一个地方」。
     * 量父容器 = 断开反馈；再补内联 100% 保证显示尺寸永远跟着容器。
     */
    const host = canvas.parentElement ?? canvas;
    const rect = host.getBoundingClientRect();
    // 再兜一层：宽度绝不超过视口。否则一旦某个父级把页面撑宽（演示列表的 grid
    // 最小宽度、长文本等），canvas 会跟着超宽 → 整个战斗场景被推到视口外面，
    // 看起来就是"判定体和角色不在一个地方"。
    const vw = document.documentElement.clientWidth || rect.width;
    W = Math.max(1, Math.round(Math.min(rect.width, vw)));
    H = Math.max(1, Math.round(rect.height));
    canvas.style.width = `${W}px`;
    canvas.style.height = '100%';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const want = opts.demo || opts.matchup ? 2 : W < 620 ? 2 : 4;
    if (fighters.length !== want) makeFighters(want);
    // W 变没变要在 layout() 之前问（layout 会把 lastLayoutW 更新成当前 W）
    const wChanged = W !== lastLayoutW;
    layout();
    render();
    /*
     * 演示模式的站位是从画布宽度 W 推出来的（cx ± gap）。
     * 只有 W 真的变了 —— 首次量到真实宽度、窗口缩放、切换模式后重建 ——
     * 才重算一次。之前无条件重算：防抖 resize 到期（W 没变）会把演示
     * 从头重放一遍，正在看的一招突然弹回开头。
     */
    if (opts.demo && (wChanged || fighters.length !== want)) startDemoEntry(demoIdx);
  };

  /*
   * 渲染/更新出错时的兜底。
   * 教训：只要某一帧在绘制某个角色时抛异常，后面的人和读数条就全都不画了，
   * 表现出来是"被击打者和数据一起消失"，而且没有任何提示，极难定位。
   * 现在：单个角色出错只跳过它，并把错误写到画面上（?debug=frames 时可见）。
   */
  let lastErr: string | null = null;
  let errShown = 0;
  const reportErr = (where: string, err: unknown) => {
    lastErr = `${where}: ${(err as Error)?.message ?? String(err)}`;
    if (errShown++ < 3) console.error(`[fight] ${where}`, err);
  };

  const loop = (ts: number) => {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (!last) last = ts;
    const dt = Math.min(0.05, (ts - last) / 1000);
    last = ts;
    // 只有「真的被人看着」才跑：在视口内 + 标签页可见 + 没开减少动效
    if (reduceMotion || (!visible && !opts.forceVisible) || !tabVisible) return;
    try {
      update(dt);
    } catch (err) {
      reportErr('update', err);
    }
    try {
      render();
    } catch (err) {
      reportErr('render', err);
    }
  };

  /* 数据一致性自检已移到模块加载时无条件执行（见文件底部 BOOT_CHECKS）——
   * 只在 debug 模式跑 = 分叉了也只有调试页看得到，盲区正是事故温床。 */

  // 首次 resize() 里 wChanged 必为 true（lastLayoutW 初始 -1），demo 站位已在那里排好，
  // 这里不用再 startDemoEntry —— 双跑会把 demoTimer 重置两次、登场播两遍。
  resize();

  /*
   * 引擎自己的 window resize 监听（140ms 防抖）：窗口变化后重量 W/H、
   * 重算 minX/maxX。页面（fight.astro）会在自己的 resizeCanvas 之后派发一个
   * 合成 resize 来通知引擎 —— 所以这里**不检查 isTrusted**，两种事件都要接。
   * layout() 里有 W 未变不重写站位的守卫，防抖到期也不会把人拽回中央。
   */
  const onResize = () => {
    window.clearTimeout(resizeTimerId);
    resizeTimerId = window.setTimeout(resize, 140);
  };
  window.addEventListener('resize', onResize);

  /*
   * 视口观察：舞台滚出视口就暂停 update/render（省 CPU；回来自动恢复）。
   * 之前这个 observer 只在 destroy 里被"清理"，从未创建 —— forceVisible: true
   * 又把唯一的软停也关了，页面滚到哪引擎都满帧跑。
   * rootMargin 80px：还没滚进来就开始预热，避免回滚时白一帧。
   */
  if (typeof IntersectionObserver !== 'undefined' && canvas.parentElement) {
    intersectionObs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible = e.isIntersecting;
      },
      { rootMargin: '80px' },
    );
    intersectionObs.observe(canvas);
  }

  const onVisibilityChange = () => {
    tabVisible = document.visibilityState !== 'hidden';
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  const onPageHide = () => {
    running = false;
    cancelAnimationFrame(rafId);
  };
  window.addEventListener('pagehide', onPageHide);
  /*
   * bfcache 恢复（后退/前进回到本页）：pagehide 已把 rAF 杀了，必须有 pageshow
   * 复活，否则回来就是一帧定格。只有显式 destroy() 过的实例才不允许复活。
   */
  const onPageShow = () => {
    tabVisible = document.visibilityState !== 'hidden';
    if (destroyedByApi || running || reduceMotion) return;
    running = true;
    last = 0;
    rafId = requestAnimationFrame(loop);
  };
  window.addEventListener('pageshow', onPageShow);

  // 演示模式的键盘控制（宿主页面传 disableDemoKeys 时跳过 —— 两套监听同开会双重触发）
  let demoKeydownHandler: ((ev: KeyboardEvent) => void) | null = null;
  if (opts.demo && !opts.disableDemoKeys) {
    demoKeydownHandler = (ev: KeyboardEvent) => {
      if (ev.key === 'ArrowRight') {
        demoAuto = false; // 手动切换 = 锁定当前招，不再自动往后跳
        startDemoEntry(demoIdx + 1);
        ev.preventDefault();
      } else if (ev.key === 'ArrowLeft') {
        demoAuto = false;
        startDemoEntry(demoIdx - 1);
        ev.preventDefault();
      } else if (ev.key === ' ') {
        demoPaused = !demoPaused;
        ev.preventDefault();
      } else if (ev.key === 's' || ev.key === 'S') {
        demoSlow = !demoSlow;
      }
    };
    window.addEventListener('keydown', demoKeydownHandler);
  }

  // 启动游戏循环
  running = true;
  if (!reduceMotion) rafId = requestAnimationFrame(loop);

  // 对外接口（将来接 AI API 用）
  (window as any).takinolFight = {
    setController,
    /** 读取当前战况，方便外部 AI 参考 */
    /**
     * 决策日志（R-10）：最近 240 拍 AI 的"想法"。
     * 每条 = 时间 / 距离 / 局面分 / 当前意图 / 最终选择 / 前 3 名候选的分数与命中率。
     * 用法（DevTools）：
     *   console.table(takinolFight.aiLog().slice(-20))
     * 没有它，P0-2（时间预算）和 P0-3（期望值）的调整全是盲改。
     */
    aiLog: () => aiLog.slice(-240),
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
    /** 停止引擎（重新开打前调用）—— 完整清理所有资源 */
    destroy: () => {
      // 1. 停止游戏循环（防止 rAF 竞态：loop 开头检查 running）
      running = false;
      destroyedByApi = true;
      cancelAnimationFrame(rafId);
      // 2. 清理手动模式键盘监听
      keyAbort.abort();
      // 3. 移除所有事件监听器
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      if (demoKeydownHandler) window.removeEventListener('keydown', demoKeydownHandler);
      // 3.5 交还控制权：外部 AI 控制器是模块级单例，不还回去会「附身」到下一个实例
      setController(null);
      // 4. 断开 IntersectionObserver
      if (intersectionObs) { intersectionObs.disconnect(); intersectionObs = null; }
      // 5. 清理 resize 防抖定时器
      clearTimeout(resizeTimerId);
      // 6. 清空所有游戏状态
      fighters = [];
      sparks = [];
      popups = [];
      impactRings = [];
      speedLines = [];
      projectiles = [];
      shake = 0;
      shakeDir = 0;
      zoom = 0;
      // 7. 摘掉对外 API：防止页面拿着旧实例的 demo/destroy 再去操作僵尸引擎
      //（ fighters 已清空，多数方法有 !a 守卫，但显式摘掉最干净 ）
      delete (window as any).takinolFight;
    },
    /** 演示模式控制 */
    demo: {
      /** 当前英雄的演示列表（动态：换英雄就变） */
      get list() {
        return buildDemoList().map((e, i) => ({ i, key: e.key, name: e.name, kind: e.kind }));
      },      /**
       * 跳到某一招。
       * 默认会关闭自动轮播 —— 用户点了某一招，就应该只反复看这一招，
       * 而不是看完自动跳下一招（自动轮播请显式调用 auto(true)）。
       */
      go: (i: number, keepAuto = false) => {
        if (!keepAuto) demoAuto = false;
        demoPaused = false; // 手动选招时解除定格，否则画面停住不动
        // 列表里只会出现本英雄的招，所以换招不等于换人
        startDemoEntry(i);
      },
      /** 开关自动轮播（true = 播完自动下一招，false = 锁定循环当前招） */
      auto: (v?: boolean) => {
        demoAuto = v ?? !demoAuto;
        if (demoAuto) demoTimer = 0;
        return demoAuto;
      },
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
        const clip = clipOf(a, a.state) ?? CLIPS.idle;
        const t = Math.max(0, Math.min(0.999, frac));
        a.clipT = clip.dur * t;
        a.pose = sampleClip(clip, t);
        // 位置也按同一套确定性公式重算，否则定格帧的站位和实跑不一致（截图会骗人）
        const atk = atkOf(a, a.state);
        if (atk && (atk.lunge || atk.forward)) {
          a.x = a.atkStartX + a.facing * lungeDistAt(atk, t, clip.dur);
          a.x = Math.max(a.minX, Math.min(a.maxX, a.x));
        }
        // 定格时对手也要回到设计站位：否则实跑时的击退/漂移会把画面推出取景框，
        // 截出来的图和「这一招应该是什么样」完全对不上（判定体看着像飘在画面外）。
        const d0 = fighters[1];
        if (d0 && demoPin) {
          d0.x = demoPin.d;
          d0.kb = 0;
        }
        // 判定体按定格姿态重建，让 ?debug=frames 的红/绿框反映这一帧真实几何
        a.hitPrevVols = [];
        a.hitVols = atk
          ? atk.hits.map((h) => buildHitVolume(a, h.part ?? atk.part, h.tip ?? 0, (h.w ?? 0) * a.scale, h.sori ?? 0))
          : [];
        a.hitDone = [];
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
        const atk = atkOf(a, a.state);
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
      get autoOn() {
        return demoAuto;
      },
      /** 当前演示位套用的招式库编号（= ROSTER 索引），页面用它同步角色下拉框 */
      get kitId() {
        return fighters[0]?.kitId ?? 0;
      },
      /** 判定几何（红/绿胶囊）显示快照 */
      get geoOn() {
        return !!(debugOptions.frames || debugOptions.hitboxes);
      },
      /**
       * 运行时开关调试overlay —— 不用再往 URL 上拼 ?debug=frames。
       * 命中几何（红胶囊/绿受击框/黄扫掠/白命中点）在 debugOptions.frames 打开时实时绘制，
       * 这个对象每帧被渲染层读取，所以赋值立即生效。
       */
      debug: (patch?: { frames?: boolean; hitboxes?: boolean; bones?: boolean; hud?: boolean }) => {
        if (patch) Object.assign(debugOptions, patch);
        return {
          frames: !!debugOptions.frames,
          hitboxes: !!debugOptions.hitboxes,
          bones: !!debugOptions.bones,
        };
      },
      /** 一键开关「判定几何」 */
      toggleGeo: (v?: boolean) => {
        debugOptions.frames = v ?? !debugOptions.frames;
        return !!debugOptions.frames;
      },
    },
  };
}

/* ============================================================
 * 模块加载自检（BOOT_CHECKS）：无条件跑一次。
 * 之前两套自检都只在 debug 模式跑 —— lowSlash/risingSlash 漏登记
 * STATE_EVENT_MAP 的事故就是从这个盲区长出来的（新招式"不动"还没 VFX）。
 * 纯对象遍历，开销可忽略；分叉 = 控制台当场报错，不用等有人开调试页。
 * ============================================================ */
(() => {
  try {
    const res = validateDataConsistency();
    if (!res.ok) console.error('[fight] 数据表不一致：', res.errors);
    if (res.warnings.length) console.warn('[fight] 数据表警告：', res.warnings);
    const missingEvt = Object.keys(ATTACKS).filter((k) => !STATE_EVENT_MAP[k as State]);
    if (missingEvt.length) {
      console.info('[fight] STATE_EVENT_MAP 未登记的招式（不影响播放，但没 VFX）：', missingEvt.join(', '));
    }
  } catch (e) {
    // 自检本身出异常不能拖死引擎初始化
    console.error('[fight] 启动自检异常：', e);
  }
})();
