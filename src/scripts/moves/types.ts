/**
 * 招式库的类型定义（从 fight.ts 抽出，供 moves/ 下的数据文件使用）
 *
 * 设计原则：
 *   招式 = 纯数据（数值 + 姿态 + 节奏），不含任何逻辑。
 *   每个英雄持有一份自己的完整副本（见 kits/），互不引用、互不影响。
 */

/** 姿态：18 个自由度 + 位移/转体 */
export interface Pose {
  /** 躯干前倾（正=前倾，负=后仰） */
  lean: number;
  /** 头部俯仰偏移 */
  head: number;
  /** 后臂上臂角 */
  armUB: number;
  /** 后臂前臂角 */
  armLB: number;
  /** 前臂上臂角 */
  armUF: number;
  /** 前臂前臂角 */
  armLF: number;
  /** 后腿上腿角 */
  legUB: number;
  /** 后腿小腿角 */
  legLB: number;
  /** 前腿上腿角 */
  legUF: number;
  /** 前腿小腿角 */
  legLF: number;
  /** 整体垂直位移（正=抬起） */
  lift: number;
  /** 绕竖轴自转（旋踢/转身用，弧度×2π） */
  spin: number;
  /** 转体偏航（转身出招用） */
  yaw: number;
  /** 后臂上臂深度外展（正=靠近镜头） */
  armUBD: number;
  /** 前臂上臂深度外展 */
  armUFD: number;
  /** 后臂前臂深度外展 */
  armLBD: number;
  /** 前臂前臂深度外展 */
  armLFD: number;
  /** 后腿上腿深度外展 */
  legUBD: number;
  /** 前腿上腿深度外展 */
  legUFD: number;
  /** 后腿小腿深度外展 */
  legLBD: number;
  /** 前腿小腿深度外展 */
  legLFD: number;
}

