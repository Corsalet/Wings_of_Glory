// Проверка инварианта жизней: join → 15/15, leave → join → снова 15/15.
import { io } from 'socket.io-client';

const URL = process.env.WOG_URL || 'http://localhost:3030';
const mk = (nick: string) => io(URL, { path: '/wog/', transports: ['websocket'] });

function joinProbe(nick: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout ' + nick)), 12000);
    const sock = mk(nick);
    sock.on('connect', () => {
      sock.emit('auth:register', { nick, pass: 'test-pass-1' }, (r: any) => {
        if (!r || !r.ok) { clearTimeout(to); return reject(new Error('reg fail ' + (r && r.err))); }
        sock.emit('join', null, (j: any) => {
          clearTimeout(to);
          if (!j || !j.ok) { clearTimeout(to); return reject(new Error('join fail ' + (j && j.err))); }
          resolve(`${nick}: team=${j.you.team} bl=${j.bl} rl=${j.rl} ents=${j.list.length}`);
          sock.close();
        });
      });
    });
    sock.on('connect_error', (e: any) => { clearTimeout(to); reject(new Error('conn ' + e.message)); });
  });
}

const n1 = 'InvA' + Math.floor(Math.random() * 1e5);
const n2 = 'InvB' + Math.floor(Math.random() * 1e5);
const r1 = await joinProbe(n1); console.log('JOIN1 →', r1);
await new Promise(res => setTimeout(res, 1500)); // сервер обработает leave первого
const r2 = await joinProbe(n2); console.log('JOIN2 →', r2);
const ok = /bl=15 rl=15/.test(r1) && /bl=15 rl=15/.test(r2);
console.log(ok ? 'INVARIANT OK (15/15 после каждого join)' : 'INVARIANT BROKEN');
process.exit(ok ? 0 : 1);
