#!/bin/bash
cd /workspace/BlueEye
docker compose build cv-worker && \
docker compose up -d cv-worker && \
echo "=== LAST 30 LINES ===" && \
sleep 5 && \
docker compose logs --tail=30 cv-worker
