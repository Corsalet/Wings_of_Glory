// Быстрая проверка: доходят ли снапшоты и жив ли тик
import { io } from 'socket.io-client';
const s = io('http://localhost:3030', { transports: ['websocket'] });
s.on('connect', async () => {
  console.log('connected');
  const j: any = await new Promise(r => s.emit('join', {}, r));
  console.log('join:', j.ok, 'you=', j.you && j.you.id, 'ents=', j.list && j.list.length);
  let n = 0;
  s.on('snap', (d: any) => { n++; if (n <= 2) console.log('snap#', n, 'e=', d.e.length, 'bl=', d.bl, 'rl=', d.rl); });
  s.on('b', () => { });
  setTimeout(() => { console.log('snaps in 3s:', n); process.exit(0); }, 3000);
});
s.on('connect_error', (e: any) => { console.log('connect_error', e.message); process.exit(1); });
