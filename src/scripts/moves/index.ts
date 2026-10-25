/**
 * 15 个英雄的招式库总表。
 *
 * 结构：每个英雄一份「完整副本」（atks + clips），彼此不共享、互不影响。
 *   —— 调某个英雄的手感/数值，只改它自己那个文件（kits/NN-xxx.ts）。
 *
 * 同时导出「并集」ALL_ATKS / ALL_CLIPS：
 *   给演示页、数据校验、可视化等「与具体英雄无关」的工具用，
 *   也为战斗逻辑提供兜底（某个英雄没配的招式，工具仍能播放）。
 */
import type { Atk, Clip, HeroKit } from './types';
import { KIT as K00 } from './kits/00-jifeng-jianke';
import { KIT as K01 } from './kits/01-linying-youxia';
import { KIT as K02 } from './kits/02-tiebi-dunwei';
import { KIT as K03 } from './kits/03-qingmang-qiangbing';
import { KIT as K04 } from './kits/04-shuangren-yingke';
import { KIT as K05 } from './kits/05-fuchen-wuseng';
import { KIT as K06 } from './kits/06-rongyan-aijiang';
import { KIT as K07 } from './kits/07-xiaoshi-nushou';
import { KIT as K08 } from './kits/08-chiyan-wuren';
import { KIT as K09 } from './kits/09-anye-renzhe';
import { KIT as K10 } from './kits/10-zuibing-xian';
import { KIT as K11 } from './kits/11-xuefu-weijing';
import { KIT as K12 } from './kits/12-yuexia-wushi';
import { KIT as K13 } from './kits/13-tielian-panguan';
import { KIT as K14 } from './kits/14-chilun-jiguanshi';

/** 按 ROSTER 索引排列（0 = 疾风剑客 … 14 = 齿轮机关师） */
export const HERO_KITS: HeroKit[] = [K00, K01, K02, K03, K04, K05, K06, K07, K08, K09, K10, K11, K12, K13, K14];

/** 全部招式的并集（同名时取第一个英雄的版本，仅供工具/校验兜底） */
export const ALL_ATKS: Record<string, Atk> = {};
export const ALL_CLIPS: Record<string, Clip> = {};
for (const k of HERO_KITS) {
  for (const [move, atk] of Object.entries(k.atks)) if (!ALL_ATKS[move]) ALL_ATKS[move] = atk;
  for (const [move, clip] of Object.entries(k.clips)) if (!ALL_CLIPS[move]) ALL_CLIPS[move] = clip;
}

/** 招式并集的键（AI 兜底 / 演示列表用） */
export const ALL_ATK_KEYS = Object.keys(ALL_ATKS);
