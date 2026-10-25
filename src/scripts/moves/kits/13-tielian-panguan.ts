/**
 * 铁链判官（build: flail）—— 本英雄专属招式库（完整副本，与其它英雄互不影响）
 *
 * 招式数：11　jab / cross / hook / uppercut / elbow / snapKick / pushKick / roundKick / sideKick / flyKick / flailSwing
 * 调参入口：直接改下面的数字即可。改这个文件不会影响任何其它英雄。
 */
import { P, type HeroKit } from '../types';

/** 架势（本英雄起手/收招的基准姿态） */
const GUARD = P({ lean: 0.05, armUB: 0.2, armLB: 0.35, armUF: -0.15, armLF: 0.3, legUB: -0.12, legUF: 0.12, legLF: 0.05 });
export const KIT: HeroKit = {
  id: 13,
  name: '铁链判官',
  build: 'flail',
  atks: {
    jab: {
      part: 'handF',
      hits: [
        { at: 0.48, dmg: [7, 12], reach: 1, knock: 150 },
      ],
      hitstop: 0.045,
      react: 'light',
    },
    cross: {
      part: 'handB',
      hits: [
        { at: 0.54, dmg: [12, 19], reach: 1.05, knock: 230 },
      ],
      hitstop: 0.06,
      react: 'heavy',
    },
    hook: {
      part: 'handF',
      hits: [
        { at: 0.54, dmg: [13, 20], reach: 1.02, knock: 210 },
      ],
      hitstop: 0.06,
      react: 'light',
    },
    uppercut: {
      part: 'handB',
      hits: [
        { at: 0.56, dmg: [16, 25], reach: 1, knock: 180 },
      ],
      hitstop: 0.075,
      react: 'up',
      forward: 55,
      close: true,
    },
    elbow: {
      part: 'elbowF',
      hits: [
        { at: 0.5, dmg: [14, 22], reach: 1.05, knock: 170 },
      ],
      hitstop: 0.07,
      react: 'heavy',
      forward: 85,
      close: true,
    },
    snapKick: {
      part: 'footF',
      hits: [
        { at: 0.5, dmg: [11, 18], reach: 1.2, knock: 260 },
      ],
      hitstop: 0.055,
      react: 'light',
    },
    pushKick: {
      part: 'footF',
      hits: [
        { at: 0.52, dmg: [14, 21], reach: 1.3, knock: 340 },
      ],
      hitstop: 0.065,
      react: 'heavy',
    },
    roundKick: {
      part: 'footF',
      hits: [
        { at: 0.54, dmg: [16, 24], reach: 1.3, knock: 300 },
      ],
      hitstop: 0.075,
      react: 'heavy',
    },
    sideKick: {
      part: 'footF',
      hits: [
        { at: 0.54, dmg: [18, 27], reach: 1.35, knock: 430 },
      ],
      hitstop: 0.08,
      react: 'heavy',
    },
    flyKick: {
      part: 'footF',
      hits: [
        { at: 0.48, dmg: [18, 27], reach: 1.3, knock: 380 },
      ],
      hitstop: 0.08,
      react: 'heavy',
      forward: 120,
      far: true,
    },
    flailSwing: {
      part: 'handF',
      hits: [
        { at: 0.58, dmg: [18, 28], reach: 1.5, knock: 350, tip: -1, w: 5, act: 0.2 },
      ],
      hitstop: 0.1,
      react: 'heavy',
    },
  },
  clips: {
    jab: {
      dur: 0.4, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.26, pose: P({ lean: 0.1, head: -0.06, armUB: 1.05, armLB: 2, armUF: 0.72, armLF: 2.15, legUB: -0.28, legUF: 0.32, legLF: 0.1 }) },
        { t: 0.48, pose: P({ lean: 0.3, head: -0.02, armUB: 0.9, armLB: 2.05, armUF: 1.62, legUB: -0.42, legUF: 0.5, legLF: 0.04 }) },
        { t: 0.62, pose: P({ lean: 0.3, head: -0.02, armUB: 0.9, armLB: 2.05, armUF: 1.62, legUB: -0.42, legUF: 0.5, legLF: 0.04 }) },
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
    flailSwing: {
      dur: 0.85, loop: false,
      keys: [
        { t: 0, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
        { t: 0.4, pose: P({ lean: -0.2, armUB: 2, armLB: 1.4, armUF: 1.2, armLF: 1.6, legUB: -0.35, legUF: 0.5, yaw: -0.3, armUBD: 0.5 }) },
        { t: 0.58, pose: P({ lean: 0.45, armUB: 0.3, armLB: 0.5, armUF: 1.8, armLF: 0.1, legUB: -0.65, legUF: 0.75, yaw: 0.25, armUBD: -0.4 }) },
        { t: 0.74, pose: P({ lean: 0.45, armUB: 0.3, armLB: 0.5, armUF: 1.8, armLF: 0.1, legUB: -0.65, legUF: 0.75, yaw: 0.25, armUBD: -0.4 }) },
        { t: 1, pose: P({ lean: 0.15, head: -0.06, armUB: 1, armLB: 1.9, armUF: 1.08, armLF: 1.85, legUB: -0.3, legUF: 0.34, legLF: 0.12 }) },
      ],
    },
  },
};
