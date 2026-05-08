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
LANDMARK_MIN_POINTS   = 25          # Minimum face landmark count
FACE_HEIGHT_MIN_PX    = 40          # Minimum bounding-box height (pixels)
RECOGNITION_TOLERANCE = 0.50        # face_recognition distance threshold
MERGE_TOLERANCE       = 0.10        # 1 - tolerance for 90 % similarity merge

# ─── Scene buffer ─────────────────────────────────────────────────────────────
SCENE_BUFFER_SEC      = 10.0        # Seconds to accumulate frames per subject
INACTIVITY_TIMEOUT_SEC = 5.0        # Flush a tracker after N seconds without detection

# ─── Tracking ────────────────────────────────────────────────────────────────
SPATIAL_MERGE_PX      = 400         # Max centroid distance to merge trackers (px)
BIOMETRIC_MERGE_SIM   = 0.90        # Min similarity to merge by encoding

# ─── Biometric memory (cooldown) ──────────────────────────────────────────────
ALERT_COOLDOWN_SEC    = 60          # Seconds before the same encoding can re-alert

# ─── Identity reload ──────────────────────────────────────────────────────────
IDENTITY_RELOAD_SEC   = 10          # Reload persons table every N seconds
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
