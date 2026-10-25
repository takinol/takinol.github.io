# AI 出招决策：架构问题清单与需求

> 本文只做**诊断 + 需求**，不含实现。目的：把"小人为什么会乱出招 / 不会看情况"翻译成可验收的架构缺口。
> 证据全部带文件行号，可直接核对。

---

## 0. 一句话结论

现在的 AI 是「**每 0.14~0.24 秒掷一次骰子 + 一塔硬编码乘子**」。

它没有记忆、没有计划、没有"这局我想赢什么"的目标，也没有"这一招来不来得及"的时间预算。
所以它**能打，但不会打**：不会试探、不会骗、不会惩罚、不会因为领先而收手。

缺的不是更多分支，而是三个整层缺席：

| 缺席的层 | 现在由什么代替 | 后果 |
|---|---|---|
| **局面评估**（现在值多少、该抢还是该守） | 散落的 `if (f.hp < 30)` 之类 | 残血和满血用同一套判断 |
| **计划**（接下来 1~2 步要做什么） | 每 0.2 秒重新掷骰 | 无法表达"先刺拳试探→看他反应→再决定" |
| **时间预算**（这招在对手恢复前能不能落地） | 完全没有（`hitstun` 这个词在代码里 **0 处**） | 打康/连招经常"算得出来但来不及" |

---

## 1. 现状（证据）

```
decide()  @fight.ts:4402      ← 唯一入口
 ├ 手动模式 / 外部控制器
 └ heuristic()  @4215          ← 约 185 行的 if 链（十几条 return）
     └ pickAttack()  @4147     ← 15 条 `w *=` 乘子 + 加权抽签
applyPhase()  @4365            ← 战斗阶段（probing/engagement/reset）调制决策
pickComboEdge() @3950          ← 连招图：confirm + window + range 过滤 → 按 weight 抽签
snapshot()    @4070            ← 带感知延迟 perceiveLag
```

| 事实 | 位置 | 数字 |
|---|---|---|
| 决策节拍 | `fight.ts:5728` | `gap = idle ? 0.14 : 0.24` 秒（≈8.4 / 14.4 帧） |
| 招式选择的乘子 | `pickAttack()` `4147–4213` | **15 条 `w *=`**，量纲从"伤害的倒数"到"性格修正"混乘 |
| 感知延迟 | `Fighter.perceiveLag = rand(0.06, 0.2)` @2927 | 但 `heuristic()` 内 **2 处**直接读 `fighters[...]`，绕过延迟 |
| 连招选择 | `pickComboEdge()` @3950 | 过滤后**只按 weight 抽**，无收益/风险模型 |
| 空间四段 | `f.spatial`（out/edge/in/close） | 只是标签；选招仍用 `reachOf(k) + 12 / + 30` 的临时阈值 |
| 硬直预算 | —— | **不存在**：`grep hitstun` = 0 |
| 对手画像 | `f.readsLow / readsHigh` | 只有 2 个计数器，且只记"他蹲防还是站防" |

---

## 2. 问题清单

### 🔴 P0-1 决策只有"单帧反射"，没有"计划"

**现象**：AI 每一拍都在重新回答"我现在该干嘛"，上一拍的意图不会带到下一拍。所以它永远在**反应**，从不**设计**。

**证据**：`decide()` @4402 每次被调用都从零跑一遍 `heuristic()`；唯一的"记忆"是 `intentLock / cool / comboTimer / disengage` 几个冷却计时器（@5728 附近），没有任何"意图对象"。

**为什么是架构问题**：
- 试探（抛一招看他怎么防）本质是**两步**：出招 → 观察 → 决策。单帧反射结构上表达不了第二步。
- 骗招（假动作诱他出招再惩罚）本质是**三步**。
- 现在要实现"两步"，只能靠在 `heuristic()` 里加特判（比如 `f.feintT`），每加一种战术就多一条 if —— 这就是为什么那 185 行会继续膨胀。

