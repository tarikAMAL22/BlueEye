#!/usr/bin/env bash
# BlueEye — Vast.ai deployment script
# Run this ON the Vast.ai server after uploading the project.
# Usage: bash deploy.sh

set -e

# ── Validate .env ─────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.vastai to .env and fill in the values."
  exit 1
fi
source .env

if [ -z "$PUBLIC_IP" ] || [ -z "$DB_PASSWORD" ] || [ -z "$JWT_SECRET" ]; then
  echo "ERROR: PUBLIC_IP, DB_PASSWORD, and JWT_SECRET must be set in .env"
  exit 1
fi

# ── NVIDIA Container Toolkit check ───────────────────────────────────────────
if ! docker run --rm --gpus all nvidia/cuda:12.1.1-base-ubuntu22.04 nvidia-smi &>/dev/null; then
  echo "ERROR: NVIDIA Container Toolkit not available or GPU not accessible."
  echo "Install it with: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
  exit 1
fi
echo "GPU check passed."

# ── Pull / build ──────────────────────────────────────────────────────────────
echo "Building images (this takes ~10 min on first run due to PyTorch + dlib)..."
docker compose -f docker-compose.prod.yml --env-file .env build

# ── Ensure schema is up to date ───────────────────────────────────────────────
echo "Starting DB..."
docker compose -f docker-compose.prod.yml --env-file .env up -d db
echo "Waiting for MySQL to be ready..."
sleep 15

echo "Pushing DB schema..."
docker compose -f docker-compose.prod.yml --env-file .env run --rm app \
  sh -c "cd /app && corepack enable pnpm && pnpm db:push" || echo "(schema push skipped — run manually if needed)"

# ── Launch all services ───────────────────────────────────────────────────────
echo "Starting all services..."
docker compose -f docker-compose.prod.yml --env-file .env up -d

echo ""
echo "BlueEye is running!"
echo "  Web UI:  http://${PUBLIC_IP}:${BLUEEYE_PORT}"
echo "  HLS:     http://${PUBLIC_IP}:${MEDIAMTX_HLS_PORT}"
echo "  RTSP:    rtsp://${PUBLIC_IP}:8554"
echo ""
echo "Check logs: docker compose -f docker-compose.prod.yml logs -f"
