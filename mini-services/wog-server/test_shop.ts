// Тест профиля и прокачки: серверная валидация улучшений, сохранение в БД,
// переживание перезахода (новый сокет + логин), спам-клики, покупка/выбор самолёта.
// Запуск: bun test_shop.ts  (нужен сервер :3030 — bash restart.sh)
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
const emitCb = <T,>(s: any, ev: string, data: any) => new Promise<T>(r => s.emit(ev, data, r));

async function main() {
  const NICK = 'ShopTest-' + ((Math.random() * 1e5) | 0);
  const A = io(URL, { transports: ['websocket'], path: '/wog/' });
  await new Promise(r => A.once('connect', r));

  // 1. регистрация: 1000 ₽, 0 опыта
  const reg: any = await emitCb(A, 'auth:register', { nick: NICK, pass: '1234' });
  ok('регистрация (1000 ₽, 0 оп)', reg.ok && reg.profile.money === 1000 && reg.profile.xp === 0,
    'money=' + reg.profile?.money + ' xp=' + reg.profile?.xp);

  // 2. улучшение без опыта отклонено
  const noXp: any = await emitCb(A, 'shop', { act: 'upg', br: 'eng' });
  ok('прокачка без опыта отклонена', !noXp.ok, noXp.err);

  // 3. выдаём опыт напрямую в БД → перечитываем профиль по токену
  const db = new Database(DB);
  db.run(`UPDATE players SET xp=3600 WHERE nick_l=?`, [NICK.toLowerCase()]);
  db.close();
  const tok: any = await emitCb(A, 'auth:token', { token: reg.token });
  ok('профиль перечитал опыт из БД', tok.ok && tok.profile.xp === 3600, 'xp=' + tok.profile?.xp);

  // 4. первая прокачка ДВИГАТЕЛЬ: 3600-200=3400, уровень 1
  const u1: any = await emitCb(A, 'shop', { act: 'upg', br: 'eng' });
  ok('upg eng lvl1 (−200 оп)', u1.ok && u1.profile.xp === 3400 && u1.profile.upg.po2.eng === 1,
    'xp=' + u1.profile?.xp + ' eng=' + u1.profile?.upg?.po2?.eng);

  // 5. спам-клики при «высоком пинге»: 4 запроса подряд без ожидания
  const spam = await Promise.all([
    emitCb<any>(A, 'shop', { act: 'upg', br: 'eng' }),
    emitCb<any>(A, 'shop', { act: 'upg', br: 'eng' }),
    emitCb<any>(A, 'shop', { act: 'upg', br: 'eng' }),
  ]);
  const spamOk = spam.filter(r => r.ok).length;
  const profSpam: any = await emitCb(A, 'auth:token', { token: reg.token });
  ok('спам-клики: сервер валидирует каждый (не больше, чем хватает опыта)', profSpam.profile.upg.po2.eng === 1 + spamOk,
    'eng=' + profSpam.profile.upg.po2.eng + ' ok=' + spamOk + '/3 xp=' + profSpam.profile.xp);

  // 6. качаем eng до максимума и проверяем отказ на 6-м
  for (let i = 0; i < 4; i++) await emitCb(A, 'shop', { act: 'upg', br: 'eng' });
  const u6: any = await emitCb(A, 'shop', { act: 'upg', br: 'eng' });
  ok('eng lvl5 максимум, 6-й отклонён', !u6.ok && u6.profile.upg.po2.eng === 5, u6.err);

  // 7. ПЕРЕЗАХОД: новый сокет, логин по нику/паролю — прокачка и опыт должны сохраниться
  const B = io(URL, { transports: ['websocket'], path: '/wog/' });
  await new Promise(r => B.once('connect', r));
  const lin: any = await emitCb(B, 'auth:login', { nick: NICK, pass: '1234' });
  const su = lin.profile.upg.po2;
  ok('перезаход: прокачка сохранилась в БД', lin.ok && su.eng === 5, `eng=${su?.eng} dur=${su?.dur} hdl=${su?.hdl} gun=${su?.gun}`);
  ok('перезаход: остаток опыта корректен', lin.profile.xp === 3600 - (200 + 350 + 600 + 900 + 1300), 'xp=' + lin.profile.xp);

  // 8. второй такой же логин (параллельные устройства) — тот же профиль
  const lin2: any = await emitCb(B, 'auth:login', { nick: NICK.toLowerCase(), pass: '1234' });
  ok('повторный логин (регистр ника) — тот же профиль', lin2.ok && lin2.profile.upg.po2.eng === 5);

  // 9. покупка без денег отклонена; зачислим деньги и купим Ла-7
  const noMoney: any = await emitCb(B, 'shop', { act: 'buy', id: 'la7' });
  ok('покупка без денег отклонена', !noMoney.ok, noMoney.err);
  const db2 = new Database(DB);
  db2.run(`UPDATE players SET money=31000 WHERE nick_l=?`, [NICK.toLowerCase()]);
  db2.close();
  const buy: any = await emitCb(B, 'shop', { act: 'buy', id: 'la7' });
  ok('покупка Ла-7: деньги списаны, самолёт выбран', buy.ok && buy.profile.money === 1000 && buy.profile.sel === 'la7' && buy.profile.owned.includes('la7'),
    'money=' + buy.profile?.money + ' sel=' + buy.profile?.sel);

  // 10. выбор ранее купленного самолёта сохраняется для следующей сессии
  const sel: any = await emitCb(B, 'shop', { act: 'sel', id: 'po2' });
  ok('выбор По-2 сохранён', sel.ok && sel.profile.sel === 'po2');

  A.disconnect(); B.disconnect();
  console.log(`\nитог: passed=${passed} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
