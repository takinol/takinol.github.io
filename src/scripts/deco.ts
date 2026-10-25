/**
 * ============================================================
 * 装饰物 + 布料物理：分层挂载架构（L0 锚点 / L1 刚体 / L2 柔体）
 * ============================================================
 *
 * 设计文档：design-3-deco-cloth.md（唯一真值，参数在文末 DECO_CFG）
 *
 * 三条总纲：
 *  G1 挂载系统只产出「点 + 朝向 + z」，不产画法（画法留在 fight.ts 的 drawFigure）。
 *  G2 刚性件在「面向空间 faced space」算（偏移要跟 facing 镜像）；
 *     柔性链在世界空间积分（重力是世界向量，否则转身时披风往天上飘）。
 *  G3 判定层不 import 装饰层任何类型 —— 装饰永不参与 hitVolume / hurtbox。
 *
 * 本模块不 import fight.ts 的任何东西（防循环依赖 + 防 G3 被打破）。
 */

/* ============ 基础类型 ============ */

export interface Vec3 { x: number; y: number; z: number }
export type JointKey =
  | 'pelvis' | 'chest' | 'head'
  | 'shoulderF' | 'elbowF' | 'handF'
  | 'shoulderB' | 'elbowB' | 'handB'
  | 'hipF' | 'kneeF' | 'footF'
  | 'hipB' | 'kneeB' | 'footB';

/** 只读视图：装饰层能读关节，但类型上写不回去（编译期约束） */
export type JointView = { readonly [K in JointKey]: Readonly<Vec3> };

/** 锚点可以绑「关节」，也可以绑「骨段」（骨段自带方向角，比单关节好用） */
export type AnchorBone =
  | JointKey
  | 'spine'      // pelvis → chest
  | 'neck'       // chest → head
  | 'upperArmF' | 'forearmF'
  | 'upperArmB' | 'forearmB'
  | 'thighF' | 'shinF'
  | 'thighB' | 'shinB';

/** 朝向模式：三选一，别加第四种 */
export type FrameMode =
  | 'bone'    // 跟随骨骼朝向（含 facing 镜像）—— 头盔/护腕/刀/护腿
  | 'facing'  // 只跟随身体朝向，不跟骨骼旋转 —— 护肩/胸甲徽记/披风根
  | 'none';   // 完全世界朝向（位置也不镜像）—— 腰坠根/悬浮物

export interface Anchor {
  bone: AnchorBone;
  frame: FrameMode;
  ox: number;            // 局部偏移 x（px，面向右时为正；'none' 时是世界 x）
  oy: number;            // 局部偏移 y（px，canvas y 向下为正）
  rot?: number;          // 额外局部旋转（rad），默认 0
  zOffset?: number;      // 相对根骨 z 的偏移，默认 0
}

export interface Circle { x: number; y: number; r: number; z: number }

/* ============ L2 柔体 ============ */

export interface ChainSpec {
  nodes: number;              // 节数（不含被钉死的根节点 0）
  len: number[];              // 每节长度 px，长度 === nodes
  g: number;                  // 重力 px/s²（表现放大 1.65×，见 DECO_CFG 注释）
  damp: number;               // 阻尼 1/s（指数阻尼，帧率无关）
  iters: 1 | 2 | 3;           // 约束迭代次数
  bendHz: number;             // 回正刚度 1/s（每迭代向 rest 角靠拢的速率）
  restSplay: number;          // 静止张开角 deg（每节累计，做出自然弧）
  swing: number;              // 相对「下垂」的最大偏角 deg（角度限位，防穿身）
  windAmp: number;            // 风幅 px/s²
  windHz: number;             // 风主频 Hz
  collide: boolean;           // 是否参与身体碰撞
  pushW: number;              // 碰撞推出强度 0..1（0.9 = 留 10% 残穿防边界抖）
  nodeR: number;              // 节点等效半径 px（碰撞用）
  maxStep: number;            // 单帧根位移超过此值 → 整链硬复位到静止形
  feedForward: number;        // 根速度前馈系数 0..1（0.85 = 留 15% 滞后的「重」感）
  side: -1 | 0 | 1;           // 分片张开方向
}

