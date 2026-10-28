// Профили игроков: SQLite с адаптивным драйвером — Bun.sqlite (под bun) или node:sqlite
// (process.getBuiltinModule, Node ≥ 22.3, без флага с 22.13). Один код — любой рантайм.
// Ник уникален (без учёта регистра) — дубликаты исключены на уровне БД и явной проверки.
import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import { PREM_CODE, PLANES } from './data';

// ── драйвер: createRequire вместо статических импортов, чтобы бандлер (Next/Turbopack)
//    не пытался резолвить 'bun:sqlite' на этапе сборки — резолвим в рантайме под тем движком,
//    который нас запустил (bun → bun:sqlite, Node ≥ 22.3 → node:sqlite).
import { createRequire } from 'module';
let _req: any = null;
function R(): any {
  if (_req) return _req;
  try { _req = createRequire(import.meta.url); } catch { }
  return _req;
}
function loadCtor(): any {
  const r = R();
  if (r) {
    try { const m = r('bun:sqlite'); if (m && m.Database) return m.Database; } catch { }
    try { const m = r('node:sqlite'); if (m && m.DatabaseSync) return m.DatabaseSync; } catch { }
  }
  const p: any = (globalThis as any).process;
  if (p && typeof p.getBuiltinModule === 'function') {
    try { const m = p.getBuiltinModule('node:sqlite'); if (m && m.DatabaseSync) return m.DatabaseSync; } catch { }
  }
  return null;
}

interface Stmt { get(...p: any[]): any; all(...p: any[]): any[]; run(...p: any[]): any }
interface Store { exec(sql: string): void; prepare(sql: string): Stmt }

let db: Store | null = null;
function D(): Store {
  if (db) return db;
  const Ctor = loadCtor();
  if (!Ctor) throw new Error('Нет SQLite-драйвера: нужен bun (Bun.sqlite) или Node ≥ 22.3 (node:sqlite)');
  const dir = process.env.WOG_DATA_DIR || join(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true }); // каталог БД может не существовать (Docker)
  const raw = new Ctor(join(dir, 'wog.db'));
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(`
CREATE TABLE IF NOT EXISTS players(
  nick     TEXT NOT NULL,
  nick_l   TEXT NOT NULL UNIQUE,
  pass     TEXT NOT NULL,
  money    INTEGER NOT NULL DEFAULT 1000,
  xp       INTEGER NOT NULL DEFAULT 0,
  owned    TEXT NOT NULL DEFAULT '["po2"]',
  sel      TEXT NOT NULL DEFAULT 'po2',
  upg      TEXT NOT NULL DEFAULT '{}',
  prem     INTEGER NOT NULL DEFAULT 0,
  kills    INTEGER NOT NULL DEFAULT 0,
  deaths   INTEGER NOT NULL DEFAULT 0,
  wins     INTEGER NOT NULL DEFAULT 0,
  rounds   INTEGER NOT NULL DEFAULT 0,
  created  INTEGER NOT NULL DEFAULT 0,
  lastseen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  nick_l TEXT NOT NULL,
  exp INTEGER NOT NULL
);`);
  db = { exec: (s: string) => raw.exec(s), prepare: (s: string) => raw.prepare(s) };
  return db;
}

// ── пароли: argon2id под bun, scrypt под node (форматы различимы по префиксу) ──
const BUN: any = (globalThis as any).Bun;
function hashPass(pass: string): string {
  if (BUN && BUN.password) return BUN.password.hashSync(pass, 'argon2id');
  const salt = randomUUID().replace(/-/g, '');
  return 's1$' + salt + '$' + scryptSync(pass, salt, 32).toString('hex');
}
function verifyPass(pass: string, hash: string): boolean {
  if (typeof hash !== 'string' || !hash) return false;
  if (hash.startsWith('$argon2')) return !!(BUN && BUN.password && BUN.password.verifySync(pass, hash));
  if (hash.startsWith('s1$')) {
    const parts = hash.split('$'); // ['s1', salt, hex]
    if (parts.length !== 3) return false;
    const calc = scryptSync(pass, parts[1], 32).toString('hex');
    return calc.length === parts[2].length && timingSafeEqual(Buffer.from(calc), Buffer.from(parts[2]));
  }
  return false;
}

