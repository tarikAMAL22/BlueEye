import os

# Database
DB_HOST = os.environ.get("DB_HOST", "db")
DB_USER = os.environ.get("DB_USER", "root")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "my-secret-pw")
DB_NAME = os.environ.get("DB_NAME", "blueeye")

# Paths
UPLOAD_DIR = "/app/client/public/uploads"

# Detection Thresholds
MIN_LANDMARK_POINTS = 25
MIN_FACE_HEIGHT = 40
CONFIDENCE_FLOOR = 40
MATCH_THRESHOLD = 0.5  # distance < 0.5 is a match
BIOMETRIC_COOLDOWN_DISTANCE = 0.60
BIOMETRIC_COOLDOWN_SECONDS = 60

# Alert Grouping
SCENE_BUFFER_SECONDS = 10.0
PERSON_IDLE_SECONDS = 5.0
ALERT_COOLDOWN_SECONDS = 30

# OpenCV Options
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
