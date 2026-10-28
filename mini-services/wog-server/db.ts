// Профили игроков: SQLite (bun:sqlite) + пароли (Bun.password) + сессии-токены.
// Ник уникален (без учёта регистра) — дубликаты исключены на уровне БД и явной проверки.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { PREM_CODE, PLANES } from './data';

const db = new Database(new URL('./data/wog.db', import.meta.url).pathname);
mkdirSync(new URL('./data', import.meta.url).pathname, { recursive: true }); // каталог БД может не существовать (Docker)
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
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
);
`);

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
  if (!owned.includes(r.sel)) r.sel = 'po2';
  for (const pl of PLANES) if (!upg[pl.id]) upg[pl.id] = { eng: 0, dur: 0, hdl: 0, gun: 0 };
  return { nick: r.nick, money: r.money, xp: r.xp, owned, sel: r.sel, upg, prem: !!r.prem, kills: r.kills, deaths: r.deaths, wins: r.wins, rounds: r.rounds };
}

export function register(nickRaw: string, pass: string): { ok: boolean; err?: string; token?: string; profile?: Profile } {
  const nick = String(nickRaw || '').trim().replace(/\s+/g, ' ');
  if (nick.length < 3 || nick.length > 16) return { ok: false, err: 'Ник: от 3 до 16 символов' };
  if (!/^[\p{L}\p{N} _.-]+$/u.test(nick)) return { ok: false, err: 'Ник: буквы, цифры, пробел, . _ -' };
  if (String(pass || '').length < 4) return { ok: false, err: 'Пароль: минимум 4 символа' };
  const nick_l = nick.toLowerCase();
  const dup = db.query('SELECT nick_l FROM players WHERE nick_l=?').get(nick_l);
  if (dup) return { ok: false, err: 'Ник уже занят — придумайте другой' };
  const hash = Bun.password.hashSync(String(pass), 'argon2id');
  const now = Date.now();
  try {
    db.query(`INSERT INTO players(nick,nick_l,pass,money,xp,owned,sel,upg,prem,created,lastseen)
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
  const r: any = db.query('SELECT * FROM players WHERE nick_l=?').get(nick_l);
  if (!r) return { ok: false, err: 'Пилот с таким ником не найден' };
  if (!Bun.password.verifySync(String(pass || ''), r.pass)) return { ok: false, err: 'Неверный пароль' };
  db.query('UPDATE players SET lastseen=? WHERE nick_l=?').run(Date.now(), nick_l);
  const token = mkSession(nick_l);
  return { ok: true, token, profile: rowToProfile(r) };
}

function mkSession(nick_l: string): string {
  const token = crypto.randomUUID().replace(/-/g, '');
  db.query('INSERT INTO sessions(token,nick_l,exp) VALUES(?,?,?)').run(token, nick_l, Date.now() + 30 * DAY);
  db.query('DELETE FROM sessions WHERE exp<?').run(Date.now());
  return token;
}

export function byToken(token: string): Profile | null {
  if (!token || typeof token !== 'string') return null;
  const s: any = db.query('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s || s.exp < Date.now()) return null;
  const r: any = db.query('SELECT * FROM players WHERE nick_l=?').get(s.nick_l);
  return r ? rowToProfile(r) : null;
}

export function getProfile(nick_l: string): Profile | null {
  const r: any = db.query('SELECT * FROM players WHERE nick_l=?').get(nick_l);
  return r ? rowToProfile(r) : null;
}

function saveField(nick_l: string, field: string, json: string) {
  db.query(`UPDATE players SET ${field}=? WHERE nick_l=?`).run(json, nick_l);
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
    saveField(nick_l, 'sel', JSON.stringify(p.sel));
    saveField(nick_l, 'money', String(p.money));
    return { ok: true, profile: p };
  }
  if (act === 'sel') {
    if (!p.owned.includes(body.id)) return { ok: false, err: 'Самолёт не куплен', profile: p };
    p.sel = body.id;
    saveField(nick_l, 'sel', JSON.stringify(p.sel));
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
  db.query('UPDATE players SET money=?,xp=?,kills=?,deaths=?,wins=?,rounds=?,lastseen=? WHERE nick_l=?')
    .run(p.money, p.xp, kills, deaths, wins, rounds, Date.now(), nick_l);
}