export interface Profile {
  nick: string; money: number; xp: number; owned: string[]; sel: string;
  upg: Record<string, { eng: number; dur: number; hdl: number; gun: number }>;
  prem: boolean; kills: number; deaths: number; wins: number; rounds: number;
}

const DAY = 24 * 3600 * 1000;

function rowToProfile(r: any): Profile {
  let owned: string[] = ['po2'], upg: any = {};
  try { owned = JSON.parse(r.owned); } catch { }
  try { upg = JSON.parse(r.upg); } catch { }
  if (!owned.includes('po2')) owned.push('po2');
  // sel — голый id (НЕ JSON): старые записи содержали '"su57"' с кавычками (JSON.stringify от строки)
  // и отваливались от проверки owned.includes → выбор молча сбрасывался на По-2 после каждого боя
  let sel = String(r.sel || 'po2');
  if (sel.length > 1 && sel.startsWith('"') && sel.endsWith('"')) sel = sel.slice(1, -1);
  if (!PLANES.some(x => x.id === sel) || !owned.includes(sel)) sel = 'po2';
  r.sel = sel;
  for (const pl of PLANES) if (!upg[pl.id]) upg[pl.id] = { eng: 0, dur: 0, hdl: 0, gun: 0 };
  return { nick: r.nick, money: r.money, xp: r.xp, owned, sel: r.sel, upg, prem: !!r.prem, kills: r.kills, deaths: r.deaths, wins: r.wins, rounds: r.rounds };
}

export function register(nickRaw: string, pass: string): { ok: boolean; err?: string; token?: string; profile?: Profile } {
  const nick = String(nickRaw || '').trim().replace(/\s+/g, ' ');
  if (nick.length < 3 || nick.length > 16) return { ok: false, err: 'Ник: от 3 до 16 символов' };
  if (!/^[\p{L}\p{N} _.-]+$/u.test(nick)) return { ok: false, err: 'Ник: буквы, цифры, пробел, . _ -' };
  if (String(pass || '').length < 4) return { ok: false, err: 'Пароль: минимум 4 символа' };
  const nick_l = nick.toLowerCase();
  const dup = D().prepare('SELECT nick_l FROM players WHERE nick_l=?').get(nick_l);
  if (dup) return { ok: false, err: 'Ник уже занят — придумайте другой' };
  const hash = hashPass(String(pass));
  const now = Date.now();
  try {
    D().prepare(`INSERT INTO players(nick,nick_l,pass,money,xp,owned,sel,upg,prem,created,lastseen)
              VALUES(?,?,?,1000,0,'["po2"]','po2','{}',0,?,?)`).run(nick, nick_l, hash, now, now);
  } catch (e: any) {
    if (String(e).includes('UNIQUE')) return { ok: false, err: 'Ник уже занят — придумайте другой' };
    throw e;
  }
  const token = mkSession(nick_l);
  return { ok: true, token, profile: getProfile(nick_l)! };
}

export function login(nickRaw: string, pass: string): { ok: boolean; err?: string; token?: string; profile?: Profile } {
  const nick_l = String(nickRaw || '').trim().toLowerCase();
  const r: any = D().prepare('SELECT * FROM players WHERE nick_l=?').get(nick_l);
  if (!r) return { ok: false, err: 'Пилот с таким ником не найден' };
  if (!verifyPass(String(pass || ''), r.pass)) return { ok: false, err: 'Неверный пароль' };
  D().prepare('UPDATE players SET lastseen=? WHERE nick_l=?').run(Date.now(), nick_l);
  const token = mkSession(nick_l);
  return { ok: true, token, profile: rowToProfile(r) };
}

function mkSession(nick_l: string): string {
  const token = randomUUID().replace(/-/g, '');
  D().prepare('INSERT INTO sessions(token,nick_l,exp) VALUES(?,?,?)').run(token, nick_l, Date.now() + 30 * DAY);
  D().prepare('DELETE FROM sessions WHERE exp<?').run(Date.now());
  return token;
}

