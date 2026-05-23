"""
BlueEye CV Worker — v3.1  (persistent tracking + motion-gated pipeline)
=====================================================================

Architecture per frame:
  1. MOG2 motion detection  -> skip frame entirely if nothing moves
  2. Face detection          -> on full frame when motion detected
  3. Track matching          -> IoU + encoding similarity, per-camera local state
  4. Track lifecycle         -> BUFFERING -> ACTIVE (alert INSERT) -> UPDATING (alert UPDATE) -> DONE
  5. Complete motion log     -> every motion event recorded in `motions` table

Track lifecycle:
  BUFFERING : first N frames, collecting best quality snapshot
  ACTIVE    : alert created in DB, track kept alive while person visible
  UPDATING  : better frame found -> UPDATE alert row (not INSERT)
  DONE      : person gone > LOST_TIMEOUT -> finalize, close track

Key fixes vs v2:
  - No 3-second-flush: tracks live until the person physically disappears
  - enc_hash registered immediately on track creation (no duplicate tracks)
  - curr_box always in scope
  - motion-gated: face_recognition only runs when pixels move
  - multi-person: ALL faces in a motion frame get independent tracks
  - alert UPDATE not INSERT when better frame available
"""

import cv2
import time
import os
import uuid
import pymysql
import pymysql.cursors
import logging
import threading
import numpy as np
import face_recognition
import json
from dataclasses import dataclass, field
from typing import Optional, Tuple, Dict

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s — %(message)s'
)
logger = logging.getLogger("BlueEye-CV")

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

# ── Environment ───────────────────────────────────────────────────────────────
DB_HOST     = os.environ.get("DB_HOST",     "db")
DB_USER     = os.environ.get("DB_USER",     "root")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "my-secret-pw")
DB_NAME     = os.environ.get("DB_NAME",     "blueeye")

USE_CNN_DETECTOR = os.environ.get("USE_CNN_DETECTOR", "true").lower() == "true"
det_model        = "cnn" if USE_CNN_DETECTOR else "hog"

_IS_DOCKER = os.environ.get("CV_WORKER_IN_DOCKER", "false").lower() == "true"
UPLOAD_DIR = (
    "/app/client/public/uploads"
    if _IS_DOCKER
    else os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
)
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ── Tuning constants ──────────────────────────────────────────────────────────
MIN_MOTION_PIXELS     = 300     # ignore micro-movements / sensor noise
BUFFER_FRAMES         = 5       # frames to collect before creating alert
LOST_TIMEOUT          = 3.0     # seconds without detection → track closed
ALERT_UPDATE_INTERVAL = 2.0     # min seconds between DB UPDATEs for same track
BIOMETRIC_COOLDOWN    = 120     # seconds before same face can create NEW track
ENCODING_DISTANCE_THR = 0.50    # face_recognition match threshold
TRACKER_SCORE_THR     = 0.15    # min combined score to link detection to track
MIN_FACE_HEIGHT_PX    = 40      # ignore tiny distant faces
FACE_SCALE            = 0.5     # resize factor before face_recognition
YOLO_CONF_THR         = 0.45    # YOLO person confidence threshold
YOLO_BODY_COOLDOWN    = 90      # seconds before same body zone can re-alert
MIN_BODY_HEIGHT_PX    = 60      # ignore tiny detections (< 60px = too far)

# ── Shared locks ──────────────────────────────────────────────────────────────
face_lock = threading.Lock()
stop_signals: Dict[int, bool] = {}

# Global biometric memory {cam_id: [(encoding, timestamp)]}
biometric_memory: Dict = {}
bio_lock = threading.Lock()

# YOLO body detector — loaded once at startup (lazy, thread-safe)
_yolo_model     = None
_yolo_lock      = threading.Lock()
_yolo_available = True   # set to False on first import failure to suppress retry spam


def get_yolo():
    """Lazy-load YOLOv8n once. Returns model or None if unavailable."""
    global _yolo_model, _yolo_available
    if not _yolo_available:
        return None
    if _yolo_model is not None:
        return _yolo_model
    with _yolo_lock:
        if not _yolo_available:
            return None
        if _yolo_model is not None:
            return _yolo_model
        try:
            from ultralytics import YOLO
            _yolo_model = YOLO("yolov8n.pt")
            _yolo_model.fuse()
            # Move YOLO to GPU if available
            import torch
            if torch.cuda.is_available():
                _yolo_model = _yolo_model.to('cuda')
                logger.info(f"✅ YOLO on GPU: {torch.cuda.get_device_name(0)}")
            else:
                logger.warning("⚠️  YOLO running on CPU — CUDA not available")
            logger.info("YOLO body detector loaded (yolov8n)")
        except Exception as e:
            logger.warning(f"YOLO unavailable: {e} — body-only detection disabled")
            _yolo_available = False
    return _yolo_model


# ══════════════════════════════════════════════════════════════════════════════
# Track dataclass
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class Track:
    track_id:    str
    cam_id:      int
    created_at:  float = field(default_factory=time.time)
    last_seen:   float = field(default_factory=time.time)
    last_box:    Optional[Tuple] = None
    enc_hash:    Optional[tuple] = None
    face_encoding: Optional[np.ndarray] = None
    person_id:   Optional[int]   = None
    confidence:  float           = 0.0
    role:        Optional[str]   = None
    best_quality: float          = 0.0
    face_image:  Optional[np.ndarray] = None
    full_frame:  Optional[np.ndarray] = None
    crop_coords: Optional[Tuple] = None
    alert_id:    Optional[int]   = None
    frame_count: int             = 0
    last_db_update: float        = 0.0
    status:      str             = "BUFFERING"  # BUFFERING | ACTIVE | DONE
    detection_type: str          = "face"       # "face" | "body_only"


# ══════════════════════════════════════════════════════════════════════════════
# DB helpers
# ══════════════════════════════════════════════════════════════════════════════

