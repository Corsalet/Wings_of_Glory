// Зеркало игровых данных клиента (wings_of_glory.html) для серверной симуляции.
// ВАЖНО: числа синхронизированы с PLANES/MM_POOL/terrainHeight в клиенте — менять парно!
import { Vector3, Quaternion, MathUtils } from 'three';

export const V3 = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
export const clamp = MathUtils.clamp;
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const FWD = V3(0, 0, -1);
export const AX = V3(1, 0, 0), AY = V3(0, 1, 0), AZ = V3(0, 0, 1);

export interface PlaneDef {
  id: string; name: string; tier: number; cost: number; hp: number;
  maxSpd: number; minSpd: number; turn: number; climb: number;
  guns: string; dmg: number; mono: boolean; jet?: boolean; msl?: number;
  kph?: number; prem?: boolean;
}

// ТТХ самолётов (без строк-описаний — серверу не нужны)
export const PLANES: PlaneDef[] = [
  { id: 'po2',   name: 'По-2',        tier: 1,  cost: 0,     hp: 70,  maxSpd: 46,  minSpd: 20, turn: 1.30, climb: 30, guns: '', dmg: 6,  mono: false },
  { id: 'i153',  name: 'И-153 Чайка', tier: 1,  cost: 700,   hp: 80,  maxSpd: 54,  minSpd: 22, turn: 1.38, climb: 26, guns: '', dmg: 7,  mono: false },
  { id: 'i16',   name: 'И-16 тип 10', tier: 2,  cost: 2200,  hp: 95,  maxSpd: 63,  minSpd: 25, turn: 1.15, climb: 24, guns: '', dmg: 9,  mono: true },
  { id: 'lagg3', name: 'ЛаГГ-3',      tier: 2,  cost: 3600,  hp: 105, maxSpd: 67,  minSpd: 26, turn: 1.00, climb: 22, guns: '', dmg: 11, mono: true },
  { id: 'yak1',  name: 'Як-1',        tier: 3,  cost: 6500,  hp: 100, maxSpd: 71,  minSpd: 26, turn: 1.10, climb: 20, guns: '', dmg: 12, mono: true },
  { id: 'mig3',  name: 'МиГ-3',       tier: 3,  cost: 8000,  hp: 95,  maxSpd: 78,  minSpd: 28, turn: 0.90, climb: 21, guns: '', dmg: 10, mono: true },
  { id: 'la5',   name: 'Ла-5',        tier: 4,  cost: 13000, hp: 115, maxSpd: 79,  minSpd: 27, turn: 1.05, climb: 19, guns: '', dmg: 14, mono: true },
  { id: 'yak9',  name: 'Як-9',        tier: 4,  cost: 15000, hp: 110, maxSpd: 81,  minSpd: 27, turn: 1.08, climb: 19, guns: '', dmg: 13, mono: true },
  { id: 'yak3',  name: 'Як-3',        tier: 5,  cost: 24000, hp: 105, maxSpd: 83,  minSpd: 26, turn: 1.15, climb: 17, guns: '', dmg: 13, mono: true },
  { id: 'la7',   name: 'Ла-7',        tier: 5,  cost: 30000, hp: 120, maxSpd: 86,  minSpd: 28, turn: 1.10, climb: 17, guns: '', dmg: 15, mono: true },
  { id: 'mig9',  name: 'МиГ-9',       tier: 6,  cost: 45000,  hp: 110, maxSpd: 90,  minSpd: 30, turn: 1.02, climb: 16, guns: '', dmg: 12, mono: true, jet: true, msl: 0, kph: 910 },
  { id: 'mig15', name: 'МиГ-15бис',   tier: 7,  cost: 62000,  hp: 115, maxSpd: 96,  minSpd: 32, turn: 1.00, climb: 15, guns: '', dmg: 14, mono: true, jet: true, msl: 0, kph: 1076 },
  { id: 'mig21', name: 'МиГ-21бис',   tier: 8,  cost: 85000,  hp: 110, maxSpd: 104, minSpd: 34, turn: 0.96, climb: 13, guns: '', dmg: 15, mono: true, jet: true, msl: 2, kph: 2230 },
  { id: 'mig29', name: 'МиГ-29',      tier: 9,  cost: 115000, hp: 125, maxSpd: 112, minSpd: 36, turn: 0.98, climb: 12, guns: '', dmg: 17, mono: true, jet: true, msl: 4, kph: 2450 },
  { id: 'su35',  name: 'Су-35С',      tier: 10, cost: 150000, hp: 140, maxSpd: 118, minSpd: 36, turn: 1.02, climb: 11, guns: '', dmg: 18, mono: true, jet: true, msl: 6, kph: 2520 },
  { id: 'su57',  name: 'Су-57',       tier: 11, cost: 0,      hp: 150, maxSpd: 124, minSpd: 36, turn: 1.06, climb: 10, guns: '', dmg: 20, mono: true, jet: true, msl: 8, kph: 2600, prem: true }
];

