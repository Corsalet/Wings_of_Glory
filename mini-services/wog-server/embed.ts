// Wings of Glory — встраивание мультиплеера в чужой HTTP-сервер (Next.js / TatNet и т.п.).
// attachWog(httpServer) вешает socket.io на путь /wog/ и запускает бой (game.ts).
// Запросы к /wog/* перехватываются socket.io ДО роутера Next — страница и сокет живут на одном origin.
import { Server } from 'socket.io';
import { initGame } from './game';

export function attachWog(httpServer: any) {
  const io = new Server(httpServer, {
    path: '/wog/', // НЕ '/': иначе движок перехватывает ВСЕ запросы и статика Next не отдаётся
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
  });
  initGame(io);
  console.log('[wog] мультиплеер запущен: socket.io на /wog/ (бой 5×5, жизни 15×15)');
  return io;
}