/** 构造姿态：只写关心的字段，其余归零 */
export const P = (p: Partial<Pose>): Pose => ({
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

/** 动画片段：若干关键帧 + 总时长 */
export interface Clip {
  /** 片段总时长（秒） */
  dur: number;
  /** 是否循环（待机/走路循环，出招不循环） */
  loop?: boolean;
  /** 关键帧（t=0~1 归一化进度） */
  keys: { t: number; pose: Pose }[];
}

/** 打击部位 */
export type StrikePart = 'handF' | 'handB' | 'elbowF' | 'kneeF' | 'footF' | 'footB';

/** 装备流派 */
export type Gear =
  | 'swordsman'
  | 'ranger'
  | 'shield'
  | 'spear'
  | 'dagger'
  | 'monk'
  | 'hammer'
  | 'gunner'
  | 'ninja'
  | 'drunk'
  | 'viking'
  | 'samurai'
  | 'flail'
  | 'puppeteer';

/** 一次打击（多段招式就写多条） */
export interface AtkHit {
  /** 判定窗口起点（片段进度 0~1） */
  at: number;
  /** 伤害区间 [最小, 最大] */
  dmg: [number, number];
  /** AI 估算射程用的系数（判定本身不看它） */
  reach: number;
  /** 击退力度（px/s） */
  knock: number;
  /** 不写就用招式的默认部位 */
  part?: StrikePart;
  /** 武器尖端长度（px，沿前臂方向刚性延伸）；-1 = 用链锤甩球做接触点 */
  tip?: number;
  /** 攻击判定体粗细（px）——武器的胖瘦 */
  w?: number;
  /** 判定持续窗口（片段进度，默认 0.14） */
  act?: number;
  /**
   * 攻击段位（择的基础）：
   *   'high' 上段：站防/蹲防都能挡（大多数拳脚）
   *   'mid'  中段/跳劈：**必须站防** —— 蹲防挡不住
   *   'low'  下段：**必须蹲防** —— 站防挡不住
   * 有了这个字段，防御才有"猜拳"的压力，进攻才有"择"的意义。
   * 不写 = 'high'（两种防御都能挡，最安全也最没有博弈价值）。
   */
  height?: 'high' | 'mid' | 'low';
  /**
   * 刀身弯曲度（反り）：弓高 = sori * 刃长。0 或不写 = 直刃（枪/棍/剑）。
   * 0.09 ≈ 日本刀；判定体也会按这条弧线做成折线胶囊链，视觉与判定同源。
   */
  sori?: number;
  /**
   * 瞬移跟进距离（px，仅多段招用）。
   * 这一击打中后，攻击者立刻向对手方向贴上去这么远（不超过对手身前），
   * 否则长兵器/连斩第一段把对手打退后，第二段就够不着 = 隔空打。
   */
  chase?: number;
}

/** 一个招式 */
export interface Atk {
  /** 默认打击部位 */
  part: StrikePart;
  /** 打击段（可多段） */
  hits: AtkHit[];
  /** 命中定格时长（秒） */
  hitstop: number;
  /** 连招取消点：命中后过了这个片段进度就能接下一段 */
  cancelFrom?: number;
  /** 弹道招式：发射投射物，命中判定交给投射物 */
  projectile?: 'bolt' | 'shuriken';
  /** 投技：不可格挡，命中必倒 */
  throw?: true;
  /** 打中后对手用哪种反应 */
  react: 'light' | 'heavy' | 'up';
  /** 出招期间的前冲速度（px/s，确定性积分；legacy，新的写 lunge） */
  forward?: number;
  /**
   * 分段位移（px）：起手 / 判定 / 收招 各自走多远，净位移 = 三段之和。
   * 这是「真实位移」的正确粒度 —— 一格刺拳不是「整招挪 10px」，
   * 而是「起手重心前压 6px → 出拳再蹭 5px → 收招保持不动」，打完人已经贴上去了，
   * 直拳才够得到。不写则回退到 forward（整招一条曲线）。
   */
  lunge?: {
    /** 起手阶段（0 → 第一个命中帧）前进多少 px */
    startup?: number;
    /** 判定阶段（第一个命中帧 → 判定窗结束）前进多少 px */
    active?: number;
    /** 收招阶段（判定结束 → 1）前进多少 px，负数 = 收招退半步 */
    recovery?: number;
  };
  /**
   * 收招结束后的跟进步（px）：距离不够就自动垫一小步。
   * 0/不写 = 不跟（重兵器、投技一般不需要）。
   */
  stepIn?: number;
  /** 只在近距离才出（肘/膝） */
  close?: true;
  /** 远距离突进（飞踢/旋踢） */
  far?: true;
  /**
   * 本英雄对这一招的叫法（演示列表里显示）。
   * 同一招在不同英雄手里叫法可能不同：剑客的 slash 叫「袈裟斩」，
   * 双刃影客的 slash 叫「二连斩」——所以名字挂在招式数据上，不是全局的。
   */
  label?: string;
  /**
   * 这一招是否「手持武器」。
   * true  = 出招时武器握在手上（斩/刺/居合…）
   * false = 空手出招（拳/肘/膝/踢），武器收在背上或腰间
   * 不写    = 沿用该流派的默认（GEAR_SPEC.weaponInHand）
   *
   * 这样同一个英雄可以「平时收刀打拳脚，抓住破绽才拔刀」，
   * 而不是从头到尾一直举着兵器。
   */
  armed?: boolean;
}

/**
 * 连招图的一条边（图，不是链）。
 *
 * 为什么必须是图：同一招命中后可能接轻连、接大招、接退步，
 * 链表达不了分支。而「能接什么」由三件事共同决定：
 *   ① 上一招的结果（确认）：命中 / 格挡 / 挥空 —— 三者可接的东西完全不同
 *   ② 帧窗口：太早接不上、太晚窗口关了
 *   ③ 距离：太远够不到、太近长兵器打不出
 * 把这三条写进边里，连招才是「可解释的」而不是「随机接上的」。
 */
export interface ComboEdge {
  /** 从哪一招来 */
  from: string;
  /** 接到哪一招（'retreat' / 'idle' 这类非攻击状态也可以作为"打完就退"） */
  to: string;
  /** 需要什么确认结果 */
  confirm: 'hit' | 'block' | 'whiff' | 'counter';
  /** 本招的归一化进度窗口 [起, 止]，通常是判定窗结束后那几帧 */
  window: [number, number];
  /** 距离要求（Spatial State），不写 = 不限 */
  range?: 'out' | 'edge' | 'in' | 'close';
  /** 权重（AI 在可选集合里抽签用），默认 1 */
  weight?: number;
  /**
   * 打空后果（R-6）：'safe' 打空也能收；'punished' 打空要吃大硬直。
   * 期望值决策用它算风险 —— 拔刀斩是 punished，轻连是 safe。
   */
  onWhiff?: 'safe' | 'punished';
  /** 命中收益（伤害 + 位置价值），不写就自动取该招期望伤害 */
  payoff?: number;
  /**
   * 需要的确认强度 0~1（R-6）：0 = 命中也接得心安理得；
   * 0.6 = 要"打实了"才接；1 = 只有打康（counter）才允许贪。
   */
  conviction?: number;
}

/**
 * 一个英雄的招式库（完整副本）
 *
 * atks / clips 是这个英雄独有的数据，改动不会影响别的英雄。
 */
export interface HeroKit {
  /** ROSTER 索引（0~14） */
  id: number;
  /** 角色名 */
  name: string;
  /** 流派（决定剪影/体型/武器绘制，以及 AI 行为 archetype） */
  build: Gear;
  /** 本英雄的招式数值（键 = 招式名，同时也是状态名） */
  atks: Record<string, Atk>;
  /** 本英雄的招式姿态/节奏（键同上） */
  clips: Record<string, Clip>;
  /**
   * 本英雄对「状态片段」的覆盖（受击/格挡/待机…）。
   * 与 clips 分开放：这些是英雄专属的表演，不参与全局并集，
   * 否则某个英雄改一下受击动作会影响所有人。
   */
  stateClips?: Record<string, Clip>;
  /**
   * 连招图（可选）。不写则退回引擎里的通用连招表（按概率接下一招）。
   * 写了这个，这套英雄的连招就变成"图 + 确认结果 + 帧窗口 + 距离"，可解释。
   */
  combo?: ComboEdge[];
}
