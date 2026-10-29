// Тест бага «выбор самолёта сбрасывается на По-2 после боя»:
// 1) регистрируем пилота 2) выдаём премиум (код) 3) shop act=sel su57
// 4) перечитываем профиль из БД (как делает byToken при join/roundEnd) — sel обязан остаться su57
import { io, Socket } from 'socket.io-client';

const URL = process.env.WOG_URL || 'http://localhost:3030';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const once = <T,>(s: Socket, ev: string) => new Promise<T>(r => s.once(ev, r));
const emitCb = <T,>(s: Socket, ev: string, data: any) => new Promise<T>(r => s.emit(ev, data, r));

async function main() {
  const A = io(URL, { transports: ['websocket'], path: '/wog/' });
  await once(A, 'connect');
  const NICK = 'СелТест-' + ((Math.random() * 1e5) | 0);
  const reg = await emitCb<any>(A, 'auth:register', { nick: NICK, pass: '1234' });
  if (!reg.ok) { console.error('FAIL: register: ' + reg.err); process.exit(1); }
  const prem = await emitCb<any>(A, 'shop', { act: 'prem', code: 'meosan' });
  if (!prem.ok || !prem.profile.owned.includes('su57')) { console.error('FAIL: prem: ' + JSON.stringify(prem)); process.exit(1); }
  const sel = await emitCb<any>(A, 'shop', { act: 'sel', id: 'su57' });
  if (!sel.ok || sel.profile.sel !== 'su57') { console.error('FAIL: sel: ' + JSON.stringify(sel)); process.exit(1); }
  A.close();

  // второй коннект + auth:token — полный цикл чтения профиля из БД (как join / roundEnd)
  const B = io(URL, { transports: ['websocket'], path: '/wog/' });
  await once(B, 'connect');
  const re = await emitCb<any>(B, 'auth:token', { token: reg.token });
  if (!re.ok) { console.error('FAIL: auth:token: ' + JSON.stringify(re)); process.exit(1); }
  if (re.profile.sel !== 'su57') {
    console.error('FAIL: после перечитывания sel=' + re.profile.sel + ' (ожидался su57) — выбор сбросился');
    process.exit(1);
  }
  if (re.profile.prem !== true) { console.error('FAIL: prem потерян'); process.exit(1); }
  console.log('OK: sel=su57 сохранился и перечитался из БД, prem=' + re.profile.prem);
  B.close();
  await wait(120);
  process.exit(0);
}
main().catch(e => { console.error('FAIL: ' + (e && e.message || e)); process.exit(1); });