export function byToken(token: string): Profile | null {
  if (!token || typeof token !== 'string') return null;
  const s: any = D().prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s || s.exp < Date.now()) return null;
  const r: any = D().prepare('SELECT * FROM players WHERE nick_l=?').get(s.nick_l);
  return r ? rowToProfile(r) : null;
}

export function getProfile(nick_l: string): Profile | null {
  const r: any = D().prepare('SELECT * FROM players WHERE nick_l=?').get(nick_l);
  return r ? rowToProfile(r) : null;
}

function saveField(nick_l: string, field: string, json: string) {
  D().prepare(`UPDATE players SET ${field}=? WHERE nick_l=?`).run(json, nick_l);
}

// ==== покупки/выбор/улучшения/премиум — серверная валидация, клиенту верим только в деньги с БД ====
export function shop(p: Profile, nick_l: string, body: any): { ok: boolean; err?: string; profile: Profile } {
  const act = body && body.act;
  if (act === 'buy') {
    const pl = PLANES.find(x => x.id === body.id);
    if (!pl || pl.prem) return { ok: false, err: 'Нельзя купить', profile: p };
    if (p.owned.includes(pl.id)) return { ok: false, err: 'Уже куплен', profile: p };
    if (p.money < pl.cost) return { ok: false, err: 'Не хватает денег', profile: p };
    p.money -= pl.cost; p.owned.push(pl.id); p.sel = pl.id;
    saveField(nick_l, 'owned', JSON.stringify(p.owned));
    saveField(nick_l, 'sel', p.sel); // id без JSON.stringify — иначе в БД попадают кавычки и чтение сбрасывает выбор на po2
    saveField(nick_l, 'money', String(p.money));
    return { ok: true, profile: p };
  }
  if (act === 'sel') {
    if (!p.owned.includes(body.id)) return { ok: false, err: 'Самолёт не куплен', profile: p };
    p.sel = body.id;
    saveField(nick_l, 'sel', p.sel); // id без JSON.stringify (см. комментарий в rowToProfile)
    return { ok: true, profile: p };
  }
  if (act === 'upg') {
    const COST = [200, 350, 600, 900, 1300];
    const u = p.upg[p.sel] || (p.upg[p.sel] = { eng: 0, dur: 0, hdl: 0, gun: 0 });
    const br = body.br;
    if (!(br in u) || u[br] >= 5) return { ok: false, err: 'Максимум', profile: p };
    const cost = COST[u[br]];
    if (p.xp < cost) return { ok: false, err: 'Мало опыта', profile: p };
    p.xp -= cost; u[br]++;
    saveField(nick_l, 'upg', JSON.stringify(p.upg));
    saveField(nick_l, 'xp', String(p.xp));
    return { ok: true, profile: p };
  }
  if (act === 'prem') {
    if (String(body.code || '').trim().toLowerCase() !== PREM_CODE) return { ok: false, err: 'Неверный код', profile: p };
    if (!p.owned.includes('su57')) p.owned.push('su57');
    p.prem = true;
    saveField(nick_l, 'owned', JSON.stringify(p.owned));
    saveField(nick_l, 'prem', '1');
    return { ok: true, profile: p };
  }
  return { ok: false, err: 'Неизвестное действие', profile: p };
}

// награды боя — добавить к профилю и статистике
export function addReward(nick_l: string, money: number, xp: number, stat?: { kill?: number; death?: number; win?: boolean; round?: boolean }) {
  const p = getProfile(nick_l);
  if (!p) return;
  p.money += money; p.xp += xp;
  let kills = p.kills, deaths = p.deaths, wins = p.wins, rounds = p.rounds;
  if (stat) {
    if (stat.kill) kills += stat.kill;
    if (stat.death) deaths += stat.death;
    if (stat.win) wins += 1;
    if (stat.round) rounds += 1;
  }
  D().prepare('UPDATE players SET money=?,xp=?,kills=?,deaths=?,wins=?,rounds=?,lastseen=? WHERE nick_l=?')
    .run(p.money, p.xp, kills, deaths, wins, rounds, Date.now(), nick_l);
}