export interface ChainNode {
  x: number; y: number;      // 世界坐标
  px: number; py: number;    // 上一帧世界坐标（Verlet 的隐式速度）
  len: number;               // 到父节点的长度（nodes[0] 恒 0）
  z: number;                 // 深度（逐节插值）
}

export interface Chain {
  nodes: ChainNode[];        // nodes[0] = 根（每帧被钉死到锚点）
  spec: ChainSpec;
  windPhase: number;         // 每片错开，避免整片同步抖
  settled: boolean;          // 收敛标志（性能用：静止时跳过积分）
}

export interface DecoEnv {
  readonly joints: JointView;
  readonly facing: 1 | -1;
  readonly k: number;         // 角色缩放
  readonly t: number;         // 秒
  readonly windX: number;     // 全局风（px/s²）
  readonly windPulse: number; // 受击风脉冲（px/s²），由 fight.ts 衰减
  readonly circles: readonly Circle[];  // 身体碰撞体（只读）
}

/* ============ 小工具 ============ */

export const DOWN = Math.PI / 2;   // canvas y 向下
export const DEG = Math.PI / 180;
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const wrapPi = (a: number) =>
  ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
export const clampArc = (a: number, c: number, h: number) =>
  c + Math.max(-h, Math.min(h, wrapPi(a - c)));

/** 世界 → 面向空间：x 乘 facing（对合，T∘T = id） */
export const toFaced = (p: { x: number; y: number }, facing: 1 | -1) =>
  ({ x: p.x * facing, y: p.y });

/* ============ L0 锚点解算 ============ */

const BONE_PAIR: Partial<Record<AnchorBone, [JointKey, JointKey]>> = {
  spine: ['pelvis', 'chest'], neck: ['chest', 'head'],
  upperArmF: ['shoulderF', 'elbowF'], forearmF: ['elbowF', 'handF'],
  upperArmB: ['shoulderB', 'elbowB'], forearmB: ['elbowB', 'handB'],
  thighF: ['hipF', 'kneeF'], shinF: ['kneeF', 'footF'],
  thighB: ['hipB', 'kneeB'], shinB: ['kneeB', 'footB'],
};

/** 单关节锚点的方向代理：第二个点必须就是该关节本身（P = 第二个点） */
const BONE_PROXY: Partial<Record<JointKey, [JointKey, JointKey]>> = {
  head: ['chest', 'head'], chest: ['pelvis', 'chest'], pelvis: ['chest', 'pelvis'],
  shoulderF: ['chest', 'shoulderF'], shoulderB: ['chest', 'shoulderB'],
  elbowF: ['shoulderF', 'elbowF'], elbowB: ['shoulderB', 'elbowB'],
  handF: ['elbowF', 'handF'], handB: ['elbowB', 'handB'],
  hipF: ['pelvis', 'hipF'], hipB: ['pelvis', 'hipB'],
  kneeF: ['hipF', 'kneeF'], kneeB: ['hipB', 'kneeB'],
  footF: ['kneeF', 'footF'], footB: ['kneeB', 'footB'],
};

export function boneFrame(bone: AnchorBone, J: JointView): { P: Readonly<Vec3>; thetaWorld: number } {
  const pair = BONE_PAIR[bone] ?? BONE_PROXY[bone as JointKey];
  if (!pair) throw new Error(`[deco] 未知锚点骨: ${bone}`);
  const a = J[pair[0]], b = J[pair[1]];
  const dx = b.x - a.x, dy = b.y - a.y;
  // 退化保护：两点重合时用「向下」兜底，避免 atan2(0,0)
  const th = dx * dx + dy * dy < 1e-6 ? Math.PI / 2 : Math.atan2(dy, dx);
  return { P: b, thetaWorld: th };
}

const R = (a: number, x: number, y: number) =>
  ({ x: Math.cos(a) * x - Math.sin(a) * y, y: Math.sin(a) * x + Math.cos(a) * y });

export interface Resolved { root: { x: number; y: number }; ang: number; flip: 1 | -1; z: number }

