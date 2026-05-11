#!/bin/sh
# Polls /streamer_config/current_video.txt every 2 s.
# Kills and restarts FFmpeg whenever the file content changes.
# Stream is always published to rtsp://mediamtx:8554/dev.

CONFIG=/streamer_config/current_video.txt
STREAM_URL="rtsp://mediamtx:8554/dev"
FFMPEG_PID=""
LAST_VIDEO=""

start_ffmpeg() {
  VIDEO=$1
  echo "[streamer] Starting: /videos/$VIDEO -> $STREAM_URL"
  ffmpeg -re -stream_loop -1 -i "/videos/$VIDEO" \
    -c:v copy -c:a copy \
    -f rtsp -rtsp_transport tcp \
    "$STREAM_URL" \
    2>&1 &
  FFMPEG_PID=$!
  LAST_VIDEO=$VIDEO
}

stop_ffmpeg() {
  if [ -n "$FFMPEG_PID" ]; then
    kill "$FFMPEG_PID" 2>/dev/null
    wait "$FFMPEG_PID" 2>/dev/null
    FFMPEG_PID=""
  fi
}

# Seed config file with default if missing
mkdir -p "$(dirname "$CONFIG")"
if [ ! -f "$CONFIG" ] || [ -z "$(cat "$CONFIG" 2>/dev/null | tr -d '[:space:]')" ]; then
  echo "test5.mp4" > "$CONFIG"
fi

CURRENT_VIDEO=$(cat "$CONFIG" | tr -d '[:space:]')
start_ffmpeg "$CURRENT_VIDEO"

# Main polling loop
while true; do
  sleep 2

  if [ -f "$CONFIG" ]; then
    NEW_VIDEO=$(cat "$CONFIG" | tr -d '[:space:]')
    if [ -n "$NEW_VIDEO" ] && [ "$NEW_VIDEO" != "$LAST_VIDEO" ]; then
      echo "[streamer] Switching: $LAST_VIDEO -> $NEW_VIDEO"
      stop_ffmpeg
      sleep 1
      start_ffmpeg "$NEW_VIDEO"
    fi
  fi

  # Auto-restart if ffmpeg crashed
  if ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
    echo "[streamer] FFmpeg exited unexpectedly, restarting..."
    sleep 2
    start_ffmpeg "$LAST_VIDEO"
  fi
done