**需求 R-1**：
1. 引入 `Intent`（意图）对象，生命周期 ≫ 一拍：
   ```ts
   type Intent =
     | { kind: 'probe'; poke: string; watch: 'guardHeight' | 'counter' | 'whiff'; ttl: number }
     | { kind: 'bait'; feint: string; punishWith: string; ttl: number }
     | { kind: 'pressure'; chain: string[]; ttl: number }
     | { kind: 'whiffPunish'; with: string; ttl: number }
     | { kind: 'reset'; ttl: number };
   ```
2. `Fighter` 增加 `intent: Intent | null`；`decide()` 先"续行当前 intent"，只有 intent 为空或失效才重新规划。
3. `probe` 出招后，把**对手的应对**写进 `f.observed`（防高/防低/反击/后撤/不动），供下一次规划用。

**验收标准**：
- 能观察到"试探→观察→调整"的行为序列：同一个 AI 在连续 3 次试探中，第 2 次会针对第 1 次看到的防御高度换段位（现在也有靠 reads，但那是乘子，不是意图）；
- `heuristic()` 的 if 分支数**不增加**（新战术走 intent，不走进 if 链）。

---

### 🔴 P0-2 没有"时间预算"，帧级可行性无判定

**现象**：AI 会做"数学上成立、时间上不可能"的决定——例如打康后接一个大招，但自己的起手帧数 > 对手剩余硬直，结果挥空被反打。

**证据**：全代码 **没有 `hitstun` 概念**（`grep hitstun` = 0 处）。受击硬直是隐式的：`opp.stun = 0.2~0.5 + 惩罚`（命中结算里），而 `pickComboEdge()` 只过滤 `confirm / window / range / atkOf`，**不看 `opp.stun` 剩余**。

**为什么是架构问题**：这是"能不能打中"的第二类前提。距离够了不等于能打中——**时间也要够**。没有这一层，任何连招/打康的收益都是假的。

**需求 R-2**：
1. 招式数据补两个派生量（不必手填，可从 `MOVE_META` 与 clip 推）：
   ```ts
   interface MoveTiming {
     startup: number;   // 秒：起手到第一个 active
     activeTo: number;  // 秒：判定窗结束
     recovery: number;  // 秒
   }
   ```
2. 新增纯函数（不碰引擎主链路）：
   ```ts
   canLandBefore(move: string, hitFrameProg: number, targetStunLeft: number): boolean
   // worldTime(move, hitFrameProg) <= targetStunLeft
   ```
3. 所有"接下一招"的地方（连招图、打康、追击）**先过这一关**，不过就不接，并且**允许主动放弃**（返回 `null` = 不打，而不是硬打）。

**验收标准**：
- 加一条日志：每次决定接招时打印 `need=xx ms / have=yy ms`；
- 跑 60 秒对打，**"接招后挥空"的比例从当前值降到 < 5%**（当前没有统计，需要先埋点，见 P2-2）。

---

### 🔴 P0-3 效用函数是一塔乘法，权重不可比、不可解释、不可调

**现象**：`pickAttack()` 里 15 条 `w *=` 连乘。伤害的倒数和性格修正、破防特性、局面加成分混在一起乘，没有任何归一化。

**证据**：`pickAttack()` `4147–4213`，例如：
```ts
let w = Math.max(0.3, 24 / power) * (a.hits.length > 1 ? 0.75 : 1);
if (spec.moves.includes(k)) w *= 1.9;
if (oppBlock) w *= meta?.breakGuard ? 2.0 : 0.5;
if (opp && opp.guard < 58 && meta?.breakGuard) w *= 2.6;
...
```
乘子是**相对**的：`1.9 × 2.6 = 4.94` 和 `2.0 × 2.5 = 5.0` 在语义上完全不同，但数值上等价。想调"该不该破防"必须重新校准整塔。

**为什么是架构问题**：这是典型的"加一个因素加一行"结构，最终没人能预测改动的影响。而且它把**不同性质的东西**混在一个标量里：伤害（收益）、命中率（概率）、风险（挥空惩罚）、风格（性格）。四者相乘 → 无法单独优化任何一项。