export function resolveAnchor(a: Anchor, env: DecoEnv): Resolved {
  const { P, thetaWorld } = boneFrame(a.bone, env.joints);
  const rot = a.rot ?? 0;

  if (a.frame === 'none') {
    return { root: { x: P.x + a.ox, y: P.y + a.oy }, ang: rot, flip: 1, z: P.z + (a.zOffset ?? 0) };
  }
  const pF = toFaced(P, env.facing);
  // 世界角 → 面向角：镜像变换是「跨竖直轴翻 x」，即 θ_faced = π − θ_world。
  // （旋转 π 是错的——竖直骨骼会被翻成反方向；单元测试 1 抓过这个 bug）
  const thetaFaced = env.facing > 0 ? thetaWorld : wrapPi(Math.PI - thetaWorld);
  const ang = a.frame === 'bone' ? thetaFaced + rot : rot;
  const d = R(ang, a.ox, a.oy);
  const rf = { x: pF.x + d.x, y: pF.y + d.y };
  return {
    root: toFaced(rf, env.facing),   // 同一个函数（自逆）
    ang,
    flip: a.frame === 'bone' ? 1 : env.facing,
    z: P.z + (a.zOffset ?? 0),
  };
}

/* ============ 绘制顺序 ============ */

export const LAYER = {
  BackProp: 0,     // 披风主片、背后刀鞘、后发
  FarLimb: 10,     // 远侧手臂/腿 及其刚体挂件
  Torso: 20,       // 躯干 + 衣服 + 胸甲 + 腰坠
  NearLimb: 30,    // 近侧手臂/腿 及其刚件
  Head: 40,        // 头 + 头饰
  FrontProp: 50,   // 甩到身前的披风片、面罩、飘带
  Aura: 60,        // 特效层
} as const;

/**
 * 排序键：层差 10000，z 差 100（z 夹到 ±8，保证 ±800 < 10000 不串层），seq 兜底。
 * 升序绘制 = 远 → 近。
 */
export const Z_DIR = 1;
export const sortKey = (layer: number, z: number, seq: number) =>
  layer * 10000 + Z_DIR * clamp(z, -8, 8) * 100 + (seq % 100);

/* ============ L2 柔体链物理 ============ */

/** 由 spec 造链：初始摆成静止形，速度置零（首帧不弹）。位置等第一次 stepChain 时落锚。 */
export function makeChain(spec: ChainSpec, windPhase = Math.random() * 6.28): Chain {
  const c: Chain = { nodes: [], spec, windPhase, settled: true };
  for (let i = 0; i <= spec.nodes; i++)
    c.nodes.push({ x: 0, y: 0, px: 0, py: 0, len: i === 0 ? 0 : spec.len[i - 1], z: 0 });
  return c;
}

/** 硬复位：位置摆到静止形、速度清零。瞬移/换人/重生时用 —— 不要让链「追」。 */
export function resetChain(c: Chain, root: { x: number; y: number; z: number }) {
  const sp = c.spec, N = c.nodes;
  N[0].x = root.x; N[0].y = root.y; N[0].px = root.x; N[0].py = root.y;
  for (let i = 1; i <= sp.nodes; i++) {
    const nd = N[i];
    const ang = DOWN + (sp.restSplay * i + sp.swing * 0.35 * sp.side) * DEG;
    nd.x = N[i - 1].x + Math.cos(ang) * nd.len;
    nd.y = N[i - 1].y + Math.sin(ang) * nd.len;
    nd.px = nd.x; nd.py = nd.y;    // 速度清零，不放散
  }
  c.settled = true;
}

/**
 * 极坐标解算（不用两点距离约束 —— 那个天生会拉伸 3-8%）：
 * 一行拿到「长度构造性精确 + 角度限位 + 回正曲率」三件事。
 */
export function solveSegment(c: Chain, i: number, dt: number) {
  const sp = c.spec, a = c.nodes[i - 1], b = c.nodes[i], L = b.len;
  if (L <= 1e-6) return;
  let ang = Math.atan2(b.y - a.y, b.x - a.x);
  // 目标方向：下垂 + 分片张开 + 逐节静止弧（restSplay 正 = 向外卷）
  const target = DOWN + sp.swing * 0.12 * sp.side * DEG + sp.restSplay * i * DEG;
  const k = 1 - Math.exp(-sp.bendHz * dt);        // 帧率无关的回正速率
  ang += wrapPi(target - ang) * k;
  ang = clampArc(ang, DOWN, sp.swing * DEG);      // 角度限位（防穿身/防上翻）
  b.x = a.x + Math.cos(ang) * L;                  // 长度构造性精确
  b.y = a.y + Math.sin(ang) * L;
}

