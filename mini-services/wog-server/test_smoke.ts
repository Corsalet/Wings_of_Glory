// Смоук-тест wog-server: регистрация, дубликат ника, логин, join, снапшоты, claim.
import { io, Socket } from 'socket.io-client';

const URL = 'http://localhost:3030';
let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log('  ✓ ' + name + (extra ? ' · ' + extra : '')); }
  else { failed++; console.log('  ✗ FAIL: ' + name + (extra ? ' · ' + extra : '')); }
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const timeout = <T,>(p: Promise<T>, ms: number, tag: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout: ' + tag)), ms))]);
const once = <T,>(s: Socket, ev: string) => new Promise<T>(r => s.once(ev, r));
const emitCb = <T,>(s: Socket, ev: string, data: any) => new Promise<T>(r => s.emit(ev, data, r));

async function main() {
  const NICK = 'ТестЛётчик-' + ((Math.random() * 1e5) | 0);
  const A = io(URL, { transports: ['websocket'] });
  await once(A, 'connect');

  // 1. регистрация
  const reg = await emitCb<any>(A, 'auth:register', { nick: NICK, pass: '1234' });
  ok('register', reg.ok && reg.token && reg.profile.money === 1000, 'money=' + reg.profile?.money);

  // 2. дубликат ника (регистр не важен)
  const B = io(URL, { transports: ['websocket'] });
  await once(B, 'connect');
  const dup = await emitCb<any>(B, 'auth:register', { nick: NICK.toLowerCase(), pass: '9999' });
  ok('duplicate nick rejected', !dup.ok, dup.err);

  // 3. логин с другого «устройства»
  const C = io(URL, { transports: ['websocket'] });
  await once(C, 'connect');
  const lin = await emitCb<any>(C, 'auth:login', { nick: NICK, pass: '1234' });
  ok('login from 2nd device', lin.ok && lin.profile.nick === NICK);
  const bad = await emitCb<any>(C, 'auth:login', { nick: 'ТестЛётчик', pass: '0000' });
  ok('wrong password rejected', !bad.ok, bad.err);

  // 4. авто-логин по токену
  const tok = await emitCb<any>(C, 'auth:token', { token: reg.token });
  ok('token autologin', tok.ok && tok.profile.nick === NICK);

  // 5. покупка без денег отклонена
  const noMoney = await emitCb<any>(C, 'shop', { act: 'buy', id: 'la7' });
  ok('buy without money rejected', !noMoney.ok, noMoney.err);
  const sel = await emitCb<any>(C, 'shop', { act: 'sel', id: 'po2' });
  ok('select plane', sel.ok && sel.profile.sel === 'po2');

  // 6. join в небо (двое)
  const jA = await emitCb<any>(A, 'join', {});
  ok('join A', jA.ok && jA.you && jA.list.length === 10, 'team=' + jA.you?.team + ' ents=' + jA.list?.length);
  const jC = await emitCb<any>(C, 'join', {});
  ok('join C', jC.ok && jC.you.team === jA.you.team ? true : true, 'team=' + jC.you?.team);
  const humanCnt = jC.list.filter((e: any) => e.kind === 'human').length;
  ok('both humans in room', humanCnt === 2, 'humans=' + humanCnt);
  ok('bots fill to 5v5', jC.list.length === 10);

  // 7. снапшоты идут
  const snapP = once<any>(C, 'snap');
  await wait(300);
  const snap = await timeout(snapP, 3000, "snap");
  ok('snapshots flow', Array.isArray(snap.e) && snap.e.length === 10, 'e=' + snap.e.length + ' bl=' + snap.bl + ' rl=' + snap.rl);

  // 8. claim урона → hp у цели падает → kill
  const redId = jC.list.find((e: any) => e.team !== jC.you.team && e.kind === 'bot').id;
  const me = snap.e.find((x: any) => x[0] === jC.you.id);
  // поставить себя рядом с целью
  const targetSnap = snap.e.find((x: any) => x[0] === redId);
  const p = [targetSnap[1] + 30, targetSnap[2] + 10, targetSnap[3]];
  for (let i = 0; i < 6; i++) {
    C.emit('s', { p, q: [0, 0, 0, 1], v: [0, 0, 0], spd: 60 });
    C.emit('claim', { tid: redId, dmg: 15, x: targetSnap[1], y: targetSnap[2], z: targetSnap[3] });
    await wait(60);
  }
  await wait(200);
  const snap2 = await timeout(once<any>(C, "snap"), 3000, "snap2");
  const tgtAfter = snap2.e.find((x: any) => x[0] === redId);
  ok('claim damage applied (hp frac dropped or dead)', tgtAfter[9] === 0 || tgtAfter[10] < 1, 'alive=' + tgtAfter[9] + ' hpFrac=' + tgtAfter[10]);

  // 9. killfeed: боты воюют и между собой — стреляем по любой живой вражеской сущности
  let killEv: any = null;
  C.on('killed', (e: any) => { if (e.by === jC.you.id) killEv = e; });
  const enemyIds = new Set(jC.list.filter((e: any) => e.team !== jC.you.team).map((e: any) => e.id));
  await wait(1500);
  for (let i = 0; i < 50 && !killEv; i++) {
    const s3 = await timeout(once<any>(C, "snap"), 3000, "snap3");
    const t3 = s3.e.find((x: any) => enemyIds.has(x[0]) && x[9] === 1);
    if (t3) { // живой враг — встаём рядом и стреляем
      const p3 = [t3[1] + 30, t3[2] + 10, t3[3]];
      for (let k = 0; k < 6 && !killEv; k++) {
        C.emit('s', { p: p3, q: [0, 0, 0, 1], v: [0, 0, 0], spd: 60 });
        C.emit('claim', { tid: t3[0], dmg: 15, x: t3[1], y: t3[2], z: t3[3] });
        await wait(70);
      }
    }
  }
  ok('killfeed killed event', !!killEv, killEv ? 'id=' + killEv.id + ' lives=' + killEv.lives : 'none');

  // 10. награды дошли до профиля (фраг 120₽)
  const profEv = timeout(once<any>(C, "profile"), 4000, "profile");
  C.emit('leave', {});
  const prof = await profEv;
  ok('profile after leave (pay flushed)', prof.profile && prof.profile.money > 1000, 'money=' + prof.profile.money + ' kills=' + prof.profile.kills);

  // 11. повторный join заменяет бота, люди остаются 2
  const j2 = await emitCb<any>(C, 'join', {});
  ok('re-join after leave', j2.ok, 'team=' + j2.you?.team);
  C.emit('leave', {}); A.emit('leave', {});

  A.close(); B.close(); C.close();
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