**需求 R-3**：
1. 把"选招"拆成**四个可分别评估的项**：
   ```ts
   interface MoveScore {
     reward: number;   // 期望伤害（含破防/打康倍率）
     risk: number;     // 挥空惩罚（recovery 时长 × 被抓概率）
     hitChance: number; // 0~1：距离/段位/对手防御状态 → 命中概率
     style: number;    // 0~1：角色性格亲和度（不是乘子，是加权）
   }
   score = style * (hitChance * reward - (1 - hitChance) * risk);
   ```
2. 每个项**单独定义、单独测试、单独调**；`style` 只做线性加权，不参与乘。
3. 保留一张"为什么选它"的诊断表（见 P2-2）。

**验收标准**：
- 能回答"为什么这一拍选了直拳而不是袈裟斩"，答案是一个四元组而不是"因为随机数落在这一格"；
- 调 `style` 不会改变 `reward/risk` 的排序（正交性）。

---

### 🔴 P0-4 感知双轨：AI 事实上是全知的

**现象**：`snapshot()` 故意加了 `perceiveLag`（0.06~0.2 秒）让 AI"看到的是过去"，但 `heuristic()` 里仍然有 2 处直接读 `fighters[...]`（绕过 snapshot），于是延迟对这几条判断形同虚设。

**证据**：
- `snapshot()` @4070 计算 `prog - lag/clipDur`；
- `heuristic()` @4215–4400 内 `fighters[` 出现 **2 次**；
- 另有 `f.counterT / f.parryT / opp.stun` 等字段只在真身上有，snapshot 里没有。

**为什么是架构问题**：AI 的能力上限应该由**感知**决定。现在一部分信息走延迟快照、一部分走真身直读，等于"想让它更笨的时候改不动，想让它更强的时候又到处都是捷径"。而且调试时无法复现"它当时到底看到了什么"。

**需求 R-4**：
1. `snapshot()` 扩展为**唯一信息源**，补齐 AI 需要的字段：`opp.state/prog/stunLeft/guardLow/hp/guard/spatial/landedHit`、`self.spatial/cool/...`；
2. `heuristic()` 内禁止出现 `fighters[`（可以加一条 lint / 运行时断言：`if (opts.debugAI) throw ...`）；
3. 给 AI 加一个可配的 `perceiveLag` 与"反应时间"（下一拍最早什么时候能响应）。

**验收标准**：
- `grep "fighters\[" heuristic 区间` == 0；
- 把 `perceiveLag` 调到 0.35s，AI 明显变笨（能打赢简单脚本）；调到 0 明显变强 —— 说明感知真的在起作用。

---

### 🟠 P1-1 空间状态是"标签"，不是"招式窗口"

**现象**：`f.spatial` 四段（out / edge / in / close）已经算出来了，但选招时仍然用 `d <= reachOf(k) + (a.forward ? 30 : 12)` 这种临时阈值。

**证据**：`pickAttack()` `inRange()` @4148–4154；`f.spatial` 只在 `applyPhase()` 与连招图 `range` 条件里被读。

**为什么是架构问题**：`edge`（边缘）本来是**最有博弈价值**的距离——能打到但不实在。现在它和 `in` 的选招逻辑没有区别，所以 AI 永远学不会"站在边缘游走、诱他挥空"。

**需求 R-5**：
1. 用**真实标定**给每招算出一个距离窗口，成为数据：
   ```ts
   interface MoveWindow { minGap: number; maxGap: number; bestGap: number }
   // 由 reachOf + 位移 + 对手体型推出，而不是手填
   ```
2. `pickAttack` 改成按窗口打分：`gap` 落在 `[min,max]` 才可选，越接近 `bestGap` 命中率越高（融进 P0-3 的 `hitChance`）。
3. `edge` 距离额外给"诱招"行为开权限（见 R-1 的 `bait`）。