/** 身体碰撞圆（Q 版降维成 4 个圆，别一上来做胶囊） */
export function bodyCircles(J: JointView, k: number): Circle[] {
  const chest = { x: (J.pelvis.x + J.chest.x) / 2, y: (J.pelvis.y + J.chest.y) / 2, z: (J.pelvis.z + J.chest.z) / 2 };
  return [
    { x: chest.x, y: chest.y, r: DECO_CFG.bodyR.chest * k, z: J.chest.z },     // ① 躯干
    { x: J.pelvis.x, y: J.pelvis.y, r: DECO_CFG.bodyR.pelvis * k, z: J.pelvis.z }, // ② 骨盆
    { x: J.kneeB.x, y: J.kneeB.y, r: DECO_CFG.bodyR.knee * k, z: J.kneeB.z },  // ③ 远腿膝
    { x: J.kneeF.x, y: J.kneeF.y, r: DECO_CFG.bodyR.knee * k, z: J.kneeF.z },  // ④ 近腿膝
  ];
}

const EMPTY_CIRCLES: readonly Circle[] = [];

/**
 * 点-圆排斥 + 绕父节点归一化回长度。
 * 为什么第 2 步是「绕父节点旋转」而不是「两点各退一半」：
 * 后者会把位移传给上一节，整条披风被顶翻；前者只旋转本节，
 * 像布从膝盖上滑过去，观感正确且不注入能量。
 */
export function pushOutOfBody(c: Chain, i: number, env: DecoEnv) {
  const sp = c.spec, N = c.nodes, b = N[i], a = N[i - 1];
  const circles = env.circles;
  for (let ci = 0; ci < circles.length; ci++) {
    const col = circles[ci];
    // z 门控：碰撞体比节点更靠后 → 披风本来就该盖住它，不推
    if (col.z < b.z - 0.02) continue;
    const dx = b.x - col.x, dy = b.y - col.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const pen = col.r + sp.nodeR - dist;
    if (pen <= 0) continue;
    const nx = dist > 1e-6 ? dx / dist : 0;
    const ny = dist > 1e-6 ? dy / dist : -1;
    // 1) 先沿法线推出（pushW=0.9 留 10% 残穿，防边界抖）
    b.x += nx * pen * sp.pushW;
    b.y += ny * pen * sp.pushW;
    // 2) 再绕父节点把长度拉回（平移变旋转，长度精确）
    const vx = b.x - a.x, vy = b.y - a.y;
    const L2 = Math.sqrt(vx * vx + vy * vy) || 1;
    b.x = a.x + (vx / L2) * b.len;
    b.y = a.y + (vy / L2) * b.len;
  }
}

/**
 * 柔体链主循环。必须在固定步长累加器（FIXED = 1/60）里调，绝不能拿 render 的真实 dt。
 *
 * 棍化的三个成因分三个开关治：
 *  ① 根动拽链 → feedForward（积分前把根位移分给全链当初速）
 *  ② 约束不恢复曲率 → 极坐标解算 + restSplay 目标形状
 *  ③ 瞬移 → maxStep 硬复位（不要让它追）
 */
