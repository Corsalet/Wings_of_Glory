// Тест: первый живой пилот всегда получает свежий бой 15:15,
// даже если боты успели сбить друг друга пока людей в комнате не было.
import { io } from 'socket.io-client';

const URL = process.env.WOG_URL || 'http://localhost:3030';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const NICK = 'Fresh-' + ((Math.random() * 1e5) | 0);
  const A = io(URL, { transports: ['websocket'], path: '/wog/' });
  await new Promise(r => A.once('connect', r));

  // регистрация
  const reg: any = await new Promise(r => A.emit('auth:register', { nick: NICK, pass: '1234' }, r));
  if (!reg.ok) throw new Error('register fail: ' + reg.err);

  // слушаем войну ботов: 40 секунд, фиксируем минимальный счёт синих/красных
  let minBl = 15, minRl = 15, snaps = 0;
  A.on('snap', (d: any) => { snaps++; if (typeof d.bl === 'number') { minBl = Math.min(minBl, d.bl); minRl = Math.min(minRl, d.rl); } });
  console.log('ждём 40 с — биты ботов…');
  await wait(40000);
  console.log(`за 40 с войны: snap-пакетов=${snaps}, минимум счёта ${minBl}:${minRl}`);
  if (snaps === 0) console.log('(!) снапшотов не видно — возможно, snap шлётся только в комнате; проверяем по join');

  // заходим первым живым пилотом
  const j: any = await new Promise(r => A.emit('join', {}, r));
  const ok = j.ok && j.bl === 15 && j.rl === 15;
  console.log(`JOIN → bl=${j.bl} rl=${j.rl} ents=${(j.list || []).length} → ${ok ? 'OK: свежий бой 15:15' : 'FAIL: счёт не сброшен'}`);
  A.disconnect();
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