**验收标准**：`edge` 与 `in` 两段的选招分布**显著不同**（例如 edge 以中距招+突进为主，in 以贴身连段为主），且能观察到"退到 edge 再进"的节奏。

---

### 🟠 P1-2 连招只按权重抽，没有收益/风险

**现象**：`pickComboEdge()` 过滤出候选后 `w = (e.weight ?? 1) * bias`，然后抽签。**赌拔刀斩**（打空 = 大硬直）和**接轻连**（稳）在结构上是同一类选项，只是权重不同。

**证据**：`pickComboEdge()` @3950 末尾的加权抽签；`ComboEdge` 只有 `weight`，没有 `expected`（期望值）。

**为什么是架构问题**：格斗的连招选择本质是**风险决策**。"确认了要不要贪"是这个游戏最有意思的决策点，现在被一个常数 `weight` 抹平了。

**需求 R-6**：`ComboEdge` 增加三个字段，决定"贪不贪"：
```ts
{ onWhiff: 'punished' | 'safe';   // 打空后果
  payoff: number;                 // 命中收益（伤害/位置/倒地）
  conviction: number; }           // 需要的确认强度（0~1，counter 才够 → 1）
```
选择规则：`payoff × P(hit) - (1-P(hit)) × riskOf(onWhiff) > 阈值`，阈值由**局面评估**（P1-3）给。

**验收标准**：同一局面下，AI 在"领先且对手硬直刚好够"时选重招、在"血少/硬直不够"时选轻连 —— 行为能随局面变化，而不是固定权重。

---

### 🟠 P1-3 防御与进攻分离，没有统一的"这次交锋目标"

**现象**：`heuristic()` 里 block / parry / crouch / approach 各自独立判断；`parryLoveOf()` 是性格常数，不看"这一下的收益"。

**证据**：`parry` 触发在 `4215–4400` 内的一个 if（`oStarting && d < 46 && random() < parryLoveOf(f)`）；`guardLow` 由 `lastSeenHeight` 猜。

**为什么是架构问题**：招架是**赌**。赌的期望值取决于"对手这一招多重 / 我赌错要吃什么"。现在的实现是"性格爱赌就赌"，而不是"这一下值不值得赌"。

**需求 R-7**：
1. 引入 `ExchangeGoal`（这次交锋我要什么）：`{ kind: 'poke' | 'win' | 'reset' | 'baitCounter'; budget: number }`；
2. 防御决策变成"为达成 goal 服务"：goal=win 时更爱赌招架，goal=reset 时优先退；
3. `parryLoveOf` 从常数变成 `parryEV = P(对手真出招) × 招架收益 − (1−P) × failRecovery 代价`。

**验收标准**：AI 在残血时明显更保守（招架率下降、后退率上升）；在领先时更爱赌。

---

### 🟠 P1-4 对手画像只有两个计数器

**现象**：只有 `readsLow / readsHigh`（防高/防低），且只在**被挡下**时更新。

**证据**：`Fighter.readsLow/readsHigh`；更新点在命中结算的 `guarding` 分支；`pickAttack` 里 `lowBias` 用法。

**为什么是架构问题**：这叫"统计"不叫"画像"。看不出"他爱抢招 / 爱跳 / 爱后撤 / 一被打就抢"这类**可以针对**的习惯。

**需求 R-8**：
```ts
interface OpponentModel {
  guardLowRate: number;     // 已有
  counterAfterBlockRate: number; // 被挡后多久内反击
  whiffRecoveryRate: number;     // 挥空后不后撤的比例
  jumpOutRate: number;           // 被压时跳走的比例
  panic: number;                 // 血少时乱按的程度
}
```
用**滑动窗口 + 衰减**维护，作为 `Intent` 规划的输入（不是乘子）。

**验收标准**：能打印"当前对手画像"，且 AI 在对手 `counterAfterBlockRate` 高时**主动留反击陷阱**（打完停半拍 → 招架）。

---

### 🟡 P2-1 难度/风格没有统一入口

