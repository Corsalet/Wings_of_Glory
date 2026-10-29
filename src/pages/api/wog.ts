// Ленивая инициализация мультиплеера внутри Next-сервера (TatNet/один сервис на всё).
// Клиент игры перед подключением сокета делает fetch('api/wog') — этот обработчик
// вешает socket.io на HTTP-сервер Next (path /wog/) и запускает серверную симуляцию.
import type { Server as HttpServer } from 'http';
import type { Server as IOServer } from 'socket.io';
import type { NextApiRequest, NextApiResponse } from 'next';
import { attachWog } from '../../../mini-services/wog-server/embed';

type WogServer = HttpServer & { __wogIo?: IOServer };

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // res.socket доступен в обычном Node-сервере (не serverless)
  const server = (res as any).socket?.server as WogServer | undefined;
  if (!server) {
    res.status(200).json({ ok: false, why: 'no-http-server' });
    return;
  }
  if (!server.__wogIo) {
    // socket.io должен получить /wog/ ПЕРВЫМ: переставляем его upgrade-обработчик вперёд,
    // иначе родной upgrade-обработчик Next может убить websocket-апгрейд.
    const prev = server.listeners('upgrade');
    if (prev.length) server.removeAllListeners('upgrade');
    server.__wogIo = attachWog(server);
    for (const l of prev) server.on('upgrade', l as any);
    console.log('[wog] мультиплеер подключён к Next-серверу (path /wog/)');
  }
  res.status(200).json({ ok: true });
}
