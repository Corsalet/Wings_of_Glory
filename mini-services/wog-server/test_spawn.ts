// Тест: (1) свои не спавнятся кучей (мин ≥ 150 м), (2) залп-лимит ≤ 2 красных ракет
// на одну синюю цель — при реактивных ботах (пилот на Су-57 поднимает ботов до ранга X).
import { io } from 'socket.io-client';
import { Database } from 'bun:sqlite';

const URL = process.env.WOG_URL || 'http://localhost:3030';
const DB = process.env.WOG_DB || './data/wog.db';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log('  ✓ ' + name + (extra ? ' · ' + extra : '')); }
  else { failed++; console.log('  ✗ FAIL: ' + name + (extra ? ' · ' + extra : '')); }
}

async function main() {
  const NICK = 'SpawnTest-' + ((Math.random() * 1e5) | 0);
  const A = io(URL, { transports: ['websocket'], path: '/wog/' });
  await new Promise(r => A.once('connect', r));
  const reg: any = await new Promise(r => A.emit('auth:register', { nick: NICK, pass: '1234' }, r));
  if (!reg.ok) throw new Error('register fail: ' + reg.err);

  // выдаём Су-57 напрямую в БД (профиль перечитается при auth:token)
  const db = new Database(DB);
  db.run(`UPDATE players SET money=99000, owned='["po2","su57"]', sel='su57' WHERE nick_l=?`, [NICK.toLowerCase()]);
  db.close();

  const tok: any = await new Promise(r => A.emit('auth:token', { token: reg.token }, r));
  ok('профиль с Су-57', tok.ok && tok.profile.sel === 'su57', 'sel=' + tok.profile?.sel);
  const sel: any = await new Promise(r => A.emit('shop', { act: 'sel', id: 'su57' }, r));
  ok('select su57', sel.ok && sel.profile.sel === 'su57');

  // join — боты должны подняться до реактивных рангов
  const j: any = await new Promise(r => A.emit('join', {}, r));
  ok('join ok 15:15', j.ok && j.bl === 15 && j.rl === 15, `bl=${j.bl} rl=${j.rl} ents=${(j.list || []).length}`);
  const teamOf = new Map<string, string>();
  for (const e of j.list) teamOf.set(e.id, e.team);
  const redJets = j.list.filter((e: any) => e.team === 'red').length;
  const redTiers = j.list.filter((e: any) => e.team === 'red').map((e: any) => e.planeId).join(',');
  ok('красные в комнате', redJets === 5, redTiers);

  // ждём первый снапшот
  let snap: any = null;
  A.on('snap', (d: any) => { if (!snap) snap = d; });
  await wait(2500);
  if (!snap) { console.log('  ✗ FAIL: снапшотов нет'); process.exit(1); }
  const posOf = new Map<string, [number, number]>();
  for (const row of snap.e) posOf.set(row[0], [row[1], row[3]]);

  // 1. минимум между своими (горизонталь, только живые)
  let minRed = 1e9, minBlue = 1e9;
  const alive = new Set(snap.e.filter((r: any[]) => r[9] === 1).map((r: any[]) => r[0]));
  const ids = [...teamOf.keys()].filter(id => alive.has(id) && posOf.has(id));
  for (let i = 0; i < ids.length; i++) for (let k = i + 1; k < ids.length; k++) {
    const a = ids[i], b = ids[k];
    if (teamOf.get(a) !== teamOf.get(b)) continue;
    const pa = posOf.get(a)!, pb = posOf.get(b)!;
    const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
    if (teamOf.get(a) === 'red') minRed = Math.min(minRed, d); else minBlue = Math.min(minBlue, d);
  }
  ok('красные не в куче (мин ≥ 150 м)', minRed >= 150, `min=${Math.round(minRed)} м`);
  ok('синие не в куче (мин ≥ 150 м)', minBlue >= 150, `min=${Math.round(minBlue)} м`);

  // 2. залп-лимит: 45 с реактивной войны — максимум 2 ракеты на одну синюю цель
  let maxSalvo = 0, mslSeen = 0;
  A.on('snap', (d: any) => {
    const cnt = new Map<string, number>();
    for (const m of (d.m || [])) {
      const tid = m[7];
      mslSeen++;
      if (!tid || typeof tid !== 'string' || !tid.startsWith('e')) continue;
      if (teamOf.get(tid) !== 'blue') continue;
      cnt.set(tid, (cnt.get(tid) || 0) + 1);
    }
    for (const v of cnt.values()) maxSalvo = Math.max(maxSalvo, v);
  });
  console.log('наблюдаем реактивный бой 45 с…');
  await wait(45000);
  ok('ракеты в воздухе наблюдались', mslSeen > 0, `всего ракет в снапшотах=${mslSeen}`);
  ok('залп-лимит ≤ 2 ракеты на цель', maxSalvo <= 2, `max одновременно=${maxSalvo}`);

  A.disconnect();
  console.log(`\nитог: passed=${passed} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
