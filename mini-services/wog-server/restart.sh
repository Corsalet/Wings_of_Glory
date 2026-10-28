#!/bin/bash
# Перезапуск wog-server с чистой БД (опционально) и прогон смоук-теста
set -e
cd /home/z/my-project/mini-services/wog-server
PID=$(ss -tlnp 2>/dev/null | grep :3030 | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$PID" ]; then kill -9 "$PID"; sleep 1; echo "killed old server pid=$PID"; fi
if [ "$1" == "--fresh" ]; then rm -f data/wog.db data/wog.db-wal data/wog.db-shm; echo "db wiped"; fi
nohup bun index.ts > server.log 2>&1 &
sleep 2
cat server.log