export function stepChain(c: Chain, root: { x: number; y: number; z: number }, env: DecoEnv, dt: number) {
  const sp = c.spec, n = sp.nodes, N = c.nodes;
  if (!Number.isFinite(N[0].x) || !Number.isFinite(root.x)) { resetChain(c, root); return; }

  /* ---- 0) 瞬移保护：一帧根走太远，硬复位而不是硬追 ---- */
  const dxr = root.x - N[0].x, dyr = root.y - N[0].y;
  if (dxr * dxr + dyr * dyr > sp.maxStep * sp.maxStep) { resetChain(c, root); return; }

  /* ---- 1) 根速度前馈：把根的位移先分给整条链（刚体平移不产生拉伸） ---- */
  const ff = sp.feedForward;
  if (ff > 0) {
    for (let i = 1; i <= n; i++) { N[i].px -= dxr * ff; N[i].py -= dyr * ff; }
  }
  N[0].x = root.x; N[0].y = root.y; N[0].px = root.x; N[0].py = root.y;

  /* z：逐节从 root.z 线性插值（zTip 量级 ≤0.2，只做明暗用） */
  for (let i = 0; i <= n; i++) N[i].z = root.z;

  /* ---- 2) Verlet 积分（指数阻尼，帧率无关；别写 *0.99 这种逐帧系数） ---- */
  const damp = Math.exp(-sp.damp * dt);
  const gy = sp.g * dt * dt;
  const wAmp = sp.windAmp > 0 ? env.windX + env.windPulse : 0;
  for (let i = 1; i <= n; i++) {
    const nd = N[i];
    const vx = (nd.x - nd.px) * damp;
    const vy = (nd.y - nd.py) * damp;
    nd.px = nd.x; nd.py = nd.y;
    // 风：分层正弦，末端系数更大（根部几乎不飘）
    let w = 0;
    if (wAmp !== 0) {
      w = wAmp * Math.pow(i / n, 1.5)
        * (Math.sin(2 * Math.PI * sp.windHz * env.t + c.windPhase)
          + 0.45 * Math.sin(2 * Math.PI * sp.windHz * 2.7 * env.t + c.windPhase * 1.7 + 1.3));
    }
    nd.x += vx + w * dt * dt;
    nd.y += vy + gy;
  }

  /* ---- 3) 约束迭代：极坐标解算 + 碰撞，交替；从根往尖扫 ---- */
  for (let it = 0; it < sp.iters; it++) {
    for (let i = 1; i <= n; i++) solveSegment(c, i, dt);
    if (sp.collide && env.circles.length) for (let i = 1; i <= n; i++) pushOutOfBody(c, i, env);
  }
  for (let i = 1; i <= n; i++) solveSegment(c, i, dt);   // 收尾，保证长度精确

  /* ---- 4) 收敛检测（静止时外部可跳过积分） ---- */
  let e = 0;
  for (let i = 1; i <= n; i++) e += Math.abs(N[i].x - N[i].px) + Math.abs(N[i].y - N[i].py);
  c.settled = e < 0.05 && Math.abs(dxr) + Math.abs(dyr) < 0.05;
}

/**
 * 链 → 一条带子：法线偏移左右两条边，圆头收尖，单次 fill（别描边）。
 * @param widthOverride 临时改宽度 [根, 尖]（风格化用）
 * @param sideShift 沿法线整体平移 px（正 = 向法线正向挪；一片拆两条带子/左右分片用）
 */
