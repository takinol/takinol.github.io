/**
 * 日本刀（katana）的程序化几何与绘制 —— 唯一真相源
 *
 * 为什么单独一个模块：
 *   绘制（drawKatana）和命中判定（bladeCenterline）必须是**同一条曲线**。
 *   只要两边各算一遍，就会漂：画出来的弧度和判定用的胶囊对不上，
 *   于是「看着砍到了、判定没中」这种老问题会以另一种形式回来。
 *
 * 比例全部由「刃长 L」推导，k 只影响描边粗细 ——
 * 这样短刀和长刀看起来是同一把刀的不同尺寸，而不是同一把刀被压扁拉长。
 *
 * 真实太刀参考（刃长 70cm）：
 *   柄 26cm = 0.37L ／ 刀身宽 3.2cm = 0.046L ／ 镡直径 7.5cm = 0.107L
 *   反り（弯曲）1.5~2.5cm ≈ 0.03L —— 这个尺度上等于没有弧度，所以视觉夸张。
 */

export interface KPt {
  x: number;
  y: number;
  z?: number;
}

/** 反り（弯曲度）系数：刀尖相对柄轴的偏移 = 2 × sori × 刃长 */
export const KATANA_SORI = 0.10;

/** 曲率方程的指数：1.75 = 根段近乎笔直、末段明显上翘（贴合刀胚圆弧的手感） */
export const KATANA_BOW_POW = 1.55;

/** 刀身全宽 / 刃长。真实 4.6%，这里夸张到 17%（26px 的刀 → 4.4px 宽，勉强读得出「刃」） */
export const KATANA_WIDTH_RATIO = 0.085;

/**
 * 刀刃中线（世界坐标）：从 hand 沿 angle 伸出 len，按反り弯成一条弧。
 *
 * 曲率沿刃身**单调累积**（不是两端落在弦上的对称鼓包）：
 * 真实刀胚就是一个恒定半径的圆弧，柄轴顺着圆弧起点的切线，
 * 越靠刀尖偏得越多 —— 这也正是「弯刀」和「弓」在剪影上的区别。
 *
 * @param n 折线段数（判定用的折线胶囊链取 n+1 个点）
 */
export const bladeCenterline = (
  hand: KPt,
  angle: number,
  len: number,
  sori: number = KATANA_SORI,
  n = 4,
  /** 朝向。必须传！drawKatana 在 facing<0 时会镜向局部 y，
   *  判定体如果不按同一个规则镜像，朝向换成左边时刀和判定就会一上一下。 */
  facing = 1,
): KPt[] => {
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  /*
   * 弓（反り）的方向，与 drawKatana 的变换严格对应：
   *   绘制时局部点 (x, cy) 在 facing<0 会先被 scale(1,-1) 镜像，再 rotate(angle)。
   *   推导下来世界偏移 = facing × B × (sinθ, -cosθ)。
   * 之前用的是「永远朝屏幕上方鼓 + 一个猜测性的翻转」，
   * 结果朝向为左时和绘制正好反了 —— 表现就是"剑在上面、红胶囊在下面"。
   */
  const bx = facing * dirY;
  const by = -facing * dirX;
  const bow = sori * len * 2;
  const out: KPt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const B = bow * Math.pow(t, KATANA_BOW_POW);
    out.push({
      x: hand.x + dirX * (len * t) + bx * B,
      y: hand.y + dirY * (len * t) + by * B,
      z: hand.z,
    });
  }
  return out;
};

/** 刀身半宽剖面：根到 86% 缓慢收窄，最后 14% 收成 kissaki（刀尖） */
const halfWidth = (t: number, hw0: number) =>
  t <= 0.86 ? hw0 * (1 - 0.22 * t) : hw0 * 0.81 * (1 - (t - 0.86) / 0.14);

/**
 * 画一把日本刀。
 *
 * 进入「刀空间」：平移到手，旋转到前臂方向，+x 沿刀身指向刀尖。
 * 画：柄(tsuka) → 镡(tsuba) → 鎺(habaki) → 刀身(ha/mune/hamon) → 刀尖高光。
 *
 * @param len  刃长（px）。**不要乘 k** —— 判定体的 tip 也不乘 k，两者必须同长
 * @param k    描边粗细的基准（体型缩放），不影响任何长度/宽度比例
 * @param outline 描边色
 */
