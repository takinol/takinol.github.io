/**
 * 疾风剑客（build: swordsman）—— 本英雄专属招式库（完整副本，与其它英雄互不影响）
 *
 * 招式数：13　jab / cross / hook / uppercut / elbow / snapKick / pushKick / roundKick / sideKick / flyKick / slash / iai / counterStrike
 * 调参入口：直接改下面的数字即可。改这个文件不会影响任何其它英雄。
 */
import { P, type HeroKit } from '../types';

/** 架势（本英雄起手/收招的基准姿态） */
const GUARD = P({ lean: 0.05, armUB: 0.2, armLB: 0.35, armUF: -0.15, armLF: 0.3, legUB: -0.12, legUF: 0.12, legLF: 0.05 });

/**
 * 收刀架势（居合构）：侧身、左手搭在刀柄上、重心压低。
 * 剑客平时就是这个姿态 —— 刀在背上，出拳脚也不会握着刀。
 */
const SHEATHED = P({
  lean: 0.06, head: -0.02,
  armUB: 0.3, armLB: 0.6,
  armUF: 0.26, armLF: 0.18,
  legUB: -0.5, legUF: 0.62, legLF: 0.06,
  yaw: -0.1,
});
export const KIT: HeroKit = {
  id: 0,
  name: '疾风剑客',
  build: 'swordsman',
  atks: {
    /*
     * 刺拳 = 两拍连刺（ワンツー 的前半）。
     * 之前是「单拍 + 整招 forward=0」，所以第一拍打完人还站在原地，
     * 第二拍（如果画了）必然够不到 —— 这就是"隔空打"的来源。
     * 现在：第一拍命中后 chase 9px 贴上去，加上判定阶段的 12px 前压，
     * 第二拍开始前身体已经进到该在的位置。
     */
    jab: {
      part: 'handF',
      label: '刺拳（前手连刺）',
      hits: [
        { at: 0.3, dmg: [6, 10], reach: 1, knock: 110, chase: 9, height: 'high' },
        { at: 0.62, dmg: [7, 12], reach: 1, knock: 150, height: 'high' },
      ],
      hitstop: 0.04,
      react: 'light',
      // 起手压 5px → 判定阶段（两拍之间）再蹭 12px → 收招站定不后退
      lunge: { startup: 5, active: 12, recovery: 0 },
      stepIn: 26,
    },
    // 直拳：后脚蹬地 + 转胯，整体前移（起手只蓄 4px，判定阶段一下跨 18px）
    cross: {
      part: 'handB',
      label: '直拳（后手冲拳）',
      hits: [
        { at: 0.6, dmg: [12, 19], reach: 1.05, knock: 230, chase: 8, height: 'high' },
      ],
      hitstop: 0.06,
      react: 'heavy',
      lunge: { startup: 4, active: 18, recovery: -2 },
      stepIn: 24,
    },
    // 摆拳：横向弧线，转体带动，位移比直拳小（走过去靠步法，不靠拳头）
    hook: {
      part: 'handF',
      label: '摆拳（转身横击）',
      hits: [
        { at: 0.52, dmg: [13, 20], reach: 1.02, knock: 210, chase: 6, height: 'high' },
      ],
      hitstop: 0.06,
      react: 'light',
      lunge: { startup: 3, active: 11, recovery: -1 },
      stepIn: 20,
    },
    uppercut: {
      part: 'handB',
      label: '上勾拳（贴身挑击）',
      hits: [
        { at: 0.56, dmg: [16, 25], reach: 1, knock: 180, height: 'mid' },
      ],
      hitstop: 0.075,
      react: 'up',
      lunge: { startup: 4, active: 12, recovery: 0 },
      stepIn: 22,
      close: true,
    },
    elbow: {
      part: 'elbowF',
      label: '顶肘（贴身撞）',
      hits: [
        { at: 0.5, dmg: [14, 22], reach: 1.05, knock: 170, height: 'high' },
      ],
      hitstop: 0.07,
      react: 'heavy',
      lunge: { startup: 3, active: 16, recovery: 0 },
      stepIn: 18,
      close: true,
    },
    snapKick: {
      part: 'footF',
      label: '弹踢（小腿快踢）',
      hits: [
        { at: 0.5, dmg: [11, 18], reach: 1.2, knock: 260, height: 'mid' },
      ],
      hitstop: 0.055,
      react: 'light',
    },
    pushKick: {
      part: 'footF',
      label: '蹬腿（推距）',
      hits: [
        { at: 0.52, dmg: [14, 21], reach: 1.3, knock: 340, height: 'mid' },
      ],
      hitstop: 0.065,
      react: 'heavy',
    },
    roundKick: {
      part: 'footF',
      label: '横扫腿',
      hits: [
        { at: 0.54, dmg: [16, 24], reach: 1.3, knock: 300, height: 'mid' },
      ],
      hitstop: 0.075,
      react: 'heavy',
    },
    sideKick: {
      part: 'footF',
      label: '侧踹（重击倒）',
      hits: [
        { at: 0.54, dmg: [18, 27], reach: 1.35, knock: 430, height: 'mid' },
      ],
      hitstop: 0.08,
      react: 'heavy',
    },
    flyKick: {
      part: 'footF',
      label: '飞踢（腾空突进）',
      hits: [
        { at: 0.48, dmg: [18, 27], reach: 1.3, knock: 380, height: 'mid' },
      ],
      hitstop: 0.08,
      react: 'heavy',
      lunge: { startup: 12, active: 34, recovery: 0 },
      stepIn: 30,
      far: true,
    },
    /* ===== 剑术三招：只有这三招拔刀（armed），其余拳脚一律收刀 ===== */
    // 袈裟斩：上段斜劈，中距主力。刀风长但不快
    slash: {
      part: 'handF',
      armed: true,
      label: '袈裟斩（上段斜劈）',
      hits: [
        { at: 0.42, dmg: [16, 26], reach: 1.55, knock: 330, tip: 30, w: 2.4, act: 0.2, sori: 0.10, height: 'mid' },
      ],
      hitstop: 0.09,
      react: 'heavy',
      lunge: { startup: 4, active: 20, recovery: 0 },
    },
    // 拔刀斩：居合，最快最远的一击，收招也最长（打空就是大破绽）
    iai: {
      part: 'handF',
      armed: true,
      label: '拔刀斩（居合一闪）',
      hits: [
        { at: 0.4, dmg: [24, 36], reach: 1.7, knock: 430, tip: 34, w: 2.4, act: 0.16, sori: 0.10, height: 'high' },
      ],
      hitstop: 0.13,
      react: 'heavy',
      lunge: { startup: 6, active: 34, recovery: 0 },
      far: true,
    },
    /*
     * ── 择的两半 ──
     * 下段斩：必须**蹲防**才能挡。站防会被直接吃满伤害。
     * 上撩斩：必须**站防**才能挡。蹲防会被吃满伤害。
     * 加上袈裟斩（中段，也必须站防），剑客就同时拥有
     * 「打站防的下段」和「打蹲防的上撩/袈裟」，防守方才必须真的猜。
     */
    /*
     * 下段斩：蹲身 → 刀收在身后低位 → 贴地扫向前下方。
     * 判定帧必须落在「扫到最远最低」那一刻，不能落在收势里。
     */
    lowSlash: {
      part: 'handF',
      armed: true,
      label: '下段斩（扫腿斩）',
      hits: [
        { at: 0.40, dmg: [12, 20], reach: 1.35, knock: 240, tip: 28, w: 2.4, act: 0.2, sori: 0.10, height: 'low' },
      ],
      hitstop: 0.07,
      react: 'light',
      lunge: { startup: 3, active: 12, recovery: 0 },
      stepIn: 20,
    },
    /*
     * 上撩斩（逆袈裟）：刀先压到左下 → 自下而上挑到头顶前上方。
     * 判定部位必须和「抬起来的那只手」一致，否则刀在背后挑、看着像没动。
     */
    risingSlash: {
      part: 'handF',
      armed: true,
      label: '上撩斩（逆袈裟）',
      hits: [
        { at: 0.42, dmg: [15, 24], reach: 1.45, knock: 300, tip: 26, w: 2.4, act: 0.2, sori: 0.10, height: 'mid' },
      ],
      hitstop: 0.08,
      react: 'heavy',
      lunge: { startup: 4, active: 14, recovery: -1 },
      stepIn: 22,
    },
    // 返し斩：格挡后的反击斩，起手极短、伤害中上
    counterStrike: {
      part: 'handF',
      armed: true,
      label: '返し斩（格挡反击）',
      hits: [
        { at: 0.32, dmg: [18, 28], reach: 1.4, knock: 320, tip: 27, w: 2.4, act: 0.16, sori: 0.10, height: 'high' },
      ],
      hitstop: 0.11,
      react: 'heavy',
      lunge: { startup: 3, active: 13, recovery: 0 },
    },
  },

  /**
   * 剑客的受击表演：被打时先「护刀」再退 —— 握着刀的人不会像空手那样甩胳膊。
   * 放在 stateClips 里，只影响剑客，不动其他人的通用受击。
   */
  stateClips: {
    hurtLight: {
      dur: 0.32, loop: false,
      keys: [
        { t: 0, pose: SHEATHED },
        { t: 0.18, pose: P({ lean: -0.26, head: 0.16, armUB: 0.1, armLB: 1.0, armUF: 0.9, armLF: 1.5, legUB: -0.34, legUF: 0.42, legLF: 0.1, yaw: -0.14 }) },
        { t: 1, pose: SHEATHED },
      ],
    },
    hurtHeavy: {
      dur: 0.5, loop: false,
      keys: [
        { t: 0, pose: SHEATHED },
        { t: 0.22, pose: P({ lean: -0.5, head: 0.24, armUB: 0.5, armLB: 1.7, armUF: 1.1, armLF: 1.9, legUB: -0.52, legLB: 0.1, legUF: 0.44, legLF: 0.14, yaw: -0.24 }) },
        { t: 0.55, pose: P({ lean: -0.34, head: 0.16, armUB: 0.35, armLB: 1.5, armUF: 0.95, armLF: 1.7, legUB: -0.4, legUF: 0.4, legLF: 0.1, yaw: -0.16 }) },
        { t: 1, pose: SHEATHED },
      ],
    },
    hurtUp: {
      dur: 0.48, loop: false,
      keys: [
        { t: 0, pose: SHEATHED },
        { t: 0.2, pose: P({ lean: -0.2, head: 0.34, armUB: 0.2, armLB: 1.1, armUF: 0.7, armLF: 1.6, legUB: -0.3, legUF: 0.4, legLF: 0.12 }) },
        { t: 1, pose: SHEATHED },
      ],
    },
  },

  /**
   * 连招图（剑客）—— "图 + 确认结果 + 帧窗口 + 距离"，不是"命中后按概率接"。
   *
   * 核心是三条分叉：
   *   hit   ：打中了 → 可以接轻连（稳）、可以确认后赌拔刀斩（高伤高险）、也可以收了退开
   *   block ：被挡住了 → 只能破防或退，绝不能再连（否则等于把格挡当命中）
   *   whiff ：打空了 → 什么都不接，吃满收招硬直（表里故意不写 whiff 的出边）
   *
   * 剑客的决策困境就写在 iai 这条边上：
   *   袈裟斩命中确认之后，要不要贪那一刀拔刀斩？贪了打不中就吃大硬直。
   */
  combo: [
    // 袈裟斩命中
    { from: 'slash', to: 'slash', confirm: 'hit', window: [0.62, 0.92], range: 'edge', weight: 3 },
    { from: 'slash', to: 'iai', confirm: 'hit', window: [0.62, 0.92], range: 'edge', weight: 1 },
    { from: 'slash', to: 'retreat', confirm: 'hit', window: [0.62, 0.92], weight: 1 },
    // 袈裟斩被挡：破防或退
    { from: 'slash', to: 'hook', confirm: 'block', window: [0.62, 0.92], range: 'close', weight: 2 },
    { from: 'slash', to: 'retreat', confirm: 'block', window: [0.62, 0.92], weight: 2 },
    // 拔刀斩命中：贴身还有位置就补一刀，否则收手（居合打空/打远都是大破绽）
    { from: 'iai', to: 'slash', confirm: 'hit', window: [0.62, 0.92], range: 'close', weight: 1 },
    { from: 'iai', to: 'retreat', confirm: 'hit', window: [0.62, 0.92], weight: 2 },
    // 返し斩（格挡反击）命中：退开重整，或者贴着再来一刀
    { from: 'counterStrike', to: 'retreat', confirm: 'hit', window: [0.62, 0.92], weight: 2 },
    { from: 'counterStrike', to: 'slash', confirm: 'hit', window: [0.62, 0.92], range: 'edge', weight: 1 },
    /* ── 打康（counter：截击对手起手 / 惩罚他挥空）专属路线 ──
     * 打康的硬直更长，能接平时接不上的重招 —— 这就是"读招的回报"。 */
    { from: 'jab', to: 'iai', confirm: 'counter', window: [0.62, 0.95], weight: 3 },
    { from: 'slash', to: 'iai', confirm: 'counter', window: [0.62, 0.95], weight: 4 },
    { from: 'lowSlash', to: 'risingSlash', confirm: 'counter', window: [0.62, 0.95], weight: 3 },
    { from: 'risingSlash', to: 'slash', confirm: 'counter', window: [0.62, 0.95], weight: 3 },
    /* ── 择的连线：下段命中（他站防猜错）→ 中段压起身 ── */
    { from: 'lowSlash', to: 'risingSlash', confirm: 'hit', window: [0.62, 0.95], range: 'close', weight: 2 },
    { from: 'lowSlash', to: 'retreat', confirm: 'hit', window: [0.62, 0.95], weight: 1 },
    { from: 'risingSlash', to: 'retreat', confirm: 'hit', window: [0.62, 0.95], weight: 2 },
    /* ── 择的连线：下段命中（他站防猜错）→ 用中段压起身 ── */
    // 两拍刺拳命中：接直拳（第二拍本来就把重心送出去了，正好接后手）
    { from: 'jab', to: 'cross', confirm: 'hit', window: [0.62, 0.95], range: 'in', weight: 3 },
    { from: 'jab', to: 'hook', confirm: 'hit', window: [0.62, 0.95], range: 'in', weight: 1 },
    { from: 'cross', to: 'hook', confirm: 'hit', window: [0.62, 0.95], range: 'in', weight: 2 },
    { from: 'cross', to: 'retreat', confirm: 'hit', window: [0.62, 0.95], weight: 1 },
  ],

  clips: {
    /*
     * 两拍连刺：蓄 → 第一拳 → 半收＋后脚跟上（重心前压）→ 第二拳 → 站定。
     * 关键是 t=0.44 那一帧的「后脚蹬直、前脚落地」—— 这就是用户说的
     * 「第一个动作击打后应该后脚前移」，没有这一下，第二拳永远是隔空。
     * 时间轴和招式数据的 lunge（startup 5 / active 12）对齐：
     * 第一拳在 0.3，位移主要发生在 0.3~0.44 之间，正好是收拳换重心的那几帧。
     */
    jab: {
      dur: 0.52, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.14, pose: P({ lean: 0.1, head: -0.06, armUB: 1.05, armLB: 2, armUF: 0.72, armLF: 2.15, legUB: -0.28, legUF: 0.32, legLF: 0.1 }) },
        { t: 0.3, pose: P({ lean: 0.3, head: -0.02, armUB: 0.9, armLB: 2.05, armUF: 1.62, legUB: -0.42, legUF: 0.5, legLF: 0.04 }) },
        { t: 0.44, pose: P({ lean: 0.24, head: -0.04, armUB: 0.94, armLB: 2.02, armUF: 1.16, armLF: 1.92, legUB: -0.58, legUF: 0.66, legLF: 0.02 }) },
        { t: 0.62, pose: P({ lean: 0.34, head: 0, armUB: 0.88, armLB: 2.06, armUF: 1.7, armLF: 0.02, legUB: -0.66, legUF: 0.72, legLF: 0 }) },
        { t: 0.76, pose: P({ lean: 0.34, head: 0, armUB: 0.88, armLB: 2.06, armUF: 1.7, armLF: 0.02, legUB: -0.66, legUF: 0.72, legLF: 0 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
    cross: {
      dur: 0.66, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.3, pose: P({ lean: -0.14, head: -0.1, armUB: -1.05, armLB: 1.75, armUF: 1, armLF: 1.9, legUB: -0.18, legUF: 0.26, yaw: -0.32, armUBD: -0.45, armUFD: 0.25 }) },
        { t: 0.44, pose: P({ lean: -0.14, head: -0.1, armUB: -1.05, armLB: 1.75, armUF: 1, armLF: 1.9, legUB: -0.18, legUF: 0.26, yaw: -0.32, armUBD: -0.45, armUFD: 0.25 }) },
        { t: 0.62, pose: P({ lean: 0.32, head: 0.08, armUB: 1.72, armLB: 0.02, armUF: 0.42, armLF: 1.98, legUB: -0.52, legUF: 0.58, yaw: 0.34, armUBD: -0.12, armUFD: 0.3 }) },
        { t: 0.76, pose: P({ lean: 0.32, head: 0.08, armUB: 1.72, armLB: 0.02, armUF: 0.42, armLF: 1.98, legUB: -0.52, legUF: 0.58, yaw: 0.34, armUBD: -0.12, armUFD: 0.3 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
    hook: {
      dur: 0.54, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.3, pose: P({ lean: -0.1, head: -0.05, armUB: 0.9, armLB: 1.9, armUF: -0.35, armLF: 1.1, legUB: -0.24, legUF: 0.3, yaw: -0.2, armUFD: -1 }) },
        { t: 0.54, pose: P({ lean: 0.34, head: 0.1, armUB: 0.95, armLB: 1.95, armUF: 1.62, armLF: 1.05, legUB: -0.46, legUF: 0.5, yaw: 0.26, armUFD: 0.45, armLFD: 0.2 }) },
        { t: 0.7, pose: P({ lean: 0.34, head: 0.1, armUB: 0.95, armLB: 1.95, armUF: 1.62, armLF: 1.05, legUB: -0.46, legUF: 0.5, yaw: 0.26, armUFD: 0.45, armLFD: 0.2 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
    uppercut: {
      dur: 0.62, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.3, pose: P({ lean: 0.34, head: 0.08, armUB: 0.1, armLB: 2.35, armUF: 0.85, armLF: 1.9, legUB: 0.4, legLB: -0.95, legUF: 0.45, legLF: -1, yaw: -0.15, armUBD: -0.75 }) },
        { t: 0.56, pose: P({ lean: 0.02, head: 0.16, armUB: 1.95, armLB: 0.22, armUF: 0.75, armLF: 1.85, legUB: -0.1, legUF: 0.16, yaw: 0.06, armUBD: -0.3 }) },
        { t: 0.72, pose: P({ lean: 0.02, head: 0.16, armUB: 1.95, armLB: 0.22, armUF: 0.75, armLF: 1.85, legUB: -0.1, legUF: 0.16, yaw: 0.06, armUBD: -0.3 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
    elbow: {
      dur: 0.44, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.28, pose: P({ lean: 0.14, head: -0.04, armUB: 1, armLB: 2.1, armUF: 0.55, armLF: 2.4, legUB: -0.26, legUF: 0.32, yaw: -0.14, armUFD: -0.6 }) },
        { t: 0.5, pose: P({ lean: 0.46, head: 0.08, armUB: 0.95, armLB: 2.05, armUF: 1.5, armLF: 2.42, legUB: -0.5, legUF: 0.5, yaw: 0.12, armUFD: -0.12 }) },
        { t: 0.66, pose: P({ lean: 0.46, head: 0.08, armUB: 0.95, armLB: 2.05, armUF: 1.5, armLF: 2.42, legUB: -0.5, legUF: 0.5, yaw: 0.12, armUFD: -0.12 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
    snapKick: {
      dur: 0.46, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.3, pose: P({ lean: -0.1, head: -0.04, armUB: 0.7, armLB: 1.6, armUF: 0.95, armLF: 1.4, legUB: 0.1, legUF: 0.92, legLF: -1.6 }) },
        { t: 0.5, pose: P({ lean: -0.22, head: -0.05, armUB: 0.35, armLB: 1.3, armUF: 0.6, armLF: 1.15, legUB: 0.14, legUF: 1.26, legLF: 0.05 }) },
        { t: 0.64, pose: P({ lean: -0.22, head: -0.05, armUB: 0.35, armLB: 1.3, armUF: 0.6, armLF: 1.15, legUB: 0.14, legUF: 1.26, legLF: 0.05 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
    pushKick: {
      dur: 0.54, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.3, pose: P({ lean: -0.12, head: -0.03, armUB: 0.8, armLB: 1.5, armUF: 1, armLF: 1.3, legUB: 0.1, legUF: 0.95, legLF: -1.4 }) },
        { t: 0.52, pose: P({ lean: -0.32, head: -0.04, armUB: 0.2, armLB: 1.1, armUF: 0.4, armLF: 1, legUB: 0.14, legUF: 1.36, legLF: 0.06 }) },
        { t: 0.68, pose: P({ lean: -0.32, head: -0.04, armUB: 0.2, armLB: 1.1, armUF: 0.4, armLF: 1, legUB: 0.14, legUF: 1.36, legLF: 0.06 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
    roundKick: {
      dur: 0.6, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.32, pose: P({ lean: -0.24, head: -0.04, armUB: 0.55, armLB: 1.4, armUF: 0.9, armLF: 1.25, legUB: 0.1, legUF: 1.5, legLF: -1, legUFD: -0.35 }) },
        { t: 0.54, pose: P({ lean: -0.5, head: -0.1, armUB: -0.35, armLB: 0.9, armUF: 0.3, armLF: 1.2, legUB: 0.12, legUF: 1.95, legLF: 0.05, legUFD: 0.35 }) },
        { t: 0.7, pose: P({ lean: -0.5, head: -0.1, armUB: -0.35, armLB: 0.9, armUF: 0.3, armLF: 1.2, legUB: 0.12, legUF: 1.95, legLF: 0.05, legUFD: 0.35 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
    sideKick: {
      dur: 0.6, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.32, pose: P({ lean: -0.36, head: -0.05, armUB: 0.4, armLB: 1.3, armUF: 0.6, armLF: 1.2, legUB: 0.1, legUF: 1.1, legLF: -1.3 }) },
        { t: 0.54, pose: P({ lean: -0.6, head: -0.08, armUB: -0.8, armLB: 0.6, armUF: -0.95, armLF: 0.7, legUB: 0.12, legUF: 1.56, legLF: 0.02 }) },
        { t: 0.7, pose: P({ lean: -0.6, head: -0.08, armUB: -0.8, armLB: 0.6, armUF: -0.95, armLF: 0.7, legUB: 0.12, legUF: 1.56, legLF: 0.02 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
    flyKick: {
      dur: 0.82, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.18, pose: P({ lean: 0.34, head: -0.1, armUB: -0.6, armLB: 0.8, armUF: -0.7, armLF: 0.9, legUB: 0.62, legLB: -1.35, legUF: 0.58, legLF: -1.6 }) },
        { t: 0.44, pose: P({ lean: -0.08, head: 0.06, armUB: 0.9, armLB: 1.1, armUF: 1.1, armLF: 1, legUB: -0.2, legUF: 1.52, lift: 22 }) },
        { t: 0.62, pose: P({ lean: -0.08, head: 0.06, armUB: 0.9, armLB: 1.1, armUF: 1.1, armLF: 1, legUB: -0.2, legUF: 1.52, lift: 22 }) },
        { t: 0.82, pose: P({ lean: 0.4, head: -0.14, armUB: -0.5, armLB: 0.95, armUF: -0.6, armLF: 1, legUB: 0.62, legLB: -1.3, legUF: 0.5, legLF: -1.4 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
    // 袈裟斩：收刀侧身 → 举刀过右肩 → 斜劈到左下 → 回身收刀
    slash: {
      dur: 0.56, loop: false,
      keys: [
        { t: 0, pose: SHEATHED },
        { t: 0.24, pose: P({ lean: -0.16, head: -0.08, armUB: 2.15, armLB: 0.65, armUF: 2, armLF: 0.5, armUFD: 0.2, legUB: -0.35, legUF: 0.4, yaw: 0.22 }) },
        { t: 0.42, pose: P({ lean: 0.48, head: 0.12, armUB: 0.5, armLB: 0.3, armUF: 0.35, armLF: 0.55, legUB: -0.66, legUF: 0.72, yaw: -0.14 }) },
        { t: 0.56, pose: P({ lean: 0.48, head: 0.12, armUB: 0.5, armLB: 0.3, armUF: 0.35, armLF: 0.55, legUB: -0.66, legUF: 0.72, yaw: -0.14 }) },
        { t: 1, pose: SHEATHED },
      ],
    },
    // 拔刀斩：极深侧身蓄力（刀还在鞘里）→ 一闪而出 → 定格 → 收刀
    iai: {
      dur: 0.62, loop: false,
      keys: [
        { t: 0, pose: SHEATHED },
        { t: 0.3, pose: P({ lean: 0.1, head: 0.03, armUB: -0.55, armLB: 1.8, armUF: 0.4, armLF: 1.35, legUB: -0.55, legUF: 0.62, yaw: -0.4 }) },
        { t: 0.4, pose: P({ lean: 0.54, head: 0.02, armUB: 1.5, armLB: 0.2, armUF: 1.72, armUFD: 0.15, legUB: -0.72, legUF: 0.8, yaw: 0.34 }) },
        { t: 0.56, pose: P({ lean: 0.54, head: 0.02, armUB: 1.5, armLB: 0.2, armUF: 1.72, armUFD: 0.15, legUB: -0.72, legUF: 0.8, yaw: 0.34 }) },
        { t: 1, pose: SHEATHED },
      ],
    },
    // 下段斩：蹲身、刀贴地扫出（判定在低段，必须蹲防才能挡）
    // 下段斩：蹲身蓄势 → 贴地扫到前下方 → 定格 → 收刀
    // 下段斩：蹲身蓄势 → 贴地扫到前下方 → 定格 → 收刀
    lowSlash: {
      dur: 0.54, loop: false,
      keys: [
        { t: 0, pose: SHEATHED },
        { t: 0.16, pose: P({ lean: 0.34, head: 0.12, armUB: 0.55, armLB: 1.35, armUF: 0.62, armLF: 2.15, legUB: -0.72, legLB: -0.55, legUF: 0.8, legLF: 0.15, yaw: -0.2 }) },
        { t: 0.40, pose: P({ lean: 0.66, head: 0.16, armUB: 0.42, armLB: 0.95, armUF: 0.3, armLF: 0.18, armUFD: 0.25, legUB: -0.92, legLB: 0.3, legUF: 1.02, legLF: 0.05, yaw: 0.22 }) },
        { t: 0.52, pose: P({ lean: 0.66, head: 0.16, armUB: 0.42, armLB: 0.95, armUF: 0.3, armLF: 0.18, armUFD: 0.25, legUB: -0.92, legLB: 0.3, legUF: 1.02, legLF: 0.05, yaw: 0.22 }) },
        { t: 1, pose: SHEATHED },
      ],
    },
    // 上撩斩：从下往上逆袈裟，刀往斜上挑（中段，必须站防）
    // 上撩斩：压刀到左下 → 自下而上挑到头顶前上方 → 定格 → 收刀
    // 上撩斩：压刀到左下 → 自下而上挑到头顶前上方 → 定格 → 收刀
    risingSlash: {
      dur: 0.58, loop: false,
      keys: [
        { t: 0, pose: SHEATHED },
        { t: 0.2, pose: P({ lean: 0.42, head: 0.14, armUB: 1.05, armLB: 1.5, armUF: 0.24, armLF: 0.22, armUFD: -0.2, legUB: -0.62, legUF: 0.74, yaw: -0.22 }) },
        { t: 0.42, pose: P({ lean: -0.22, head: -0.24, armUB: 0.5, armLB: 1.2, armUF: 2.05, armLF: 0.12, armUFD: 0.3, legUB: -0.28, legUF: 0.36, yaw: 0.2 }) },
        { t: 0.6, pose: P({ lean: -0.22, head: -0.24, armUB: 0.5, armLB: 1.2, armUF: 2.05, armLF: 0.12, armUFD: 0.3, legUB: -0.28, legUF: 0.36, yaw: 0.2 }) },
        { t: 1, pose: SHEATHED },
      ],
    },
    // 下段斩：蹲身、刀贴地扫出（判定在低段 → 必须蹲防）
    // 上撩斩：从下往上逆袈裟，刀往斜上挑（中段 → 必须站防）
    // 下段斩：蹲身、刀贴地扫出（判定在低段 → 必须蹲防）
    // 上撩斩：从下往上逆袈裟，刀往斜上挑（中段 → 必须站防）
    // 返し斩：短促横斩，起手不蓄力（反击用）
    counterStrike: {
      dur: 0.44, loop: false,
      keys: [
        { t: 0, pose: SHEATHED },
        { t: 0.18, pose: P({ lean: 0.04, armUB: -0.3, armLB: 1.4, armUF: -0.2, armLF: 1.35, legUB: -0.4, legUF: 0.46, yaw: -0.2 }) },
        { t: 0.32, pose: P({ lean: 0.36, head: 0.05, armUB: 1.5, armLB: 0.2, armUF: 1.55, armLF: 0.08, armUFD: 0.2, legUB: -0.52, legUF: 0.6, yaw: 0.24 }) },
        { t: 0.46, pose: P({ lean: 0.36, head: 0.05, armUB: 1.5, armLB: 0.2, armUF: 1.55, armLF: 0.08, armUFD: 0.2, legUB: -0.52, legUF: 0.6, yaw: 0.24 }) },
        { t: 1, pose: SHEATHED },
      ],
    },
  },
};