// Матчмейкинг рангов ботов (как в клиенте)
export const MM_POOL: Record<number, [number, number][]> = {
  1: [[1, .5], [2, .3], [3, .2]], 2: [[2, .45], [3, .35], [4, .2]], 3: [[3, .4], [4, .35], [5, .25]],
  4: [[3, .25], [4, .4], [5, .35]], 5: [[4, .45], [5, .55]], 6: [[5, .35], [6, .45], [7, .2]],
  7: [[6, .3], [7, .45], [8, .25]], 8: [[7, .3], [8, .4], [9, .3]], 9: [[8, .25], [9, .4], [10, .35]],
  10: [[9, .45], [10, .55]], 11: [[10, .4], [11, .6]]
};
export function rollBotTier(T: number): number {
  let r = Math.random();
  for (const [t, w] of (MM_POOL[T] || [[T, 1]])) { r -= w; if (r <= 0) return t; }
  return T;
}

// Улучшения: eng +4% скорости, dur +8 HP, hdl +6% манёвренности, gun +8% урона (как planeStats клиента)
export interface Upg { eng: number; dur: number; hdl: number; gun: number }
export function planeStatsHuman(pl: PlaneDef, u: Upg) {
  return {
    id: pl.id, name: pl.name, tier: pl.tier, mono: pl.mono, jet: !!pl.jet, msl: pl.msl || 0, prem: !!pl.prem,
    maxSpd: pl.maxSpd * (1 + (u.eng || 0) * 0.04),
    minSpd: pl.minSpd,
    hp: Math.round(pl.hp + (u.dur || 0) * 8),
    turn: pl.turn * (1 + (u.hdl || 0) * 0.06),
    climb: pl.climb,
    dmg: pl.dmg * (1 + (u.gun || 0) * 0.08)
  };
}
// боты: 35% HP (как planeStatsBot)
export function planeStatsBot(pl: PlaneDef) {
  return {
    id: pl.id, name: pl.name, tier: pl.tier, mono: pl.mono, jet: !!pl.jet, msl: pl.msl || 0, prem: !!pl.prem,
    maxSpd: pl.maxSpd, minSpd: pl.minSpd, turn: pl.turn, climb: pl.climb, dmg: pl.dmg,
    hp: Math.round(pl.hp * 0.35)
  };
}

// Детерминированный рельеф — ТОЧНАЯ копия terrainHeight клиента
export function terrainHeight(x: number, z: number): number {
  let h = Math.sin(x * 0.00075 + 0.4) * Math.cos(z * 0.00062 - 0.3) * 300
    + Math.sin(x * 0.0019 + 1.7) * Math.cos(z * 0.0016 + 2.4) * 140
    + Math.sin(x * 0.0052 + 0.9) * Math.sin(z * 0.0047 + 1.2) * 55;
  const r = Math.max(0, 1 - Math.abs(Math.sin(x * 0.0004 + 1.0) * Math.cos(z * 0.0005 - 0.6)) * 2.2);
  h += r * r * 280;
  const d = Math.sqrt(x * x + z * z);
  const flat = Math.max(0, 1 - d / 1300);
  h = h * (1 - flat * 0.82) + 8 * flat;
  return h;
}

export const BOT_NAMES = ['Барон', 'Факел', 'Гриф', 'Ворон', 'Шторм'];
export const ALLY_NAMES = ['Сокол', 'Стрела', 'Клим', 'Тайфун'];
export const PREM_CODE = 'meosan';

// награды (как payReward/applyRewards клиента)
export const PAY = { kill: [120, 70], teamKill: [40, 24], part: [200, 120], win: [600, 350] };