export function drawRibbon(
  ctx: CanvasRenderingContext2D, c: Chain, tint: string, alpha: number,
  widthOverride?: [number, number], sideShift = 0,
) {
  const N = c.nodes, n = c.spec.nodes;
  const [w0, w1] = widthOverride ?? [8, 8];
  const half = (i: number) => (w0 + (w1 - w0) * (i / n)) * 0.5;
  const nx = (i: number, s: number) => {
    const a = N[Math.max(0, i - 1)], b = N[Math.min(n, i + 1)];
    const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
    const off = half(i) * s + sideShift;
    return { x: N[i].x + Math.cos(ang) * off, y: N[i].y + Math.sin(ang) * off };
  };
  ctx.beginPath();
  for (let i = 0; i <= n; i++) { const p = nx(i, 1); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
  if (n >= 1) ctx.arc(N[n].x, N[n].y, half(n), 0, Math.PI, false);   // 圆头收尖
  for (let i = n; i >= 0; i--) { const p = nx(i, -1); ctx.lineTo(p.x, p.y); }
  ctx.closePath();
  ctx.globalAlpha = alpha; ctx.fillStyle = tint; ctx.fill(); ctx.globalAlpha = 1;
}

/* ============ 参数总表（唯一真值，别再散落在代码里） ============ */

/** 布片链预设的公共形状（DECO_CFG 里除 bodyR/windPulse/budget 外的键都长这样） */
interface ChainPreset {
  nodes: number;
  len: readonly number[];
  g: number; damp: number; iters: 1 | 2 | 3; bendHz: number;
  restSplay: number; swing: number; windAmp: number; windHz: number;
  collide: boolean; pushW: number; nodeR: number; maxStep: number; feedForward: number;
}

/** 真正的布片预设表（CLOTH_PRESET 只允许指向这四个键） */
const CHAIN_PRESETS: Record<'cape' | 'hair' | 'sash' | 'charm', ChainPreset> = {
  cape:  { nodes: 4, len: [15, 15, 15, 13], g: 1600, damp: 1.8, iters: 2, bendHz: 14,
           restSplay: 5, swing: 68, windAmp: 130, windHz: 0.7,
           collide: true, pushW: 0.9, nodeR: 4, maxStep: 26, feedForward: 0.85 },
  hair:  { nodes: 3, len: [9, 9, 8],     g: 1200, damp: 2.4, iters: 2, bendHz: 20,
           restSplay: 4, swing: 55, windAmp: 60, windHz: 1.1,
           collide: false, pushW: 1, nodeR: 3, maxStep: 26, feedForward: 0.9 },
  sash:  { nodes: 3, len: [11, 11, 10],  g: 1800, damp: 1.2, iters: 2, bendHz: 10,
           restSplay: 3, swing: 85, windAmp: 200, windHz: 0.9,
           collide: false, pushW: 1, nodeR: 2.5, maxStep: 26, feedForward: 0.85 },
  charm: { nodes: 2, len: [8, 7],        g: 2000, damp: 1.4, iters: 2, bendHz: 6,
           restSplay: 0, swing: 100, windAmp: 0, windHz: 0,
           collide: false, pushW: 1, nodeR: 1.5, maxStep: 26, feedForward: 1 },
};

/**
 * 参数总表（唯一真值，别再散落在代码里）。
 * 重力为什么是 1600 而不是物理的 970：
 * 970 在 60fps 下只有 0.27 px/帧²，披风下落要 20+ 帧，看起来「挂着不走」。
 * 1600 → 0.44 px/帧²，8 帧到位。这是表现放大 1.65×，别「修正」回去。
 */
export const DECO_CFG = {
  ...CHAIN_PRESETS,
  bodyR: { chest: 14, pelvis: 13, knee: 9 },   // 全部 × k
  windPulse: { impulse: 320, decay: 6 },        // px/s², 1/s（半衰期 115ms）
  budget: { maxSoftNodes: 28, maxRigid: 8 },
} as const;

/** 按 fight.ts 的布片风格选链参数（k = 角色缩放，在外面乘） */
export const CLOTH_PRESET: Record<string, 'cape' | 'hair' | 'sash' | 'charm'> = {
  cape2: 'cape',          // 盾卫两片短披风
  apron: 'cape',          // 矮人皮围裙
  hoodTail: 'hair',       // 兜帽短尾（更硬更快收敛）
  shoulderCape: 'cape',   // 弩手单侧短披风
  haori: 'cape',          // 羽织
  kilt: 'sash',           // 腰后兽皮尾
  coat: 'cape',           // 机关师背披布
  sash: 'sash',           // 斜袈裟
};

/** 由预设造布片链（长度 × k 缩放；side 由分片需求在外面改） */
export function makeClothChain(style: string, k: number, side: -1 | 0 | 1 = 0): Chain {
  const key = CLOTH_PRESET[style] ?? 'cape';
  const base = CHAIN_PRESETS[key];
  const spec: ChainSpec = {
    nodes: base.nodes,
    len: base.len.map((v) => v * k),
    g: base.g, damp: base.damp, iters: base.iters, bendHz: base.bendHz,
    restSplay: base.restSplay, swing: base.swing,
    windAmp: base.windAmp, windHz: base.windHz,
    collide: base.collide, pushW: base.pushW, nodeR: base.nodeR * k,
    maxStep: base.maxStep * k, feedForward: base.feedForward,
    side,
  };
  return makeChain(spec, [0, 1.9, 3.7][((side + 1) as 0 | 1 | 2)] ?? Math.random() * 6.28);
}

/* ============ G3 三道锁 ============ */

/**
 * 锁 2 的桥：深冻结关节快照。ESM 严格模式下写入直接抛 TypeError，
 * 装饰层想在 update 里改关节 = 运行期爆炸，而不是静默污染判定。
 */
export function freezeJoints<K extends string>(joints: Record<K, { x: number; y: number; z: number }>) {
  const s = {} as Record<string, Readonly<Vec3>>;
  for (const key of Object.keys(joints) as K[]) {
    const p = joints[key];
    s[key] = Object.freeze({ x: p.x, y: p.y, z: p.z });
  }
  return Object.freeze(s);
}