`aggression` / `guardChance` 通过 `opts.params` 注入，但在 15 条乘子、`applyPhase`、`parryLoveOf` 里各有一份解释。想加"难度"要改多处。

**需求 R-9**：抽一个 `AIPersonality` 结构（反应时间、冒险倾向、连招贪婪度、防御偏好），只在一处定义，全部下游从它取值。

---

### 🟡 P2-2 决策不可解释

现在无法回答"它为什么出这招"。调参只能靠感觉。

**需求 R-10**：每拍记录一条决策日志（环形缓冲，最多 300 条）：
```ts
{ t, cands: [{move, hitChance, reward, risk, score, dropped?}], picked, intent }
```
在 `?debug=frames` 下画成文字面板（或 `console.table`）。**这也是 P0-2/P0-3 的验收工具**——没有它，前面那些"验收标准"根本没法量。

---

### 🟡 P2-3 没有"领先/落后"的收益模型

AI 不看血量差、不看时间，所以节奏永远是同一个强度。

**需求 R-11**：`evaluatePosition()` 返回 `-1..+1`（血量差 + 距离优势 + 架势差 + 时间），作为所有"冒险决策"的阈值来源。

---

## 3. 建议的执行顺序（不要一次全做）

| 阶段 | 做什么 | 为什么先做它 |
|---|---|---|
| **A** | R-10（决策日志）→ R-2（时间预算） | 先有观测手段，再谈优化。没有日志，后面每一刀都是盲改 |
| **B** | R-3（四元组评分）+ R-5（招式窗口） | 这两条决定"选招"的质量，是 AI 的地基 |
| **C** | R-1（Intent）+ R-4（单一信息源） | 有了评分才能规划；有了 plan 才谈得上试探/骗 |
| **D** | R-6 / R-7（风险决策）+ R-8（对手画像） | 这些是"博弈深度"，建立在 A~C 之上 |
| **E** | R-9 / R-11（性格/局面）+ 其余 14 人迁移 | 最后做风格化 |

---

## 4. 这次不做什么（边界）

- **不动**判定几何、位移、渲染、音效链路 —— 它们已经稳定，AI 只从 `snapshot()` 读。
- **不引入**机器学习 / 神经网络。全部是规则 + 数值，保证可解释、可复现。
- **不一次铺 15 个英雄**。先在剑客身上跑通，再横向铺。
- **不追求"打赢人"**。目标是"看起来会思考"：会试探、会骗、会惩罚、会收手。

---

## 5. 一句话验收（整个改造的 Definition of Done）

> 关掉调试面板，看两个 AI 打 60 秒：
> **能看出"他在试探、他在等他出手、他抓到了、他贪了/他没贪"这四种意图**，
> 并且每一条意图都能在决策日志里找到对应的四元组与时间预算。

---

# 附录：落地状态（本次重构后）

## 已实现

| 需求 | 落地位置 | 说明 |
|---|---|---|
| **R-1 Intent** | `planIntent()` / `runIntent()` / `Fighter.intent` | 意图有 `until` 生命周期；`mustReact()` 允许"看到破绽/被起手"时**秒切** |
| **R-2 时间预算** | `timingOf()` / `canLandBefore()` | 从 clip 与 hits 推出 startup/activeTo/recovery；连招图的每条边先过它 |
| **R-3 四元组评分** | `evalMove()` | `score = style × (命中率×收益 − (1−命中率)×风险×风险倾向)`，取代 15 条 `w *=` |
| **R-4 感知统一** | `FightSnapshot` 扩展 | 补齐 `stunLeft / prog / landedHit / guardLow / attacking / self.cool ...`；AI 不再摸 `fighters[]` |
| **R-5 招式窗口** | `windowOf()` | `maxGap = reach + 前冲`，`bestGap = maxGap - 8`；偏离越远命中率越低，边缘再打一次折 |
| **R-6 连招风险** | `pickComboEdge()` | 三道闸门：时间预算 → 确认强度（conviction）→ 落后不许赌；最后按期望值加权 |
| **R-7 交锋目标** | `planIntent()` | 局面分 <−0.28 → reset；>+0.32 → pressure；中间 → probe/bait |
| **R-8 对手画像** | `Fighter.oppModel` / `oppRates()` / `noteOpp()` | 记 蹲/站防比例、**挡完我是否立刻抢**（计数器）、挥空率；滑动计数超 30 对折 |
| **R-9 性格集中** | `personalityOf()` | risk/greed/guard/parry 四项，按流派 archetype 给值；下游只读，不再散落乘子 |
| **R-10 决策日志** | `aiLog` + `window.takinolFight.aiLog()` | 每次决策记录 意图/局面分/前 3 名候选（分数+命中率）/最终选择 |
| **R-11 局面分** | `evaluatePosition()` | 血量差 0.72 + 架势差 0.2 + 间距 0.08，归一化到 −1..+1 |