export const drawKatana = (
  ctx: CanvasRenderingContext2D,
  hand: KPt,
  angle: number,
  len: number,
  k: number,
  facing: number,
  outline: string,
  alpha = 1,
) => {
  const Lb = Math.max(18, len);
  const bow = Lb * KATANA_SORI * 2;

  // ── 全部尺寸由刃长推导（比例见文件头注释）──
  const hw0 = Math.max(0.9, Lb * KATANA_WIDTH_RATIO); // 根元半宽
  const tsukaL = Lb * 0.34;                            // 柄长（真实 0.37L）
  const tsukaHW = Math.max(0.75, Lb * 0.052);          // 柄半宽
  const tsubaT = Math.max(0.5, Lb * 0.020);            // 镡的厚度（沿刀身方向）
  const tsubaR = Math.max(1.4, Lb * 0.105);            // 镡的竖直半径（直径 0.21L）
  const habakiL = Math.max(1.2, Lb * 0.07);            // 鎺长度
  const lw = Math.max(0.45, k * 0.75);                 // 主描边

  ctx.save();
  ctx.translate(hand.x, hand.y);
  ctx.rotate(angle);
  // facing 左右翻转时把局部 y 也翻一下：保证刀背永远朝屏幕上方鼓，
  // 不然人物一转身，刀就朝下弯，看着像香蕉。
  if (facing < 0) ctx.scale(1, -1);
  ctx.globalAlpha *= alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  /** 中线：与 bladeCenterline 同一条方程 */
  const cy = (t: number) => -bow * Math.pow(t, KATANA_BOW_POW);

  const N = 14;
  const edge: KPt[] = [];
  const spine: KPt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const hw = halfWidth(t, hw0);
    edge.push({ x: Lb * t, y: cy(t) - hw });
    spine.push({ x: Lb * t, y: cy(t) + hw });
  }

  // ── 柄（tsuka）：深色握柄 + 菱形缠绳（糸巻き）+ 柄头（kashira）──
  ctx.beginPath();
  ctx.moveTo(-tsukaL, -tsukaHW * 0.92);
  ctx.lineTo(-tsubaT * 0.6, -tsukaHW);
  ctx.lineTo(-tsubaT * 0.6, tsukaHW);
  ctx.lineTo(-tsukaL, tsukaHW * 0.92);
  ctx.closePath();
  ctx.fillStyle = '#232931';
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = lw;
  ctx.stroke();
  // 菱形缠绳：每格两道交叉线
  ctx.strokeStyle = 'rgba(201,162,39,0.75)';
  ctx.lineWidth = lw * 0.75;
  const wraps = 3;
  for (let i = 0; i < wraps; i++) {
    const x0 = -tsukaL + (tsukaL * (i + 0.15)) / wraps;
    const x1 = -tsukaL + (tsukaL * (i + 0.85)) / wraps;
    ctx.beginPath();
    ctx.moveTo(x0, -tsukaHW * 0.8);
    ctx.lineTo(x1, tsukaHW * 0.8);
    ctx.moveTo(x0, tsukaHW * 0.8);
    ctx.lineTo(x1, -tsukaHW * 0.8);
    ctx.stroke();
  }
  // 柄头（kashira）
  ctx.fillStyle = '#C9A227';
  ctx.beginPath();
  ctx.ellipse(-tsukaL, 0, Math.max(0.6, tsukaHW * 0.35), tsukaHW * 0.95, 0, 0, Math.PI * 2);
  ctx.fill();

  // ── 鎺（habaki）：镡前那段金色刀箍，把「柄」和「刃」分开 ──
  ctx.beginPath();
  ctx.moveTo(tsubaT * 0.6, -hw0 * 1.15);
  ctx.lineTo(tsubaT * 0.6 + habakiL, -hw0 * 0.95);
  ctx.lineTo(tsubaT * 0.6 + habakiL, hw0 * 0.95);
  ctx.lineTo(tsubaT * 0.6, hw0 * 1.15);
  ctx.closePath();
  ctx.fillStyle = '#C9A227';
  ctx.fill();

  // ── 镡（tsuba）：椭圆护手（竖直半径 ≈ 刀身宽的 1.2 倍）──
  ctx.beginPath();
  ctx.ellipse(0, 0, tsubaT, tsubaR, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#2A2F36';
  ctx.fill();
  ctx.strokeStyle = '#C9A227';
  ctx.lineWidth = Math.max(0.5, lw * 0.8);
  ctx.stroke();

  // ── 刀身：刃口曲线 + 刀背曲线围成的弧形刀体 ──
  ctx.beginPath();
  ctx.moveTo(edge[0].x, edge[0].y);
  for (let i = 1; i <= N; i++) ctx.lineTo(edge[i].x, edge[i].y);
  for (let i = N; i >= 0; i--) ctx.lineTo(spine[i].x, spine[i].y);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, -hw0 * 2, 0, hw0 * 2);
  grad.addColorStop(0, '#FBFDFF');   // 刃口：亮
  grad.addColorStop(0.45, '#D6E2EF');
  grad.addColorStop(1, '#7E8B9A');   // 刀背：暗
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = lw * 0.85;
  ctx.stroke();

  // ── 刀背（mune）：一条暗线，让「有厚度」读得出来 ──
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = cy(t) + halfWidth(t, hw0) * 0.5;
    const x = Lb * t;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(66,80,96,0.75)';
  ctx.lineWidth = lw * 0.7;
  ctx.stroke();

  // ── 刃纹（hamon）：贴着刃口内侧的一条波纹 ──
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const hw = halfWidth(t, hw0);
    const y = cy(t) - hw * 0.38 + Math.sin(t * Math.PI * 5) * hw * 0.16;
    const x = Lb * t;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = lw * 0.55;
  ctx.stroke();

  // ── 刀尖（kissaki）一点高光 ──
  ctx.beginPath();
  ctx.arc(Lb * 0.975, cy(0.975) - halfWidth(0.975, hw0) * 0.35, Math.max(0.6, hw0 * 0.34), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();

  ctx.restore();
};
