// Wings of Glory — сетевой сервер: профильная БД + комната 5×5 (люди + боты).
// Standalone-режим (bun index.ts): HTTP + статика игры + socket.io /wog/ на одном порту.
// Логика боя живёт в game.ts — тот же код встраивается в Next.js через embed.ts.
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Server } from 'socket.io';
import { initGame } from './game';

const PORT = Number(process.env.PORT || process.env.WOG_PORT || 3030); // PORT задаёт хостинг (Render/Railway/Docker)

// Клиент (game.html) раздаётся этим же сервером/портом — деплой одним сервисом,
// страница и сокет живут на одном origin (искл.: Pages/воркспейс — там сокет по ?srv/шлюзу).
const GAME_HTML: Buffer | null = (() => {
  for (const c of ['public/game.html', '../public/game.html', '../../public/game.html']) {
    try { const p = join(process.cwd(), c); if (existsSync(p)) return readFileSync(p); } catch {}
  }
  return null;
})();
const httpServer = createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (GAME_HTML && (u === '/' || u === '/game.html' || u === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(GAME_HTML);
  } else if (u === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});
const io = new Server(httpServer, {
  path: '/wog/', // НЕ '/': иначе движок перехватывает ВСЕ запросы (проверка slice по префиксу) и статика не отдаётся
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});
initGame(io);
httpServer.listen(PORT, () => {
  console.log(`WOG server on :${PORT} (socket /wog/ + client ${GAME_HTML ? 'bundled' : 'NOT FOUND — только сокет'})`);
});
process.on('SIGTERM', () => { httpServer.close(() => process.exit(0)); });