旧的 `pickAttack` / `heuristic` / `applyPhase`（185 行 if 链 + 15 条乘子）已删除。

## 验证方式（新增：无头冒烟）

`src/scripts` 是纯 TS，可用最小 DOM 桩在 Node 里跑引擎（不需要浏览器）：

```js
// 桩：document.getElementById → 假 canvas；requestAnimationFrame → 手动推帧
const api = mod.initFightBand({ canvasId:'c', matchup:{left:0,right:4}, forceVisible:true,
                                endless:false, debugOptions:{frames:true} });
for (let i=0;i<1800;i++){ t+=16.7; const cb=pending; pending=null; cb(t); }
// 断言：无异常、无 console.error、血量会掉、状态种类 > 10、aiLog 有记录
```

实测（1800 帧 ≈ 30 秒，剑客 vs 双刃影客）：
```
异常: 无   引擎上报错误: 0   警告: 0
血量: 100/100 → 0/30（双方都掉血）
状态种类: 15（approach/idle/hurtHeavy/down/getup/stumble/slash/counterStrike/elbow/knee/sideKick/block…）
决策日志: 61 条，形如
  {who:0, gap:27.7, pos:0.22, intent:"pressure/thrown", picked:"sideKick",
   top:[{iai s=20 hc=.83},{sideKick s=16.9 hc=.98},{counterStrike s=16.5 hc=.98}]}
```

## 已知的、留给你决定的问题（不是架构缺陷，是调参）

1. **一边倒**：剑客（punisher）对影客（rusher）时，前者靠击倒型招式（sideKick knock 430 → 必定 knockdown）形成"打倒→起身→再打倒"的循环，后者长期处于 down/getup。这是**击倒阈值**与 **knockdown 后保护**的问题，不是决策层问题。
2. **中立时间偏多**：`idle + approach + retreat` 约占 55%~63% 的帧。说明"进入射程"这一步花得太久 —— 可以给 `probe` 加"两步内必须进 edge"的约束，或调 `preferDist`。
3. **招式集中度**：前 3 名经常是同一批（iai / sideKick / counterStrike）。若想更花，可以在 `evalMove` 里加"最近用过"的边际递减（需要一个 `recentMoves` 环形缓冲）。
4. **`MOVE_META` 仍是一份独立手写表**（只有 7 条），未登记的招式在 `meta?.fast` 这类判断上退化。属于「两份清单」的遗留裂缝，建议后续统一从招式数据派生。

---

# 附录：落地状态（本次重构后）

## 已实现

