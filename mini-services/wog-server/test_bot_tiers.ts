// Тест «подбора по уровням» в сети: пилот на Су-57 (ранг XI) входит в бой —
// боты обязаны быть ранга >= 10 (Су-35С/Су-57), а не бипланы.
// Отдельный чистый сервер (порт задаётся WOG_PORT), чтобы resetRound был девственно свежим.
import { io, Socket } from 'socket.io-client';

const URL = process.env.WOG_URL || 'http://localhost:3056';
const TIER: Record<string, number> = { po2:1, i153:1, i16:2, lagg3:2, yak1:3, mig3:3, la5:4, yak9:4, yak3:5, la7:5, mig9:6, mig15:7, mig21:8, mig29:9, su35:10, su57:11 };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const once = <T,>(s: Socket, ev: string) => new Promise<T>(r => s.once(ev, r));
const emitCb = <T,>(s: Socket, ev: string, data: any) => new Promise<T>(r => s.emit(ev, data, r));

async function main() {
  const A = io(URL, { transports: ['websocket'], path: '/wog/' });
  await once(A, 'connect');
  const NICK = 'ТиРТест-' + ((Math.random() * 1e5) | 0);
  const reg = await emitCb<any>(A, 'auth:register', { nick: NICK, pass: '1234' });
  if (!reg.ok) { console.error('FAIL: register: ' + reg.err); process.exit(1); }
  await emitCb<any>(A, 'shop', { act: 'prem', code: 'meosan' });
  const sel = await emitCb<any>(A, 'shop', { act: 'sel', id: 'su57' });
  if (!sel.ok) { console.error('FAIL: sel: ' + JSON.stringify(sel)); process.exit(1); }

  const j = await emitCb<any>(A, 'join', {});
  if (!j.ok) { console.error('FAIL: join: ' + JSON.stringify(j)); process.exit(1); }
  const bots = j.list.filter((e: any) => e.kind !== 'human');
  const tiers = bots.map((e: any) => TIER[e.planeId] || 0);
  const minT = Math.min(...tiers);
  console.log('боты:', bots.map((e: any) => e.planeId).join(', '), '| ранги:', tiers.join(','));
  if (minT < 10) { console.error('FAIL: у Су-57 боты ниже X ранга: min=' + minT); process.exit(1); }
  const me = j.list.find((e: any) => e.id === j.you.id);
  if (!me || me.planeId !== 'su57') { console.error('FAIL: сам пилот в небе: ' + JSON.stringify(me)); process.exit(1); }
  console.log('OK: пилот в небе на su57, боты рангов 10-11 (min=' + minT + ')');
  A.close();
  await wait(120);
  process.exit(0);
}
main().catch(e => { console.error('FAIL: ' + (e && e.message || e)); process.exit(1); });