def get_db_connection():
    while True:
        try:
            return pymysql.connect(
                host=DB_HOST, user=DB_USER,
                password=DB_PASSWORD, database=DB_NAME,
                cursorclass=pymysql.cursors.DictCursor,
                autocommit=False,
                connect_timeout=10,
            )
        except Exception as e:
            logger.warning(f"DB connect failed: {e} — retry in 5s")
            time.sleep(5)


def safe_execute(cursor, conn, query, params=()):
    """Execute with basic error propagation."""
    cursor.execute(query, params)
    return cursor


# ══════════════════════════════════════════════════════════════════════════════
# Image helpers
# ══════════════════════════════════════════════════════════════════════════════

def save_images(face_img: np.ndarray, full_frame: np.ndarray):
    """Save face crop + full frame, return (face_url, frame_url)."""
    uid = str(uuid.uuid4())
    face_path  = os.path.join(UPLOAD_DIR, f"face_{uid}.jpg")
    frame_path = os.path.join(UPLOAD_DIR, f"frame_{uid}.jpg")
    # Face: maximum quality (95) — no aggressive compression
    cv2.imwrite(face_path,  face_img,   [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    # Full frame: 85 acceptable (larger image, less critical)
    cv2.imwrite(frame_path, full_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    return f"/uploads/face_{uid}.jpg", f"/uploads/frame_{uid}.jpg"


def is_frame_corrupted(frame: np.ndarray) -> bool:
    """Return True if frame is blank or unusable."""
    if frame is None or frame.size == 0:
        return True
    return frame.mean() < 1.0


# Super-resolution upscaler — loaded once, optional
_sr_model = None
_sr_lock  = threading.Lock()


def get_sr_model():
    """
    Lazy-load OpenCV DNN super-resolution (EDSR x2).
    Returns model or None if unavailable.
    Model file auto-downloaded if missing.
    """
    global _sr_model
    if _sr_model is not None:
        return _sr_model
    with _sr_lock:
        if _sr_model is not None:
            return _sr_model
        try:
            from cv2 import dnn_superres
            sr = dnn_superres.DnnSuperResImpl_create()
            model_path = "/app/EDSR_x2.pb"
            if not os.path.exists(model_path):
                # Download EDSR x2 model (~38MB)
                import urllib.request
                url = "https://github.com/Saafke/EDSR_Tensorflow/raw/master/models/EDSR_x2.pb"
                logger.info("Downloading EDSR super-res model...")
                urllib.request.urlretrieve(url, model_path)
            sr.readModel(model_path)
            sr.setModel("edsr", 2)
            _sr_model = sr
            logger.info("✅ Super-resolution model loaded (EDSR x2)")
        except Exception as e:
            logger.warning(f"Super-res unavailable: {e} — using standard resize")
            _sr_model = None
    return _sr_model


def upscale_face(img: np.ndarray) -> np.ndarray:
    """Never upscale more than 1.5× — pixelation is worse than a small image."""
    h, w = img.shape[:2]
    if h >= 80 and w >= 80:
        return img   # good enough — no upscale
    # Very small face (< 80px): max 1.5× only
    scale = min(1.5, 80 / max(h, w, 1))
    if scale > 1.05:
        return cv2.resize(img, (int(w * scale), int(h * scale)),
                          interpolation=cv2.INTER_LANCZOS4)
    return img


def frame_quality(crop: np.ndarray, bbox: Tuple, frame_shape: Tuple) -> float:
    """Sharpness (center 50%) × frontal score × relative size."""
    f_top, f_right, f_bottom, f_left = bbox
    h_frame, w_frame = frame_shape[:2]
    h_crop, w_crop = crop.shape[:2]
    cy0, cy1 = h_crop // 4, 3 * h_crop // 4
    cx0, cx1 = w_crop // 4, 3 * w_crop // 4
    center_region = crop[cy0:cy1, cx0:cx1]
    if center_region.size == 0:
        center_region = crop
    gray      = cv2.cvtColor(center_region, cv2.COLOR_BGR2GRAY)
    sharpness = cv2.Laplacian(gray, cv2.CV_64F).var()
    face_cx  = (f_left + f_right) / 2
    face_cy  = (f_top  + f_bottom) / 2
    dx_norm  = abs(face_cx - w_frame / 2) / max(w_frame / 2, 1)
    dy_norm  = abs(face_cy - h_frame / 2) / max(h_frame / 2, 1)
    frontal  = 1.0 - 0.2 * dx_norm - 0.1 * dy_norm
    size_norm = ((f_bottom - f_top) * (f_right - f_left)) / max(w_frame * h_frame, 1)
    return sharpness * frontal * (1.0 + size_norm * 3.0)


def compute_iou(a: Tuple, b: Tuple) -> float:
    """IoU of two (top,right,bottom,left) boxes."""
    aT, aR, aB, aL = a
    bT, bR, bB, bL = b
    iT = max(aT, bT); iL = max(aL, bL)
    iB = min(aB, bB); iR = min(aR, bR)
    inter = max(0, iB - iT) * max(0, iR - iL)
    if inter == 0:
        return 0.0
    return inter / ((aB - aT) * (aR - aL) + (bB - bT) * (bR - bL) - inter)


def detect_bodies_yolo(frame: np.ndarray, existing_face_boxes: list) -> list:
    """
    Run YOLO person detection on frame.
    Returns body bboxes (top, right, bottom, left) that do NOT overlap
    with already-detected face bboxes (IoU < 0.3) — bodies missed by face_recognition.
    """
    yolo = get_yolo()
    if yolo is None:
        return []

    try:
        results = yolo(frame, classes=[0], verbose=False)[0]
    except Exception as e:
        logger.debug(f"YOLO inference error: {e}")
        return []

    new_bodies = []
    for box in results.boxes:
        conf = float(box.conf[0])
        if conf < YOLO_CONF_THR:
            continue

        x1, y1, x2, y2 = map(int, box.xyxy[0])
        body_h = y2 - y1
        if body_h < MIN_BODY_HEIGHT_PX:
            continue

        body_bbox = (y1, x2, y2, x1)

        overlaps_face = False
        b_t, b_r, b_b, b_l = body_bbox
        body_h = b_b - b_t

        for face_bbox in existing_face_boxes:
            f_t, f_r, f_b, f_l = face_bbox
            # Face center point
            face_cx = (f_l + f_r) / 2
            face_cy = (f_t + f_b) / 2
            # Tolerance: 15% of body height on each side
            tol_x = max(20, int((b_r - b_l) * 0.15))
            tol_y = max(20, int(body_h * 0.15))
            # Is face center inside body bbox (with tolerance)?
            if (b_l - tol_x <= face_cx <= b_r + tol_x and
                    b_t - tol_y <= face_cy <= b_b + tol_y):
                overlaps_face = True
                break
            # Edge case: face top is in the upper 40% of body
            # (person very close, face bbox top above body bbox top)
            if body_h > 0:
                rel = (f_t - b_t) / body_h
                if -0.2 <= rel <= 0.40 and (b_l - tol_x <= face_cx <= b_r + tol_x):
                    overlaps_face = True
                    break

        if not overlaps_face:
            new_bodies.append((body_bbox, conf))

    return new_bodies


# ══════════════════════════════════════════════════════════════════════════════
# FaceMatcher
# ══════════════════════════════════════════════════════════════════════════════

class FaceMatcher:
    def __init__(self):
        self._encs:  list = []
        self._ids:   list = []
        self._roles: list = []
        self._t:     float = 0.0
        self._lock = threading.Lock()

    def load(self):
        if time.time() - self._t < 30:
            return
        conn = get_db_connection()
        cur  = conn.cursor()
        cur.execute("SELECT id, role, faceEncoding FROM persons WHERE faceEncoding IS NOT NULL")
        rows = cur.fetchall()
        cur.close(); conn.close()
        with self._lock:
            self._encs  = [np.array(json.loads(r['faceEncoding'])) for r in rows]
            self._ids   = [r['id']   for r in rows]
            self._roles = [r['role'] for r in rows]
            self._t     = time.time()
        logger.info(f"FaceMatcher: loaded {len(self._encs)} known faces")

    def match(self, encoding: np.ndarray):
        """Returns (person_id, confidence_pct, role) or (None, conf, None)."""
        with self._lock:
            if not self._encs:
                return None, 0.0, None
            dists = face_recognition.face_distance(self._encs, encoding)
            idx   = int(np.argmin(dists))
            conf  = round((1.0 - float(dists[idx])) * 100, 2)
            if dists[idx] < ENCODING_DISTANCE_THR:
                return self._ids[idx], conf, self._roles[idx]
            return None, conf, None


class UnknownMatcher:
    """
    Matches new face encodings against UNKNOWN persons already seen
    on the same camera within the last UNKNOWN_MATCH_WINDOW seconds.
    Prevents creating duplicate person records for the same individual.

    Loaded per-camera, refreshed every 30 seconds.
    """
    UNKNOWN_MATCH_WINDOW = 3600   # 1 hour look-back for same-camera unknowns
    UNKNOWN_MATCH_THR    = 0.45   # stricter than FaceMatcher (0.50) to avoid false merges

    def __init__(self, cam_id: int):
        self.cam_id     = cam_id
        self._encs:  list = []
        self._ids:   list = []
        self._names: list = []
        self._t:     float = 0.0
        self._lock   = threading.Lock()

    def load(self, conn, cursor):
        """Refresh from DB every 30s."""
        if time.time() - self._t < 30:
            return
        try:
            since = time.strftime(
                '%Y-%m-%d %H:%M:%S',
                time.localtime(time.time() - self.UNKNOWN_MATCH_WINDOW)
            )
            safe_execute(cursor, conn, """
                SELECT DISTINCT p.id, p.name, p.faceEncoding
                FROM persons p
                JOIN alerts a ON a.personId = p.id
                WHERE p.role = 'UNKNOWN'
                  AND p.faceEncoding IS NOT NULL
                  AND a.cameraId = %s
                  AND a.createdAt >= %s
                ORDER BY p.id DESC
                LIMIT 500
            """, (self.cam_id, since))
            rows = cursor.fetchall()
            with self._lock:
                self._encs  = [np.array(json.loads(r['faceEncoding'])) for r in rows]
                self._ids   = [r['id']   for r in rows]
                self._names = [r['name'] for r in rows]
                self._t     = time.time()
            if rows:
                logger.debug(
                    f"UnknownMatcher cam={self.cam_id}: "
                    f"loaded {len(rows)} unknown persons"
                )
        except Exception as e:
            logger.warning(f"UnknownMatcher load failed: {e}")

    def find_match(self, encoding: np.ndarray):
        """Returns (person_id, name) if a similar unknown was seen recently, else (None, None)."""
        with self._lock:
            if not self._encs:
                return None, None
            dists = face_recognition.face_distance(self._encs, encoding)
            idx   = int(np.argmin(dists))
            if dists[idx] < self.UNKNOWN_MATCH_THR:
                return self._ids[idx], self._names[idx]
            return None, None

    def add(self, person_id: int, name: str, encoding: np.ndarray):
        """Add a newly created person to the in-memory index immediately."""
        with self._lock:
            self._ids.append(person_id)
            self._names.append(name)
            self._encs.append(encoding)


# ══════════════════════════════════════════════════════════════════════════════
# DB writers (INSERT first alert / UPDATE with better frame)
# ══════════════════════════════════════════════════════════════════════════════

def _validate_face_image(face_image: np.ndarray) -> bool:
    """Fix 2: verify the crop actually contains a detectable face before writing to DB."""
    if face_image is None or face_image.size == 0:
        return False
    try:
        rgb = cv2.cvtColor(face_image, cv2.COLOR_BGR2RGB)
        with face_lock:
            locs = face_recognition.face_locations(rgb, model='hog',
                                                   number_of_times_to_upsample=1)
        return len(locs) > 0
    except Exception:
        return False


def create_alert(track: Track, cam: dict, cursor, conn, unknown_matcher=None):
    """INSERT a new alert row for this track. Sets track.alert_id."""
    if track.detection_type == 'body_only':
        _create_body_alert(track, cam, cursor, conn, unknown_matcher)
        return

    if track.face_image is None or track.face_encoding is None:
        return

    if not _validate_face_image(track.face_image):
        logger.warning(f"create_alert: no face in crop for track {track.track_id} — skipping")
        return

    face_url, frame_url = save_images(track.face_image, track.full_frame)

    cam_id  = cam.get('id')
    zone_id = cam.get('zoneId', 1)
    threat  = 'high' if track.role == 'UNKNOWN' else 'medium'
    ev_type = 'recognition' if (track.role and track.role != 'UNKNOWN') else 'unknown'

    # ── Ensure person exists — check UnknownMatcher FIRST ─────────────────────
    if not track.person_id:
        if unknown_matcher is not None:
            unknown_matcher.load(conn, cursor)
            existing_id, existing_name = unknown_matcher.find_match(track.face_encoding)
            if existing_id:
                track.person_id = existing_id
                track.role      = 'UNKNOWN'
                logger.info(
                    f"Track {track.track_id}: matched existing unknown "
                    f"'{existing_name}' (pid={existing_id}) — no new person created"
                )

    if not track.person_id:
        # Truly new person — create record
        try:
            uid      = str(uuid.uuid4())
            name     = f"unknown-{uid[:8]}"
            enc_json = json.dumps(track.face_encoding.tolist())
            safe_execute(cursor, conn,
                "INSERT INTO persons (name, role, photoUrl, faceEncoding) VALUES (%s,'UNKNOWN',%s,%s)",
                (name, face_url, enc_json)
            )
            track.person_id = cursor.lastrowid
            track.role      = 'UNKNOWN'
            conn.commit()
            if unknown_matcher is not None:
                unknown_matcher.add(track.person_id, name, track.face_encoding)
            logger.info(f"NEW unknown person created: '{name}' (pid={track.person_id})")
        except Exception as e:
            logger.error(f"Insert person failed: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            return

    person_id = track.person_id

    try:
        safe_execute(cursor, conn, """
            INSERT INTO alerts
              (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl,
               confidence, status, threatLevel, detectionType)
            VALUES (%s, %s, %s, %s, %s, %s, 'active', %s, 'FACE')
        """, (person_id, cam_id, zone_id, face_url, frame_url, track.confidence, threat))
        track.alert_id       = cursor.lastrowid
        track.last_db_update = time.time()
        conn.commit()

        safe_execute(cursor, conn, """
            INSERT INTO events
              (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl,
               confidence, eventType)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (person_id, cam_id, zone_id, face_url, frame_url, track.confidence, ev_type))
        conn.commit()

        logger.info(
            f"ALERT #{track.alert_id} CREATED — "
            f"{track.role}({person_id}) cam={cam.get('name')} conf={track.confidence:.1f}%"
        )
        track.status = 'ACTIVE'

    except Exception as e:
        logger.error(f"Alert INSERT failed: {e}")
        try:
            conn.rollback()
        except Exception:
            pass


def update_alert(track: Track, cam: dict, cursor, conn):
    """UPDATE existing alert with better frame + higher confidence.
    Fix 3: also updates persons.photoUrl so the profile stays in sync.
    """
    if not track.alert_id:
        return
    now = time.time()
    if now - track.last_db_update < ALERT_UPDATE_INTERVAL:
        return

    # Fix 2: validate crop before writing
    if not _validate_face_image(track.face_image):
        return

    face_url, frame_url = save_images(track.face_image, track.full_frame)
    threat = 'high' if track.role == 'UNKNOWN' else 'medium'

    try:
        safe_execute(cursor, conn, """
            UPDATE alerts
               SET faceSnapshotUrl=%s, bestFrameSnapshotUrl=%s,
                   confidence=%s, threatLevel=%s
             WHERE id=%s
        """, (face_url, frame_url, track.confidence, threat, track.alert_id))
        conn.commit()

        # Fix 3: keep persons.photoUrl in sync with the best face crop
        if track.person_id and track.role == 'UNKNOWN':
            safe_execute(cursor, conn,
                "UPDATE persons SET photoUrl=%s WHERE id=%s AND role='UNKNOWN'",
                (face_url, track.person_id)
            )
            conn.commit()

        track.last_db_update = now
        logger.debug(f"ALERT #{track.alert_id} UPDATED conf={track.confidence:.1f}%")
    except Exception as e:
        logger.error(f"Alert UPDATE failed: {e}")
        try:
            conn.rollback()
        except Exception:
            pass


def _validate_body_image(body_img: np.ndarray) -> bool:
    """Basic validation for body crops — does NOT require a face."""
    if body_img is None or body_img.size == 0:
        return False
    if is_frame_corrupted(body_img):
        return False
    h, w = body_img.shape[:2]
    return h >= 30 and w >= 20


def _create_body_alert(track: Track, cam: dict, cursor, conn, unknown_matcher=None):
    """
    Called ONLY for tracks where face_recognition found NO face.
    If a face track exists for the same person, Fix 2 prevents reaching here.
    """
    if track.detection_type != 'body_only':
        logger.warning(f"_create_body_alert called on non-body track {track.track_id} — skip")
        return

    if not _validate_body_image(track.face_image):
        logger.warning(f"Body track {track.track_id}: invalid body image — skipping")
        return

    face_url, frame_url = save_images(track.face_image, track.full_frame)
    cam_id  = cam.get('id')
    zone_id = cam.get('zoneId', 1)

    try:
        uid  = str(uuid.uuid4())
        name = f"body-only-{uid[:8]}"
        safe_execute(cursor, conn,
            "INSERT INTO persons (name, role, photoUrl, faceEncoding) "
            "VALUES (%s,'UNKNOWN',%s,NULL)",
            (name, face_url)
        )
        track.person_id = cursor.lastrowid
        track.role      = 'UNKNOWN'
        conn.commit()
    except Exception as e:
        logger.error(f"Body person insert failed: {e}")
        conn.rollback()
        return

    try:
        safe_execute(cursor, conn, """
            INSERT INTO alerts
              (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl,
               confidence, status, threatLevel, detectionType)
            VALUES (%s,%s,%s,%s,%s,%s,'active','high','NO_FACE')
        """, (track.person_id, cam_id, zone_id, face_url, frame_url, track.confidence))
        track.alert_id       = cursor.lastrowid
        track.last_db_update = time.time()
        conn.commit()

        safe_execute(cursor, conn, """
            INSERT INTO events
              (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl,
               confidence, eventType)
            VALUES (%s,%s,%s,%s,%s,%s,'body_detected')
        """, (track.person_id, cam_id, zone_id, face_url, frame_url, track.confidence))
        conn.commit()

        logger.info(
            f"BODY ALERT #{track.alert_id} CREATED — "
            f"pid={track.person_id} cam={cam.get('name')} "
            f"conf={track.confidence:.1f}%"
        )
        track.status = 'ACTIVE'

    except Exception as e:
        logger.error(f"Body alert INSERT failed: {e}")
        conn.rollback()


def log_motion_event(cam_id: int, zone_id: int, frame: np.ndarray,
                     motion_area: int, n_persons: int, cursor, conn):
    """Record every motion event with a snapshot (if motions table exists)."""
    try:
        uid        = str(uuid.uuid4())
        frame_path = os.path.join(UPLOAD_DIR, f"motion_{uid}.jpg")
        cv2.imwrite(frame_path, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        frame_url  = f"/uploads/motion_{uid}.jpg"
        safe_execute(cursor, conn, """
            INSERT IGNORE INTO motions
              (cameraId, zoneId, frameSnapshotUrl, motionArea, personsDetected, detectedAt)
            VALUES (%s, %s, %s, %s, %s, NOW())
        """, (cam_id, zone_id, frame_url, motion_area, n_persons))
        conn.commit()
    except Exception:
        pass  # motions table may not exist yet


# ══════════════════════════════════════════════════════════════════════════════
# Core: match detections → existing tracks
# ══════════════════════════════════════════════════════════════════════════════

def match_detection_to_tracks(
    tracks:   Dict[str, Track],
    bbox:     Tuple,
    encoding: np.ndarray,
    enc_hash: tuple,
    cam_id:   int
) -> Optional[str]:
    """
    Return track_id of best matching active track, or None.
    Three-pass strategy:
      1. Exact enc_hash match (same face, moved far)
      2. IoU + encoding similarity score >= TRACKER_SCORE_THR
      3. Encoding-only match (person turned, different angle)
    """
    # Pass 1: exact hash
    for tid, t in tracks.items():
        if t.cam_id == cam_id and t.enc_hash == enc_hash:
            return tid

    # Pass 2: IoU + encoding score
    best_tid   = None
    best_score = 0.0
    for tid, t in tracks.items():
        if t.cam_id != cam_id or t.status == 'DONE':
            continue
        iou     = compute_iou(bbox, t.last_box) if t.last_box else 0.0
        enc_sim = 0.0
        if t.face_encoding is not None:
            d       = float(face_recognition.face_distance([t.face_encoding], encoding)[0])
            enc_sim = max(0.0, 1.0 - d)
        score = 0.4 * iou + 0.6 * enc_sim
        if score > TRACKER_SCORE_THR and score > best_score:
            best_score = score
            best_tid   = tid

    if best_tid:
        return best_tid

    # Pass 3: pure encoding (person turned away then turned back)
    for tid, t in tracks.items():
        if t.cam_id != cam_id or t.status == 'DONE' or t.face_encoding is None:
            continue
        d = float(face_recognition.face_distance([t.face_encoding], encoding)[0])
        if d < ENCODING_DISTANCE_THR:
            return tid

    return None


# ══════════════════════════════════════════════════════════════════════════════
# Track refresh helper
# ══════════════════════════════════════════════════════════════════════════════

def _refresh_track(
    track:    Track,
    bbox:     Tuple,
    encoding: np.ndarray,
    frame:    np.ndarray,
    h_f: int, w_f: int,
    matcher:  FaceMatcher,
    now:      float
):
    """Update track with latest detection. Keep best-quality frame."""
    f_top, f_right, f_bottom, f_left = bbox
    track.last_seen    = now
    track.last_box     = bbox
    track.frame_count += 1

    # Face match (refresh every detection)
    person_id, confidence, role = matcher.match(encoding)
    prev_confidence = track.confidence   # capture BEFORE any update (Fix 4)

    if person_id and (not track.person_id or confidence > prev_confidence):
        track.person_id  = person_id
        track.confidence = confidence
        track.role       = role
    elif not track.person_id:
        track.confidence = max(prev_confidence, confidence)

    # Keep encoding from best-confidence detection angle
    if track.face_encoding is None or confidence > prev_confidence:
        track.face_encoding = encoding

    # Crop candidate — centered symmetric square
    face_h = f_bottom - f_top
    face_w = f_right  - f_left
    cx     = (f_left + f_right)  // 2
    cy     = (f_top  + f_bottom) // 2
    cy_adj = cy - int(face_h * 0.10)
    half   = int(max(face_h, face_w) * 0.90)
    ct = max(0,   cy_adj - half)
    cb = min(h_f, cy_adj + half)
    cl = max(0,   cx     - half)
    cr = min(w_f, cx     + half)
    crop = frame[ct:cb, cl:cr]
    if crop.size == 0:
        return

    quality = frame_quality(crop, bbox, frame.shape)
    if quality > track.best_quality:
        face_img = crop.copy()
        # Save at natural crop resolution — never upscale (upscaling creates pixelation).
        # Downscale only if crop is abnormally large (> 800px).
        h_img, w_img = face_img.shape[:2]
        if h_img > 800 or w_img > 800:
            scale = 800 / max(h_img, w_img)
            face_img = cv2.resize(
                face_img,
                (int(w_img * scale), int(h_img * scale)),
                interpolation=cv2.INTER_AREA,
            )
        track.best_quality = quality
        track.face_image   = face_img
        track.full_frame   = frame.copy()
        track.crop_coords  = (ct, cb, cl, cr)


# ══════════════════════════════════════════════════════════════════════════════
# Camera worker
# ══════════════════════════════════════════════════════════════════════════════

def process_camera(cam: dict, matcher: FaceMatcher):
    """
    One thread per camera.
    All state (tracks, motion detector, encoding_cooldowns) is LOCAL.
    """
    global biometric_memory

    cam_id   = cam.get('id')
    cam_name = cam.get('name', f'cam-{cam_id}')
    zone_id  = cam.get('zoneId', 1)
    backend_url = (cam.get('rtspUrl') or cam.get('backendUrl') or cam.get('url'))

    if not backend_url:
        logger.error(f"[{cam_name}] No URL — skipping.")
        return

    if _IS_DOCKER:
        for old, new in [("localhost", "host.docker.internal"),
                         ("127.0.0.1", "host.docker.internal")]:
            backend_url = backend_url.replace(old, new)

    conn   = get_db_connection()
    cursor = conn.cursor()

    # ── Local state ────────────────────────────────────────────────────────────
    tracks:             Dict[str, Track] = {}
    encoding_cooldowns: Dict[tuple, float] = {}

    # Per-camera unknown person matcher — prevents duplicate person records
    unknown_matcher = UnknownMatcher(cam_id)

    bg_sub = cv2.createBackgroundSubtractorMOG2(
        history=200, varThreshold=16, detectShadows=False
    )

    cap                  = None
    frame_count          = 0
    last_motion_log_time = 0.0   # throttle: one motion snapshot every 5s

    try:
        while not stop_signals.get(cam_id):

            # ── Reconnect ──────────────────────────────────────────────────────
            if cap is None or not cap.isOpened():
                logger.info(f"[{cam_name}] Connecting …")
                cap = cv2.VideoCapture(backend_url)
                if not cap.isOpened():
                    time.sleep(5)
                    continue
                try:
                    safe_execute(cursor, conn,
                        "UPDATE cameras SET status='online', lastSeen=NOW() WHERE id=%s",
                        (cam_id,)
                    )
                    conn.commit()
                except Exception as e:
                    logger.error(f"[{cam_name}] DB online update: {e}")

            ret, frame = cap.read()
            if not ret:
                cap.release(); cap = None
                time.sleep(2)
                continue

            frame_count += 1
            now = time.time()

            # Refresh unknown matcher every ~30s (at 30fps ≈ 900 frames)
            if frame_count % 900 == 1:
                unknown_matcher.load(conn, cursor)

            # ════════════════════════════════════════════════════════════════
            # LAYER 1 — Motion detection (every frame, very fast)
            # ════════════════════════════════════════════════════════════════
            fg_mask    = bg_sub.apply(frame)
            motion_pix = int(np.count_nonzero(fg_mask))

            motion_detected       = motion_pix >= MIN_MOTION_PIXELS
            detections_this_frame = 0

            if motion_detected:
                # Log every motion event (with or without face) — throttled 5s
                if now - last_motion_log_time >= 5.0:
                    log_motion_event(cam_id, zone_id, frame, motion_pix, 0, cursor, conn)
                    last_motion_log_time = now

                # ════════════════════════════════════════════════════════════
                # LAYER 2 — Face detection (only when pixels moved)
                # ════════════════════════════════════════════════════════════
                small  = cv2.resize(frame, (0, 0), fx=FACE_SCALE, fy=FACE_SCALE)
                rgb_sm = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)

                with face_lock:
                    face_locs = face_recognition.face_locations(rgb_sm, model=det_model)

                if face_locs and len(face_locs) < 15:
                    with face_lock:
                        face_encs = face_recognition.face_encodings(rgb_sm, face_locs)
                        landmarks = face_recognition.face_landmarks(rgb_sm, face_locs)

                    h_f, w_f  = frame.shape[:2]
                    scale_inv = 1.0 / FACE_SCALE

                    # ════════════════════════════════════════════════════════
                    # LAYER 3 — Per-face tracking
                    # ════════════════════════════════════════════════════════
                    for box_sm, encoding, landmark in zip(face_locs, face_encs, landmarks):

                        # Anatomy filter
                        n_pts = sum(len(v) for v in landmark.values())
                        if n_pts < 35:
                            continue
                        if not all(k in landmark for k in
                                   ['left_eye', 'right_eye', 'nose_bridge', 'top_lip']):
                            continue

                        # Scale bbox to full resolution
                        f_top    = int(box_sm[0] * scale_inv)
                        f_right  = int(box_sm[1] * scale_inv)
                        f_bottom = int(box_sm[2] * scale_inv)
                        f_left   = int(box_sm[3] * scale_inv)

                        if (f_bottom - f_top) < MIN_FACE_HEIGHT_PX:
                            continue

                        bbox     = (f_top, f_right, f_bottom, f_left)
                        enc_hash = tuple(np.round(encoding[:16], 1))

                        # ── Biometric cooldown (global, cross-restart) ─────────
                        is_recent = False
                        with bio_lock:
                            entries = biometric_memory.get(cam_id, [])
                            entries = [m for m in entries if now - m[1] < BIOMETRIC_COOLDOWN]
                            biometric_memory[cam_id] = entries
                            if entries:
                                dists = face_recognition.face_distance(
                                    [m[0] for m in entries], encoding
                                )
                                if any(d < 0.45 for d in dists):
                                    is_recent = True
                        if is_recent:
                            continue

                        # ── Per-session encoding cooldown ──────────────────────
                        if enc_hash in encoding_cooldowns:
                            elapsed = now - encoding_cooldowns[enc_hash]
                            if elapsed < BIOMETRIC_COOLDOWN:
                                # Still within cooldown — still UPDATE existing active track
                                tid = match_detection_to_tracks(
                                    tracks, bbox, encoding, enc_hash, cam_id
                                )
                                if tid and tracks[tid].status == 'ACTIVE':
                                    _refresh_track(
                                        tracks[tid], bbox, encoding,
                                        frame, h_f, w_f, matcher, now
                                    )
                                    if tracks[tid].alert_id:
                                        update_alert(tracks[tid], cam, cursor, conn)
                                continue

                        # ── Match to existing track or create new ──────────────
                        tid = match_detection_to_tracks(
                            tracks, bbox, encoding, enc_hash, cam_id
                        )

                        # ── Upgrade body_only track if face now visible ────────
                        if tid and tracks[tid].detection_type == 'body_only':
                            tracks[tid].detection_type = 'face'
                            tracks[tid].enc_hash       = enc_hash
                            tracks[tid].face_encoding  = encoding
                            logger.info(f"[{cam_name}] Track {tid} UPGRADED body_only → face")

                            # Merge: if a separate face track already exists for same encoding,
                            # close it and transfer its alert_id to the upgraded track
                            for other_tid in list(tracks.keys()):
                                if other_tid == tid:
                                    continue
                                ot = tracks[other_tid]
                                if (ot.cam_id == cam_id
                                        and ot.detection_type == 'face'
                                        and ot.enc_hash == enc_hash
                                        and ot.status != 'DONE'):
                                    if ot.alert_id and not tracks[tid].alert_id:
                                        tracks[tid].alert_id  = ot.alert_id
                                        tracks[tid].person_id = ot.person_id
                                        tracks[tid].role      = ot.role
                                        tracks[tid].confidence = max(
                                            tracks[tid].confidence, ot.confidence
                                        )
                                    ot.status = 'DONE'
                                    logger.info(
                                        f"[{cam_name}] Closed duplicate face track "
                                        f"{other_tid} → merged into {tid}"
                                    )
                                    break

                        if tid:
                            track = tracks[tid]
                        else:
                            new_id = f"trk_{uuid.uuid4().hex[:8]}"
                            track  = Track(
                                track_id = new_id,
                                cam_id   = cam_id,
                                enc_hash = enc_hash,
                            )
                            tracks[new_id] = track
                            encoding_cooldowns[enc_hash] = now  # prevent duplicate tracks
                            logger.info(f"[{cam_name}] NEW track {new_id}")

                        # ── Refresh track state ────────────────────────────────
                        _refresh_track(
                            track, bbox, encoding,
                            frame, h_f, w_f, matcher, now
                        )
                        detections_this_frame += 1

                        # ── Promote BUFFERING → ACTIVE after N frames ──────────
                        if (track.status == 'BUFFERING'
                                and track.frame_count >= BUFFER_FRAMES
                                and track.face_image is not None):
                            create_alert(track, cam, cursor, conn, unknown_matcher)

                        # ── UPDATE existing active alert with better frame ──────
                        elif track.status == 'ACTIVE' and track.alert_id:
                            update_alert(track, cam, cursor, conn)

                    # ════════════════════════════════════════════════════════
                    # LAYER 2b — YOLO body detection
                    # Catches people missed by face_recognition:
                    # backs turned, profiles, distant, low-light
                    # ════════════════════════════════════════════════════════
                    face_boxes_found = [
                        (int(b[0] * scale_inv), int(b[1] * scale_inv),
                         int(b[2] * scale_inv), int(b[3] * scale_inv))
                        for b in face_locs
                    ]

                    body_detections = detect_bodies_yolo(frame, face_boxes_found)

                    for body_bbox, body_conf in body_detections:
                        b_top, b_right, b_bottom, b_left = body_bbox
                        body_h  = b_bottom - b_top
                        body_cx = (b_left + b_right) // 2

                        body_hash = (cam_id, body_cx // 50, b_top // 50)

                        if body_hash in encoding_cooldowns:
                            if now - encoding_cooldowns[body_hash] < YOLO_BODY_COOLDOWN:
                                for _btid, _bt in tracks.items():
                                    if _bt.cam_id == cam_id and _bt.detection_type == 'body_only':
                                        if _bt.last_box and compute_iou(body_bbox, _bt.last_box) > 0.10:
                                            _bt.last_seen = now
                                            _bt.last_box  = body_bbox
                                            break
                                continue

                        # Find existing track (face OR body) covering this body bbox.
                        # Point-in-box for face tracks; IoU for body tracks.
                        found_body_track = None
                        b_t2, b_r2, b_b2, b_l2 = body_bbox
                        bh2 = b_b2 - b_t2

                        for tid, t in list(tracks.items()):
                            if t.cam_id != cam_id or t.status == 'DONE':
                                continue
                            if t.last_box is None:
                                continue

                            t_t, t_r, t_b, t_l = t.last_box

                            if t.detection_type == 'face':
                                # Face track: check face center inside body bbox
                                fc_x = (t_l + t_r) / 2
                                fc_y = (t_t + t_b) / 2
                                tol  = max(25, int(bh2 * 0.15))
                                in_x = b_l2 - tol <= fc_x <= b_r2 + tol
                                in_y = b_t2 - tol <= fc_y <= b_b2 + tol
                                # Also check relative position (face in top 40% of body)
                                rel_y = (t_t - b_t2) / bh2 if bh2 > 0 else 1.0
                                if (in_x and in_y) or (in_x and -0.2 <= rel_y <= 0.40):
                                    found_body_track = tid
                                    break
                            else:
                                # Body track: standard IoU is fine (same bbox type)
                                if compute_iou(body_bbox, t.last_box) > 0.15:
                                    found_body_track = tid
                                    break

                        # If matched a FACE track → this person already handled → skip
                        if found_body_track and tracks[found_body_track].detection_type == 'face':
                            continue

                        if found_body_track:
                            body_track = tracks[found_body_track]
                            body_track.last_seen   = now
                            body_track.last_box    = body_bbox
                            body_track.frame_count += 1
                        else:
                            new_id = f"body_{uuid.uuid4().hex[:8]}"
                            body_track = Track(
                                track_id       = new_id,
                                cam_id         = cam_id,
                                enc_hash       = None,
                                detection_type = 'body_only',
                            )
                            body_track.last_box   = body_bbox
                            body_track.confidence = round(body_conf * 100, 2)
                            tracks[new_id] = body_track
                            encoding_cooldowns[body_hash] = now
                            logger.info(
                                f"[{cam_name}] NEW body_only track {new_id} "
                                f"conf={body_conf:.2f} h={body_h}px"
                            )

                        h_f2, w_f2 = frame.shape[:2]
                        pad_b = int(body_h * 0.05)
                        bt = max(0,    b_top    - pad_b)
                        bb = min(h_f2, b_bottom + pad_b)
                        bl = max(0,    b_left   - pad_b)
                        br = min(w_f2, b_right  + pad_b)
                        body_crop = frame[bt:bb, bl:br]

                        if body_crop.size > 0 and not is_frame_corrupted(frame):
                            body_img = body_crop.copy()
                            h_b, w_b = body_img.shape[:2]
                            if h_b > 800 or w_b > 800:
                                scale = 800 / max(h_b, w_b)
                                body_img = cv2.resize(
                                    body_img,
                                    (int(w_b * scale), int(h_b * scale)),
                                    interpolation=cv2.INTER_AREA,
                                )
                            body_area = (b_bottom - b_top) * (b_right - b_left)
                            if body_area > body_track.best_quality:
                                body_track.best_quality = float(body_area)
                                body_track.face_image   = body_img
                                body_track.full_frame   = frame.copy()
                                body_track.crop_coords  = (bt, bb, bl, br)

                        if (body_track.status == 'BUFFERING'
                                and body_track.frame_count >= BUFFER_FRAMES
                                and body_track.face_image is not None):
                            _create_body_alert(body_track, cam, cursor, conn, unknown_matcher)

            # ════════════════════════════════════════════════════════════════
            # LAYER 4 — Close LOST tracks (runs every frame)
            # ════════════════════════════════════════════════════════════════
            for tid in list(tracks.keys()):
                track = tracks[tid]
                if track.status == 'DONE':
                    del tracks[tid]
                    continue

                idle = now - track.last_seen
                if idle < LOST_TIMEOUT:
                    continue

                # Person gone — finalize
                logger.info(
                    f"[{cam_name}] Track {tid} LOST "
                    f"(idle={idle:.1f}s frames={track.frame_count})"
                )

                if track.status == 'BUFFERING' and track.face_image is not None:
                    # Left before BUFFER_FRAMES — create alert anyway
                    create_alert(track, cam, cursor, conn)

                if track.alert_id:
                    track.last_db_update = 0  # force final UPDATE
                    update_alert(track, cam, cursor, conn)
                    try:
                        safe_execute(cursor, conn,
                            "UPDATE alerts SET status='completed' WHERE id=%s",
                            (track.alert_id,)
                        )
                        conn.commit()
                    except Exception as e:
                        logger.error(f"Alert complete update: {e}")

                if track.face_encoding is not None:
                    with bio_lock:
                        biometric_memory.setdefault(cam_id, [])
                        biometric_memory[cam_id].append((track.face_encoding, now))

                track.status = 'DONE'
                del tracks[tid]

            # Heartbeat log
            if frame_count % 200 == 0:
                active = sum(1 for t in tracks.values() if t.status != 'DONE')
                logger.info(
                    f"[{cam_name}] frame={frame_count} "
                    f"motion={'YES' if motion_detected else 'no '} "
                    f"active_tracks={active}"
                )

    except Exception as e:
        logger.error(f"[{cam_name}] Fatal loop error: {e}", exc_info=True)
    finally:
        if cap:
            cap.release()
        try:
            safe_execute(cursor, conn,
                "UPDATE cameras SET status='offline' WHERE id=%s", (cam_id,)
            )
            conn.commit()
        except Exception as e:
            logger.error(f"[{cam_name}] Offline update: {e}")
        cursor.close()
        conn.close()
        logger.info(f"[{cam_name}] Thread exited.")


# ══════════════════════════════════════════════════════════════════════════════
# GPU detection log
# ══════════════════════════════════════════════════════════════════════════════

def _log_gpu_status():
    """Log GPU status for all compute components at startup."""
    # dlib/face_recognition
    try:
        import dlib
        cuda_dlib = getattr(dlib, 'DLIB_USE_CUDA', False)
        n_devices = dlib.cuda.get_num_devices() if cuda_dlib else 0
        logger.info(
            f"face_recognition: {'CNN+CUDA' if (USE_CNN_DETECTOR and cuda_dlib) else 'HOG/CPU'} "
            f"| dlib.DLIB_USE_CUDA={cuda_dlib} | devices={n_devices}"
        )
    except Exception as e:
        logger.warning(f"dlib GPU check: {e}")

    # PyTorch / YOLO
    try:
        import torch
        if torch.cuda.is_available():
            logger.info(
                f"PyTorch CUDA: {torch.cuda.get_device_name(0)} "
                f"| VRAM: {torch.cuda.get_device_properties(0).total_memory // 1024**2}MB"
            )
        else:
            logger.warning("PyTorch: CUDA not available — YOLO on CPU")
    except Exception as e:
        logger.warning(f"PyTorch GPU check: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

def main():
    _log_gpu_status()
    logger.info("BlueEye CV Worker v3 starting …")
    matcher        = FaceMatcher()
    active_threads: Dict[int, threading.Thread] = {}

    while True:
        try:
            matcher.load()
            conn   = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM cameras WHERE status = 'online'")
            cams = cursor.fetchall()
            cursor.close(); conn.close()

            online_ids = {cam['id'] for cam in cams}

            # Stop threads for cameras that went offline
            for cid in list(active_threads.keys()):
                if cid not in online_ids and active_threads[cid].is_alive():
                    stop_signals[cid] = True

            for cam in cams:
                cid = cam['id']
                t   = active_threads.get(cid)
                if t is None or not t.is_alive():
                    stop_signals[cid] = False
                    nt = threading.Thread(
                        target = process_camera,
                        args   = (cam, matcher),
                        daemon = True,
                        name   = f"cam-{cid}"
                    )
                    nt.start()
                    active_threads[cid] = nt
                    logger.info(f"Thread started: {cam.get('name')} (id={cid})")

        except Exception as e:
            logger.error(f"Main loop: {e}")

        time.sleep(10)


if __name__ == "__main__":
    main()