| 需求 | 落地位置 | 说明 |
|---|---|---|
| **R-1 Intent** | `planIntent()` / `runIntent()` / `Fighter.intent` | 意图有 `until` 生命周期；`mustReact()` 允许"看到破绽/被起手"时**秒切** |
| **R-2 时间预算** | `timingOf()` / `canLandBefore()` | 从 clip 与 hits 推出 startup/activeTo/recovery；连招图的每条边先过它 |
| **R-3 四元组评分** | `evalMove()` | `score = style × (命中率×收益 − (1−命中率)×风险×风险倾向)`，取代 15 条 `w *=` |
| **R-4 感知统一** | `FightSnapshot` 扩展 | 补齐 `stunLeft / prog / landedHit / guardLow / attacking / self.cool ...`；AI 不再摸 `fighters[]` |
| **R-5 招式窗口** | `windowOf()` | `maxGap = reach + 前冲`，`bestGap = maxGap - 8`；偏离越远命中率越低，边缘再打一次折 |
| **R-6 连招风险** | `pickComboEdge()` | 三道闸门：时间预算 → 确认强度（conviction）→ 落后不许赌；最后按期望值加权 |
| **R-7 交锋目标** | `planIntent()` | 局面分 <−0.28 → reset；>+0.32 → pressure；中间 → probe/bait |
| **R-8 对手画像** | `Fighter.oppModel` / `oppRates()` / `noteOpp()` | 记 蹲/站防比例、**挡完我是否立刻抢**（计数器）、挥空率；滑动计数超 30 对折 |
| **R-9 性格集中** | `personalityOf()` | risk/greed/guard/parry 四项，按流派 archetype 给值；下游只读，不再散落乘子 |
| **R-10 决策日志** | `aiLog` + `window.takinolFight.aiLog()` | 每次决策记录 意图/局面分/前 3 名候选（分数+命中率）/最终选择 |
| **R-11 局面分** | `evaluatePosition()` | 血量差 0.72 + 架势差 0.2 + 间距 0.08，归一化到 −1..+1 |

旧的 `pickAttack` / `heuristic` / `applyPhase`（185 行 if 链 + 15 条乘子）已删除。

## 验证方式（新增：无头冒烟）

`src/scripts` 是纯 TS，可用最小 DOM 桩在 Node 里跑引擎（不需要浏览器）：

```js
// 桩：document.getElementById → 假 canvas；requestAnimationFrame → 手动推帧
const api = mod.initFightBand({ canvasId:'c', matchup:{left:0,right:4}, forceVisible:true,
                                endless:false, debugOptions:{frames:true} });
for (let i=0;i<1800;i++){ t+=16.7; const cb=pending; pending=null; cb(t); }
// 断言：无异常、无 console.error、血量会掉、状态种类 > 10、aiLog 有记录
```

实测（1800 帧 ≈ 30 秒，剑客 vs 双刃影客）：
```
异常: 无   引擎上报错误: 0   警告: 0
血量: 100/100 → 0/30（双方都掉血）
状态种类: 15（approach/idle/hurtHeavy/down/getup/stumble/slash/counterStrike/elbow/knee/sideKick/block…）
决策日志: 61 条，形如
  {who:0, gap:27.7, pos:0.22, intent:"pressure/thrown", picked:"sideKick",
   top:[{iai s=20 hc=.83},{sideKick s=16.9 hc=.98},{counterStrike s=16.5 hc=.98}]}
```

## 已知的、留给你决定的问题（不是架构缺陷，是调参）

1. **一边倒**：剑客（punisher）对影客（rusher）时，前者靠击倒型招式（sideKick knock 430 → 必定 knockdown）形成"打倒→起身→再打倒"的循环，后者长期处于 down/getup。这是**击倒阈值**与 **knockdown 后保护**的问题，不是决策层问题。
2. **中立时间偏多**：`idle + approach + retreat` 约占 55%~63% 的帧。说明"进入射程"这一步花得太久 —— 可以给 `probe` 加"两步内必须进 edge"的约束，或调 `preferDist`。
3. **招式集中度**：前 3 名经常是同一批（iai / sideKick / counterStrike）。若想更花，可以在 `evalMove` 里加"最近用过"的边际递减（需要一个 `recentMoves` 环形缓冲）。
4. **`MOVE_META` 仍是一份独立手写表**（只有 7 条），未登记的招式在 `meta?.fast` 这类判断上退化。属于「两份清单」的遗留裂缝，建议后续统一从招式数据派生。
