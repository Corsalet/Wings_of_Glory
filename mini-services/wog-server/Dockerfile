# Wings of Glory — игровой сервер: socket.io (/wog/) + клиент game.html на одном порту.
# Сборка из корня репозитория:
#   docker build -f mini-services/wog-server/Dockerfile -t wog-server .
# Запуск:
#   docker run -p 8080:8080 -e PORT=8080 wog-server   →  http://localhost:8080 (игра + мультиплеер)
FROM oven/bun:1-slim
WORKDIR /app/srv
COPY mini-services/wog-server/package.json mini-services/wog-server/bun.lock ./
COPY mini-services/wog-server/index.ts mini-services/wog-server/data.ts mini-services/wog-server/db.ts ./
COPY public/game.html /app/public/game.html
RUN bun install --frozen-lockfile
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "index.ts"]
