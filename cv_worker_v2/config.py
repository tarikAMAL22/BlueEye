"""
BlueEye CV Worker v2 — config.py
Global configuration parameters and constants.
"""

import os
import logging

# ─── Logging ──────────────────────────────────────────────────────────────────
LOG_LEVEL = os.getenv("LOG_LEVEL", "DEBUG")
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s — %(message)s"

logging.basicConfig(level=getattr(logging, LOG_LEVEL), format=LOG_FORMAT)

# ─── Database ─────────────────────────────────────────────────────────────────
DB_CONFIG = {
    "host":     os.getenv("DB_HOST",     "127.0.0.1"),
    "port":     int(os.getenv("DB_PORT", "3306")),
    "user":     os.getenv("DB_USER",     "blueeye"),
    "password": os.getenv("DB_PASSWORD", "secret"),
    "db":       os.getenv("DB_NAME",     "blueeye_db"),
    "autocommit": True,
    "charset":  "utf8mb4",
    "connect_timeout": 10,
}
DB_POOL_MIN  = int(os.getenv("DB_POOL_MIN", "2"))
DB_POOL_MAX  = int(os.getenv("DB_POOL_MAX", "10"))

# ─── Face-recognition thresholds ─────────────────────────────────────────────
LANDMARK_MIN_POINTS   = 10          # Minimum face landmark count (was 25 — killed small/distant faces)
FACE_HEIGHT_MIN_PX    = 20          # Minimum bounding-box height (was 40 — background faces are 25-35px)
RECOGNITION_TOLERANCE    = 0.50     # face_recognition distance threshold — identifies known (enrolled) persons
DEDUP_TOLERANCE          = 0.55     # unknown-person dedup — same person at moderate angles scores 0.30-0.50;
                                    # 0.55 avoids merging clearly-different people (was 0.65 — caused false merges
                                    # in the 0.50-0.65 ambiguous zone where different people can score similarly)
MERGE_TOLERANCE          = 0.10     # 1 - tolerance for 90 % similarity merge

# ─── Scene buffer ─────────────────────────────────────────────────────────────
SCENE_BUFFER_SEC      = 3.0         # Seconds to accumulate frames per subject
INACTIVITY_TIMEOUT_SEC = 2.0        # Flush a tracker after N seconds without detection
MIN_FRAME_COUNT       = 2           # Minimum detections required before persisting a tracker

# ─── Tracking ────────────────────────────────────────────────────────────────
SPATIAL_MERGE_PX      = 120         # Max centroid distance to merge trackers
BIOMETRIC_MERGE_SIM   = 0.50        # Min similarity to merge by encoding (same person different angles scores 0.45-0.65)
SPATIAL_BIOMETRIC_SIM = 0.30        # Looser similarity floor for spatial+biometric combined merge
                                    # (same person frame-to-frame scores ~0.35–0.70, clearly
                                    #  different people score <0.20 even when spatially close)

# ─── Dedup / cooldown ────────────────────────────────────────────────────────
ALERT_COOLDOWN_SEC       = 10       # Seconds before the same encoding can re-alert (short for video loop testing)
SAME_PASSAGE_GAP_SEC     = 3.0     # In-memory dedup: gap (seconds) between tracker events that defines a NEW passage.
ENCODING_DEDUP_WINDOW_SEC = 5      # Short DB encoding-dedup window: suppresses re-alerts after a worker restart.
# CAMERA_DEDUP_WINDOW_SEC removed — replaced by SAME_PASSAGE_GAP_SEC (presence-based, not time-based)

# ─── CV pipeline worker defaults (overridden by DB settings at runtime) ───────
CV_FRAME_QUEUE_SIZE_DEFAULT  = 500  # Bounded frame queue — larger buffer for GPU throughput
CV_DETECTION_WORKERS_DEFAULT = 2    # Reduced to 2 workers to stay within 256-PID cgroup limit on Vast.ai

# ─── Motion clip recording ────────────────────────────────────────────────────
MOTION_CLIP_MAX_FRAMES  = 20   # max frames saved per movement
MOTION_CLIP_EVERY_N     = 2    # save 1 frame every N detections (was 3)
# With frame_analysis_interval=150ms and every_n=2:
# → 1 frame every 300ms → 20 frames = 6 seconds of motion

# ─── Identity reload ──────────────────────────────────────────────────────────
IDENTITY_RELOAD_SEC   = 3           # Reload persons table every N seconds (low enough to catch newly-created unknowns before next detection)
CAMERA_RELOAD_SEC     = 30          # Reload cameras table every N seconds

# ─── RTSP reconnection ────────────────────────────────────────────────────────
RTSP_BACKOFF_INITIAL  = 1.0         # Initial wait in seconds
RTSP_BACKOFF_MAX      = 60.0        # Maximum wait in seconds
RTSP_BACKOFF_FACTOR   = 2.0         # Exponential factor

# ─── Uploads / filesystem ────────────────────────────────────────────────────
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ─── Flask API ────────────────────────────────────────────────────────────────
FLASK_HOST = os.getenv("FLASK_HOST", "0.0.0.0")
FLASK_PORT  = int(os.getenv("FLASK_PORT", "5000"))

# ─── Docker / network helpers ─────────────────────────────────────────────────
HOST_INTERNAL_ALIAS = "host.docker.internal"
