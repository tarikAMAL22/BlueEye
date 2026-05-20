"""
BlueEye CV Worker — 3-layer detection pipeline
  Layer 1: MOG2 motion gate
  Layer 2: YOLO person detection + face-visibility classification
  Layer 3: face_recognition on face crop (only when face found)
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

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s — %(message)s',
)
logger = logging.getLogger("cv_worker")
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

# ── Environment ───────────────────────────────────────────────────────────────
DB_HOST     = os.environ.get("DB_HOST",     "db")
DB_USER     = os.environ.get("DB_USER",     "root")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "my-secret-pw")
DB_NAME     = os.environ.get("DB_NAME",     "blueeye")

REID_TIME_WINDOW_SECONDS = int(os.environ.get("REID_TIME_WINDOW_SECONDS", "120"))
BLUR_THRESHOLD           = float(os.environ.get("BLUR_THRESHOLD",         "80"))
FACE_MATCH_HIGH          = float(os.environ.get("FACE_MATCH_HIGH",        "0.35"))
FACE_MATCH_MED           = float(os.environ.get("FACE_MATCH_MED",         "0.45"))
USE_CNN_DETECTOR         = os.environ.get("USE_CNN_DETECTOR",  "false").lower() == "true"
USE_YOLO_DETECTOR        = os.environ.get("USE_YOLO_DETECTOR", "true").lower()  == "true"

MIN_MOTION_PIXELS = 1500   # non-zero pixels in 320×180 MOG2 mask to trigger detection
YOLO_PERSON_CONF  = 0.4    # minimum YOLO confidence for person class
TRACK_IOU_THRESH  = 0.3    # IoU to link a detection to an existing track
TRACK_TIMEOUT_S   = 5.0    # seconds before a track with no detection is dropped

UPLOAD_DIR = "/app/client/public/uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

face_lock    = threading.Lock()
stop_signals: dict = {}   # cam_id → True  (set True to stop that camera thread)

# Set CV_WORKER_IN_DOCKER=true in docker-compose; never set on bare-metal Vast.ai
_IS_DOCKER = os.environ.get("CV_WORKER_IN_DOCKER", "false").lower() == "true"

# ── YOLO person detector (lazy, thread-safe) ──────────────────────────────────
_yolo_model = None
_yolo_lock  = threading.Lock()

def _get_yolo():
    global _yolo_model
    if _yolo_model is not None:
        return _yolo_model
    if not USE_YOLO_DETECTOR:
        return None
    with _yolo_lock:
        if _yolo_model is not None:
            return _yolo_model
        try:
            from ultralytics import YOLO
            for path in ("yolov8n.pt", "/app/yolov8n.pt", "/workspace/BlueEye/yolov8n.pt"):
                if os.path.exists(path):
                    _yolo_model = YOLO(path)
                    logger.info(f"YOLOv8n loaded from {path}")
                    return _yolo_model
            _yolo_model = YOLO("yolov8n.pt")
            logger.info("YOLOv8n auto-downloaded")
        except Exception as e:
            logger.warning(f"YOLO load failed: {e} — face-only fallback active")
    return _yolo_model


# ── CV config (DB-backed, live-reloaded every 30 s) ───────────────────────────
_cv_config = {
    'alert_cooldown_seconds':       5,
    'biometric_memory_seconds':     20,
    'biometric_distance_threshold': 0.40,
    'tracking_radius_px':           80,
    'detection_buffer_seconds':     1.0,
    'max_presence_seconds':         8.0,
    'frame_analysis_interval_ms':   150,
    'min_face_pixels':              50,
    'face_min_height_px':           20,
    'landmark_min_points':          10,
    'image_downscale_factor':       0.5,
    'upsample_times':               2,
    'recognition_tolerance':        0.50,
}
_cv_config_lock = threading.Lock()


def get_config(key):
    with _cv_config_lock:
        return _cv_config.get(key)


def load_cv_config_from_db(cursor):
    try:
        cursor.execute("SELECT * FROM cv_worker_config ORDER BY id DESC LIMIT 1")
        row = cursor.fetchone()
        if not row:
            return
        with _cv_config_lock:
            _cv_config.update({
                'alert_cooldown_seconds':       min(30,  max(3,   int(row['alert_cooldown_seconds']))),
                'biometric_memory_seconds':     min(60,  max(10,  int(row['biometric_memory_seconds']))),
                'biometric_distance_threshold': float(row['biometric_distance_threshold']),
                'tracking_radius_px':           min(120, max(40,  int(row['tracking_radius_px']))),
                'detection_buffer_seconds':     min(3.0, max(0.5, float(row['detection_buffer_seconds']))),
                'max_presence_seconds':         float(row['max_presence_seconds']),
                'frame_analysis_interval_ms':   int(row['frame_analysis_interval_ms']),
                'min_face_pixels':              min(55,  max(30,  int(row['min_face_pixels']))),
                'face_min_height_px':           min(60,  max(10,  int(row['face_min_height_px']))),
                'landmark_min_points':          min(30,  max(2,   int(row['landmark_min_points']))),
                'image_downscale_factor':       float(row['image_downscale_factor']),
                'upsample_times':               min(3,   max(0,   int(row['upsample_times']))),
                'recognition_tolerance':        float(row['recognition_tolerance']),
            })
        logger.info("CV config reloaded from DB")
    except Exception as e:
        logger.warning(f"CV config load failed (using defaults): {e}")


def _config_reload_loop():
    while True:
        time.sleep(30)
        try:
            conn   = get_db_connection()
            cursor = conn.cursor()
            load_cv_config_from_db(cursor)
            cursor.close()
            conn.close()
        except Exception as e:
            logger.warning(f"CV config reload error: {e}")


# ── DB helpers ────────────────────────────────────────────────────────────────
def get_db_connection():
    while True:
        try:
            return pymysql.connect(
                host=DB_HOST, user=DB_USER, password=DB_PASSWORD, database=DB_NAME,
                cursorclass=pymysql.cursors.DictCursor,
                autocommit=False,
            )
        except Exception as e:
            logger.warning(f"DB connect failed: {e}, retrying in 5 s...")
            time.sleep(5)


_RECONNECT_ERRNO = {2006, 2013, 2055, 4031}   # MySQL gone away / lost connection

def _safe_exec(cursor, conn, sql, params=()):
    """Execute with reconnect only on connection-loss errors. Returns cursor."""
    try:
        cursor.execute(sql, params)
        return cursor
    except pymysql.err.OperationalError as e:
        errno = e.args[0] if e.args else 0
        if errno not in _RECONNECT_ERRNO:
            raise   # schema / permission error — don't mask with reconnect
        logger.warning(f"DB connection lost ({errno}), reconnecting...")
        conn.ping(reconnect=True)
        cursor = conn.cursor()
        cursor.execute(sql, params)
        return cursor


def _get_zone_threat(zone_id, cursor, conn) -> str:
    try:
        _safe_exec(cursor, conn, "SELECT threatLevel FROM zones WHERE id = %s", (zone_id,))
        zone = cursor.fetchone()
        return zone['threatLevel'] if zone else 'medium'
    except Exception:
        return 'medium'


def _compute_cooldown(zone_threat: str) -> int:
    base = get_config('alert_cooldown_seconds')
    return {
        'low':      base * 2,
        'medium':   base,
        'high':     max(5, base // 2),
        'critical': max(3, base // 6),
    }.get(zone_threat, base)


# ── FrameBuffer ───────────────────────────────────────────────────────────────
class FrameBuffer:
    def __init__(self):
        self.frame     = None
        self.lock      = threading.Lock()
        self.timestamp = 0.0

    def update(self, frame):
        with self.lock:
            self.frame     = frame.copy()
            self.timestamp = time.time()

    def read(self):
        with self.lock:
            return self.frame, self.timestamp


def frame_reader_thread(cap, buffer, stop_signal):
    while not stop_signal.get('stop'):
        ret, frame = cap.read()
        if ret:
            buffer.update(frame)
        else:
            time.sleep(0.01)


# ── IoU ───────────────────────────────────────────────────────────────────────
def _iou(a, b):
    """(x1,y1,x2,y2) pairs → intersection-over-union in [0,1]."""
    ix1 = max(a[0], b[0]); iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2]); iy2 = min(a[3], b[3])
    iw = max(0, ix2 - ix1); ih = max(0, iy2 - iy1)
    if iw == 0 or ih == 0:
        return 0.0
    inter  = iw * ih
    area_a = (a[2]-a[0]) * (a[3]-a[1])
    area_b = (b[2]-b[0]) * (b[3]-b[1])
    return inter / max(area_a + area_b - inter, 1)


# ── Snapshot helper ───────────────────────────────────────────────────────────
def _save_snapshot(image, prefix, quality=90):
    if image is None or image.size == 0:
        return None
    fname = f"{prefix}_{uuid.uuid4()}.jpg"
    cv2.imwrite(os.path.join(UPLOAD_DIR, fname), image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return f"/uploads/{fname}"


# ── AppearanceEmbedding ───────────────────────────────────────────────────────
class AppearanceEmbedding:
    @staticmethod
    def extract(frame, x1, y1, x2, y2):
        h = y2 - y1
        if h <= 0:
            return None
        body_top = y1 + int(h * 0.40)
        roi = frame[max(0, body_top):min(frame.shape[0], y2),
                    max(0, x1):min(frame.shape[1], x2)]
        if roi.size == 0 or roi.shape[0] < 10 or roi.shape[1] < 10:
            return None
        hsv  = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [18, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        return hist.flatten().astype(np.float32)


# ── ReIdEngine ────────────────────────────────────────────────────────────────
class ReIdEngine:
    def __init__(self):
        self._lock       = threading.Lock()
        self._detections = {}

    def register(self, global_track_id, cam_id, face_enc, appearance, person_id=None):
        with self._lock:
            self._detections[global_track_id] = {
                'cam_id': cam_id, 'ts': time.time(),
                'face_enc': face_enc, 'appearance': appearance, 'person_id': person_id,
            }

    def find_match(self, cam_id, face_enc, appearance, camera_pairs_map):
        now = time.time()
        with self._lock:
            candidates = {
                tid: d for tid, d in self._detections.items()
                if d['cam_id'] != cam_id and (now - d['ts']) <= REID_TIME_WINDOW_SECONDS
            }
        best_tid, best_score = None, 0.0
        for tid, d in candidates.items():
            pair_key  = (min(cam_id, d['cam_id']), max(cam_id, d['cam_id']))
            max_trans = camera_pairs_map.get(pair_key, REID_TIME_WINDOW_SECONDS)
            if (now - d['ts']) > max_trans:
                continue
            face_score = 0.0
            if face_enc is not None and d['face_enc'] is not None:
                dist = face_recognition.face_distance([d['face_enc']], face_enc)[0]
                face_score = max(0.0, 1.0 - dist / FACE_MATCH_MED)
            app_score = 0.0
            if appearance is not None and d['appearance'] is not None:
                try:
                    a, b = appearance, d['appearance']
                    denom = np.linalg.norm(a) * np.linalg.norm(b)
                    cos_sim = float(np.dot(a, b) / denom) if denom > 0 else 0.0
                    app_score = max(0.0, cos_sim)
                except Exception:
                    pass
            time_score = max(0.0, 1.0 - (now - d['ts']) / max(max_trans, 1))
            score = face_score * 0.6 + app_score * 0.3 + time_score * 0.1
            if score >= 0.70 and score > best_score:
                best_score = score
                best_tid   = tid
        return best_tid, best_score

    def purge_old(self):
        cutoff = time.time() - REID_TIME_WINDOW_SECONDS * 2
        with self._lock:
            stale = [tid for tid, d in self._detections.items() if d['ts'] < cutoff]
            for tid in stale:
                del self._detections[tid]


_reid_engine       = ReIdEngine()
_camera_pairs_map: dict = {}
_camera_pairs_lock = threading.Lock()


def _load_camera_pairs():
    global _camera_pairs_map
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT cam_a_id, cam_b_id, max_transit_seconds FROM camera_pairs")
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        with _camera_pairs_lock:
            _camera_pairs_map = {
                (int(r['cam_a_id']), int(r['cam_b_id'])): int(r['max_transit_seconds'])
                for r in rows
            }
    except Exception as e:
        logger.warning(f"Camera pairs load failed: {e}")


def _reid_reload_loop():
    while True:
        time.sleep(60)
        _load_camera_pairs()
        _reid_engine.purge_old()


# ── Zone helpers ──────────────────────────────────────────────────────────────
def handle_zone_entry(person_id, zone_id, camera_id, global_track_id, conn, cursor):
    access_granted = True
    reason_text    = None
    try:
        if person_id:
            _safe_exec(cursor, conn, """
                SELECT ar.allowed FROM access_rules ar
                WHERE ar.personId = %s AND ar.zoneId = %s LIMIT 1
            """, (person_id, zone_id))
            rule = cursor.fetchone()
            if rule and not rule['allowed']:
                access_granted = False
                reason_text    = "access_rule_denied"

        _safe_exec(cursor, conn, """
            INSERT INTO zone_visits (personId, zoneId, globalTrackId, cameraId, accessGranted)
            VALUES (%s, %s, %s, %s, %s)
        """, (person_id, zone_id, global_track_id, camera_id, access_granted))
        visit_id = cursor.lastrowid

        if not access_granted:
            _safe_exec(cursor, conn, """
                INSERT INTO access_logs (personId, zoneId, cameraId, decision, reason)
                VALUES (%s, %s, %s, 'denied', %s)
            """, (person_id, zone_id, camera_id, reason_text))

        conn.commit()
        return visit_id, access_granted
    except Exception as e:
        logger.error(f"handle_zone_entry error: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        return None, True


def handle_zone_exit(visit_id, conn, cursor):
    try:
        _safe_exec(cursor, conn, """
            UPDATE zone_visits
            SET exitTime = NOW(), dwellSeconds = TIMESTAMPDIFF(SECOND, entryTime, NOW())
            WHERE id = %s AND exitTime IS NULL
        """, (visit_id,))
        conn.commit()
    except Exception as e:
        logger.error(f"handle_zone_exit error: {e}")
        try:
            conn.rollback()
        except Exception:
            pass


# ── FaceMatcher ───────────────────────────────────────────────────────────────
class FaceMatcher:
    def __init__(self):
        self.known_encodings = []
        self.known_ids       = []
        self.known_roles     = []
        self.last_load       = 0

    def _parse_rows(self, rows):
        valid_enc, valid_ids, valid_roles = [], [], []
        skipped = 0
        for r in rows:
            try:
                raw_encs = r.get('faceEncodings')
                if raw_encs:
                    encs_list = json.loads(raw_encs) if isinstance(raw_encs, str) else raw_encs
                    arrays = [np.array(e, dtype=np.float64) for e in encs_list
                              if np.array(e).shape == (128,)]
                    if not arrays:
                        raise ValueError("No valid encodings in faceEncodings")
                    enc = np.mean(arrays, axis=0)
                elif r.get('faceEncoding'):
                    raw = r['faceEncoding']
                    enc = np.array(json.loads(raw) if isinstance(raw, str) else raw, dtype=np.float64)
                    if enc.shape != (128,):
                        raise ValueError("Bad encoding shape")
                else:
                    skipped += 1
                    continue
                valid_enc.append(enc)
                valid_ids.append(r['id'])
                valid_roles.append(r['role'])
            except Exception:
                skipped += 1
        if skipped:
            logger.warning(f"FaceMatcher: skipped {skipped} person(s) with invalid encodings")
        return valid_enc, valid_ids, valid_roles

    def load(self):
        if time.time() - self.last_load < 30:
            return
        try:
            conn   = get_db_connection()
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id, role, faceEncoding, faceEncodings FROM persons "
                "WHERE faceEncoding IS NOT NULL OR faceEncodings IS NOT NULL"
            )
            rows = cursor.fetchall()
            cursor.close()
            conn.close()
            enc, ids, roles         = self._parse_rows(rows)
            self.known_encodings    = enc
            self.known_ids          = ids
            self.known_roles        = roles
            self.last_load          = time.time()
        except Exception as e:
            logger.warning(f"FaceMatcher load failed: {e}")

    def match(self, encoding):
        """Returns (person_id, confidence, role, tier). tier: 'high'|'medium'|'unknown'."""
        if not self.known_encodings:
            return None, 0.0, None, 'unknown'
        distances = face_recognition.face_distance(self.known_encodings, encoding)
        idx  = int(np.argmin(distances))
        dist = float(distances[idx])
        if dist < FACE_MATCH_HIGH:
            return self.known_ids[idx], round((1 - dist) * 100, 2), self.known_roles[idx], 'high'
        if dist < FACE_MATCH_MED:
            return self.known_ids[idx], round((1 - dist) * 100, 2), self.known_roles[idx], 'medium'
        return None, round((1 - dist) * 100, 2), None, 'unknown'


# ── Movement record ───────────────────────────────────────────────────────────
def create_movement_record(cam, tracker_data, alert_id, cursor, conn):
    cam_id     = cam.get('id')
    zone_id    = cam.get('zoneId', 1)
    tracker_id = str(tracker_data.get('tracker_id', 'unknown'))

    best_frame_url = _save_snapshot(tracker_data.get('full_frame'), "mov_frame", quality=85)
    face_crop_url  = _save_snapshot(tracker_data.get('face_image'), "mov_face",  quality=90)

    all_urls   = []
    for i, crop in enumerate(tracker_data.get('face_images_all', [])):
        url = _save_snapshot(crop.get('image'), f"mov_crop_{i}", quality=88)
        if url:
            all_urls.append(url)

    suppression_reason  = tracker_data.get('suppression_reason')
    suppression_details = json.dumps(tracker_data.get('suppression_details') or {})
    face_count          = tracker_data.get('face_count_seen', 0)
    frame_urls          = json.dumps(all_urls)

    try:
        _safe_exec(cursor, conn, """
            INSERT INTO movements
                (cameraId, zoneId, trackerId, frameUrls, bestFrameUrl, faceCropUrl,
                 faceCount, frameCount, alertId, suppressionReason, suppressionDetails)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (cam_id, zone_id, tracker_id, frame_urls, best_frame_url, face_crop_url,
              face_count, 0, alert_id, suppression_reason, suppression_details))
        conn.commit()
    except Exception:
        try:
            conn.rollback()
            _safe_exec(cursor, conn, """
                INSERT INTO movements
                    (cameraId, zoneId, trackerId, frameUrls, bestFrameUrl, faceCropUrl,
                     faceCount, frameCount, alertId)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (cam_id, zone_id, tracker_id, frame_urls, best_frame_url, face_crop_url,
                  face_count, 0, alert_id))
            conn.commit()
        except Exception as e2:
            logger.error(f"Movement record save failed: {e2}")
            try:
                conn.rollback()
            except Exception:
                pass


# ── Alert persistence ─────────────────────────────────────────────────────────
def process_final_alert(cam, alert_data, conn, cursor, detection_type='face'):
    """
    Persist alert + event. Returns alert_id or None.
    detection_type: 'face' | 'partial_face' | 'body_only'
    """
    cam_id  = cam.get('id')
    zone_id = cam.get('zoneId', 1)

    face_image    = alert_data.get('face_image')
    full_frame    = alert_data.get('full_frame')
    face_encoding = alert_data.get('face_encoding')
    person_id     = alert_data.get('person_id')
    confidence    = alert_data.get('confidence', 0)
    role          = alert_data.get('role')
    tier          = alert_data.get('tier', 'unknown')

    face_url  = _save_snapshot(face_image, "face",  quality=95)
    frame_url = _save_snapshot(full_frame, "frame", quality=90)

    # Threat by detection type
    if detection_type == 'face' and person_id and role and role != 'UNKNOWN':
        threat_level = 'low'
    elif detection_type == 'partial_face':
        threat_level = 'medium'
    else:
        threat_level = 'high'

    alert_status = 'pending_review' if tier == 'medium' else 'active'

    # Create UNKNOWN person for unrecognised face detections
    if detection_type in ('face', 'partial_face') and not person_id:
        if face_image is None or face_image.size == 0 or face_encoding is None:
            logger.warning(f"[{cam.get('name')}] No face crop/encoding — skipping unknown insert")
            return None
        try:
            unknown_name  = f"unknown-{str(uuid.uuid4())[:8]}"
            encoding_json = json.dumps(face_encoding.tolist())
            _safe_exec(cursor, conn,
                "INSERT INTO persons (name, role, photoUrl, faceEncoding) VALUES (%s, 'UNKNOWN', %s, %s)",
                (unknown_name, face_url, encoding_json),
            )
            person_id = cursor.lastrowid
            conn.commit()
            role = 'UNKNOWN'
        except Exception as e:
            logger.error(f"Unknown person insert failed: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            role = 'UNKNOWN'

    event_type = 'no_face' if detection_type == 'body_only' else (
        'recognized' if (role and role != 'UNKNOWN') else 'unknown'
    )

    logger.info(
        f"[{cam.get('name')}] ALERT type={detection_type} "
        f"person={role or 'UNKNOWN'} id={person_id} conf={confidence} threat={threat_level}"
    )

    try:
        # Try with detectionType column first (may not exist on older schema)
        try:
            _safe_exec(cursor, conn, """
                INSERT INTO alerts
                    (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl,
                     confidence, status, threatLevel, detectionType)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (person_id, cam_id, zone_id, face_url, frame_url,
                  confidence if confidence is not None else 0, alert_status, threat_level, detection_type))
        except Exception:
            conn.rollback()
            _safe_exec(cursor, conn, """
                INSERT INTO alerts
                    (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl,
                     confidence, status, threatLevel)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (person_id, cam_id, zone_id, face_url, frame_url,
                  confidence if confidence is not None else 0, alert_status, threat_level))
        alert_id = cursor.lastrowid

        try:
            _safe_exec(cursor, conn, """
                INSERT INTO events
                    (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl,
                     confidence, eventType, detectionType)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (person_id, cam_id, zone_id, face_url, frame_url,
                  confidence if confidence is not None else 0, event_type, detection_type))
        except Exception:
            conn.rollback()
            _safe_exec(cursor, conn, """
                INSERT INTO events
                    (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl,
                     confidence, eventType)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
            """, (person_id, cam_id, zone_id, face_url, frame_url,
                  confidence if confidence is not None else 0, event_type))

        conn.commit()
        return alert_id
    except Exception as e:
        logger.error(f"DB error creating alert: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        return None


def _upgrade_alert(alert_id, person_id, confidence, role, face_url, detection_type, conn, cursor):
    """Upgrade a body_only alert when the same person's face becomes visible."""
    threat_level = 'low' if (person_id and role and role != 'UNKNOWN') else 'medium'
    event_type   = 'recognized' if (role and role != 'UNKNOWN') else 'unknown'
    try:
        _safe_exec(cursor, conn, """
            UPDATE alerts
            SET personId=%s, confidence=%s, threatLevel=%s,
                faceSnapshotUrl=COALESCE(%s, faceSnapshotUrl), detectionType=%s
            WHERE id=%s
        """, (person_id, confidence if confidence is not None else 0, threat_level, face_url, detection_type, alert_id))
        _safe_exec(cursor, conn, """
            INSERT INTO events (personId, cameraId, zoneId, faceSnapshotUrl, confidence, eventType, detectionType)
            SELECT %s, cameraId, zoneId, %s, %s, %s, %s FROM alerts WHERE id=%s
        """, (person_id, face_url, confidence if confidence is not None else 0, event_type, detection_type, alert_id))
        conn.commit()
        logger.info(f"Alert {alert_id} upgraded → {detection_type} person={role} conf={confidence}")
    except Exception as e:
        logger.error(f"Alert upgrade failed: {e}")
        try:
            conn.rollback()
        except Exception:
            pass


# ── Layer 2: YOLO person detection ────────────────────────────────────────────
def _detect_persons_yolo(frame):
    """Returns list of (x1, y1, x2, y2) for person detections with conf > threshold."""
    yolo = _get_yolo()
    if yolo is None:
        return []
    try:
        results = yolo(frame, verbose=False, classes=[0])
        boxes   = []
        for box in results[0].boxes:
            if float(box.conf[0]) < YOLO_PERSON_CONF:
                continue
            x1, y1, x2, y2 = map(int, box.xyxy[0].cpu().numpy())
            boxes.append((x1, y1, x2, y2))
        return boxes
    except Exception as e:
        logger.warning(f"YOLO detection failed: {e}")
        return []


def _detect_persons_fallback(frame):
    """When YOLO unavailable: use face_locations and approximate a person bbox."""
    factor = get_config('image_downscale_factor') or 0.5
    small  = cv2.resize(frame, (0, 0), fx=factor, fy=factor)
    rgb    = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
    try:
        with face_lock:
            locs = face_recognition.face_locations(
                rgb, model='hog',
                number_of_times_to_upsample=get_config('upsample_times') or 1,
            )
    except Exception as e:
        logger.debug(f"face_locations fallback failed: {e}")
        return []
    inv   = 1.0 / factor
    boxes = []
    for top_s, right_s, bottom_s, left_s in locs:
        top_f  = int(top_s   * inv); bottom_f = int(bottom_s * inv)
        left_f = int(left_s  * inv); right_f  = int(right_s  * inv)
        face_h = bottom_f - top_f
        x1 = max(0, left_f  - int(face_h * 0.5))
        y1 = max(0, top_f)
        x2 = min(frame.shape[1], right_f + int(face_h * 0.5))
        y2 = min(frame.shape[0], bottom_f + int(face_h * 4))
        boxes.append((x1, y1, x2, y2))
    return boxes


# ── Layer 2: classify detection within a person bbox ─────────────────────────
def _classify_detection(frame, x1, y1, x2, y2):
    """
    Determine whether a face is visible in the top of the person bbox.
    Returns: (detection_type, face_crop_bgr, face_loc_full_frame)
      detection_type: 'face_visible' | 'partial_face' | 'body_only'
    """
    h = y2 - y1
    w = x2 - x1
    if h <= 0 or w <= 0:
        return 'body_only', None, None

    head_bottom = y1 + int(h * 0.40)
    head_crop   = frame[max(0, y1):min(frame.shape[0], head_bottom),
                        max(0, x1):min(frame.shape[1], x2)]
    if head_crop.size == 0:
        return 'body_only', None, None

    rgb_head = cv2.cvtColor(head_crop, cv2.COLOR_BGR2RGB)
    try:
        with face_lock:
            locs = face_recognition.face_locations(rgb_head, model='hog',
                                                   number_of_times_to_upsample=1)
    except Exception as e:
        logger.debug(f"face_locations in classify failed: {e}")
        return 'body_only', None, None

    if not locs:
        return 'body_only', None, None

    # Take largest detected face
    top_c, right_c, bottom_c, left_c = max(locs, key=lambda l: (l[2]-l[0]) * (l[1]-l[3]))

    face_h = bottom_c - top_c
    face_w = right_c  - left_c
    head_h = head_crop.shape[0]

    det_type = 'face_visible'
    if face_h < 20 or face_w < 20 or (face_h / max(head_h, 1)) < 0.15:
        det_type = 'partial_face'

    # Map back to full-frame coords
    top_f    = y1 + top_c
    bottom_f = y1 + bottom_c
    left_f   = x1 + left_c
    right_f  = x1 + right_c

    pad       = int(face_h * 0.15)
    face_crop = frame[max(0, top_f - pad):min(frame.shape[0], bottom_f + pad),
                      max(0, left_f - pad):min(frame.shape[1], right_f + pad)]

    return det_type, face_crop, (top_f, right_f, bottom_f, left_f)


# ── Layer 3: face recognition on a face crop ─────────────────────────────────
def _recognize_face(face_crop, matcher):
    """
    Returns (person_id, confidence, role, tier, encoding) or all-None on failure.
    """
    if face_crop is None or face_crop.size == 0:
        return None, 0, None, 'unknown', None
    if face_crop.shape[0] < 20 or face_crop.shape[1] < 20:
        return None, 0, None, 'unknown', None

    gray = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
    if cv2.Laplacian(gray, cv2.CV_64F).var() < BLUR_THRESHOLD:
        return None, 0, None, 'unknown', None

    rgb = cv2.cvtColor(face_crop, cv2.COLOR_BGR2RGB)
    try:
        with face_lock:
            enc_list = face_recognition.face_encodings(
                rgb, [(0, rgb.shape[1], rgb.shape[0], 0)]
            )
    except Exception as e:
        logger.debug(f"face_encodings failed: {e}")
        return None, 0, None, 'unknown', None

    if not enc_list:
        return None, 0, None, 'unknown', None
    encoding = enc_list[0]
    if np.all(encoding == 0):
        return None, 0, None, 'unknown', None

    person_id, confidence, role, tier = matcher.match(encoding)
    return person_id, confidence, role, tier, encoding


# ── Main camera loop ──────────────────────────────────────────────────────────
def process_camera(cam, matcher):
    cam_id   = cam.get('id')
    zone_id  = cam.get('zoneId', 1)
    cam_name = cam.get('name', f'cam-{cam_id}')

    # Bug 7 fix: safe URL lookup
    backend_url = cam.get('rtspUrl') or cam.get('backendUrl') or cam.get('url')
    if not backend_url:
        logger.error(f"[{cam_name}] has no URL — skipping")
        return

    if _IS_DOCKER and ("localhost" in backend_url or "127.0.0.1" in backend_url):
        backend_url = (backend_url
                       .replace("localhost", "host.docker.internal")
                       .replace("127.0.0.1", "host.docker.internal"))

    conn   = get_db_connection()
    cursor = conn.cursor()
    zone_threat = _get_zone_threat(zone_id, cursor, conn)

    # ── Per-camera state (Bug 3 fix: nothing shared between threads) ──────────
    active_tracks:     dict = {}   # track_id → {bbox, person_id, last_seen, detection_type, encoding, alert_id}
    last_alert_times:  dict = {}   # track_id → timestamp of last alert
    biometric_memory:  dict = {}   # track_id → timestamp for dedup window
    active_zone_visits: dict = {}  # (person_id_or_track_id, zone_id) → {visit_id, last_seen}

    # Layer 1: per-camera MOG2
    bg_sub = cv2.createBackgroundSubtractorMOG2(history=500, varThreshold=50, detectShadows=False)

    cap              = None
    frame_buffer     = FrameBuffer()
    reader_stop      = {'stop': False}
    reader_thread    = None
    last_analyzed_ts = 0.0
    last_heartbeat   = time.time()
    analysis_count   = 0
    ZONE_EXIT_TIMEOUT = 5.0

    try:
        while not stop_signals.get(cam_id):
            # ── Connect / reconnect ───────────────────────────────────────
            needs_connect = cap is None or not cap.isOpened()
            if not needs_connect:
                _, buf_ts = frame_buffer.read()
                if buf_ts > 0 and (time.time() - buf_ts) > 5.0:
                    needs_connect = True
                    logger.warning(f"[{cam_name}] stream stalled, reconnecting...")

            if needs_connect:
                reader_stop['stop'] = True
                if reader_thread and reader_thread.is_alive():
                    reader_thread.join(timeout=2)
                reader_stop['stop'] = False
                if cap:
                    cap.release()
                    cap = None
                logger.info(f"[{cam_name}] Connecting to {backend_url}...")
                cap = cv2.VideoCapture(backend_url)
                if not cap.isOpened():
                    time.sleep(5)
                    continue
                try:
                    _safe_exec(cursor, conn,
                        "UPDATE cameras SET status='online', lastSeen=NOW() WHERE id=%s", (cam_id,))
                    conn.commit()
                except Exception as e:
                    logger.warning(f"[{cam_name}] status update failed: {e}")
                frame_buffer     = FrameBuffer()
                last_analyzed_ts = 0.0
                reader_thread = threading.Thread(
                    target=frame_reader_thread,
                    args=(cap, frame_buffer, reader_stop), daemon=True,
                )
                reader_thread.start()

            # ── Pull latest frame ─────────────────────────────────────────
            frame, ts = frame_buffer.read()
            if frame is None or ts == last_analyzed_ts:
                time.sleep(0.05)
                continue

            now = time.time()   # Bug 1 fix: defined at top of frame block

            if now - ts > 1.0:
                last_analyzed_ts = ts
                time.sleep(0.05)
                continue
            last_analyzed_ts = ts
            analysis_count  += 1

            if now - last_heartbeat >= 30:
                logger.info(f"[{cam_name}] heartbeat — {analysis_count} frames, "
                            f"{len(active_tracks)} tracks")
                last_heartbeat = now

            zone_cooldown = _compute_cooldown(zone_threat)

            # ── LAYER 1: Motion gate ──────────────────────────────────────
            small_mog  = cv2.resize(frame, (320, 180))
            fg_mask    = bg_sub.apply(small_mog)
            motion_px  = cv2.countNonZero(fg_mask)

            if motion_px < MIN_MOTION_PIXELS and not active_tracks:
                time.sleep(0.05)
                continue

            # ── LAYER 2: Person detection ─────────────────────────────────
            person_boxes = _detect_persons_yolo(frame)
            if not person_boxes and _get_yolo() is None:
                person_boxes = _detect_persons_fallback(frame)

            # ── Match detections to active tracks via IoU ─────────────────
            matched_track_ids: set = set()

            for bbox in person_boxes:
                x1, y1, x2, y2 = bbox

                best_tid = None
                best_iou = 0.0
                for tid, tdata in active_tracks.items():
                    if tid in matched_track_ids:
                        continue
                    iou_val = _iou(bbox, tdata['bbox'])
                    if iou_val > TRACK_IOU_THRESH and iou_val > best_iou:
                        best_iou = iou_val
                        best_tid = tid

                if best_tid is None:
                    best_tid = f"trk_{uuid.uuid4().hex[:8]}"
                    active_tracks[best_tid] = {
                        'bbox': bbox, 'person_id': None, 'last_seen': now,
                        'detection_type': 'body_only', 'encoding': None, 'alert_id': None,
                    }
                else:
                    active_tracks[best_tid]['bbox']      = bbox
                    active_tracks[best_tid]['last_seen'] = now

                matched_track_ids.add(best_tid)
                tdata = active_tracks[best_tid]

                # ── Classify detection ────────────────────────────────────
                det_type, face_crop, _ = _classify_detection(frame, x1, y1, x2, y2)

                person_id  = tdata['person_id']
                confidence = 0
                role       = None
                tier       = 'unknown'
                encoding   = tdata['encoding']
                did_upgrade = False

                # ── LAYER 3: Face recognition (only when face found) ──────
                if det_type in ('face_visible', 'partial_face') and face_crop is not None:
                    pid_new, conf_new, role_new, tier_new, enc_new = _recognize_face(face_crop, matcher)

                    # Always record actual confidence + encoding for the alert.
                    # Bug 6 fix: only update biometric dedup memory for high-confidence results.
                    if enc_new is not None:
                        confidence = conf_new
                        role       = role_new
                        tier       = tier_new
                        encoding   = enc_new
                        tdata['encoding'] = enc_new
                        if pid_new is not None:
                            person_id         = pid_new
                            tdata['person_id'] = pid_new

                    prev_det_type = tdata['detection_type']
                    tdata['detection_type'] = det_type

                    # Upgrade existing body_only alert when face appears
                    if (prev_det_type == 'body_only'
                            and tdata['alert_id'] is not None
                            and encoding is not None):
                        face_url_upg = _save_snapshot(face_crop, "face", quality=95)
                        _upgrade_alert(
                            tdata['alert_id'], person_id, confidence,
                            role, face_url_upg, det_type, conn, cursor,
                        )
                        did_upgrade = True
                else:
                    tdata['detection_type'] = det_type

                if did_upgrade:
                    continue

                # ── Cooldown + biometric dedup checks ─────────────────────
                effective_cooldown = zone_cooldown if person_id else max(5, zone_cooldown // 3)
                last_alert = last_alert_times.get(best_tid, 0)
                if now - last_alert < effective_cooldown:
                    continue

                bio_window = get_config('biometric_memory_seconds')
                bio_ts     = biometric_memory.get(best_tid, 0)
                # Bug 6 fix: low-confidence unknowns don't reset biometric memory window,
                # but they can still generate an alert (avoids suppressing real detections)
                if bio_ts and (now - bio_ts) < bio_window and (confidence >= 40 or person_id):
                    continue

                # ── Build snapshot for alert ──────────────────────────────
                body_crop = frame[max(0, y1):min(frame.shape[0], y2),
                                  max(0, x1):min(frame.shape[1], x2)]
                snap = face_crop if (det_type != 'body_only' and face_crop is not None) else body_crop
                if snap is None or snap.size == 0:
                    snap = body_crop

                alert_data = {
                    'face_image':    snap,
                    'full_frame':    frame.copy(),
                    'face_encoding': encoding,
                    'person_id':     person_id,
                    'confidence':    confidence,
                    'role':          role,
                    'tier':          tier,
                    'tracker_id':    best_tid,
                    'face_count_seen': 1,
                }

                alert_id = process_final_alert(cam, alert_data, conn, cursor, detection_type=det_type)

                if alert_id:
                    tdata['alert_id']           = alert_id
                    last_alert_times[best_tid]  = now
                    biometric_memory[best_tid]  = now

                    create_movement_record(cam, alert_data, alert_id, cursor, conn)

                    # Zone visit
                    gtid      = str(uuid.uuid4())
                    visit_key = (person_id or best_tid, zone_id)
                    if visit_key not in active_zone_visits:
                        visit_id, _ = handle_zone_entry(
                            person_id, zone_id, cam_id, gtid, conn, cursor
                        )
                        if visit_id:
                            active_zone_visits[visit_key] = {
                                'visit_id': visit_id, 'last_seen': now,
                            }
                    else:
                        active_zone_visits[visit_key]['last_seen'] = now

            # ── Drop stale tracks ─────────────────────────────────────────
            for tid in list(active_tracks.keys()):
                if now - active_tracks[tid]['last_seen'] > TRACK_TIMEOUT_S:
                    pid = active_tracks[tid].get('person_id')
                    vk  = (pid or tid, zone_id)
                    if vk in active_zone_visits:
                        handle_zone_exit(active_zone_visits[vk]['visit_id'], conn, cursor)
                        del active_zone_visits[vk]
                    del active_tracks[tid]

            # ── Zone exit timeout check ───────────────────────────────────
            for vk in list(active_zone_visits.keys()):
                vdata = active_zone_visits[vk]
                if (now - vdata.get('last_seen', now)) > ZONE_EXIT_TIMEOUT:
                    handle_zone_exit(vdata['visit_id'], conn, cursor)
                    del active_zone_visits[vk]

            matcher.load()

    except Exception as e:
        logger.error(f"[{cam_name}] fatal error in camera loop: {e}", exc_info=True)
    finally:
        reader_stop['stop'] = True
        if reader_thread and reader_thread.is_alive():
            reader_thread.join(timeout=2)
        if cap:
            cap.release()
        for vdata in active_zone_visits.values():
            try:
                handle_zone_exit(vdata['visit_id'], conn, cursor)
            except Exception:
                pass
        try:
            _safe_exec(cursor, conn,
                "UPDATE cameras SET status='offline' WHERE id=%s", (cam_id,))
            conn.commit()
        except Exception:
            pass
        try:
            cursor.close()
            conn.close()
        except Exception:
            pass


# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    import signal

    logger.info("BlueEye CV Worker v3 starting (3-layer pipeline)...")

    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        load_cv_config_from_db(cursor)
        cursor.close()
        conn.close()
    except Exception as e:
        logger.warning(f"Initial config load skipped: {e}")

    _load_camera_pairs()
    threading.Thread(target=_config_reload_loop, daemon=True).start()
    threading.Thread(target=_reid_reload_loop,   daemon=True).start()

    matcher        = FaceMatcher()
    active_threads: dict = {}

    def _shutdown(signum, frame):
        logger.info("Shutdown signal received — stopping all processors...")
        for cid in list(stop_signals.keys()):
            stop_signals[cid] = True
        time.sleep(2)
        logger.info("BlueEye CV Worker v3 stopped.")

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT,  _shutdown)

    while True:
        try:
            matcher.load()
            conn   = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM cameras WHERE status != 'deleted'")
            cams = cursor.fetchall()
            cursor.close()
            conn.close()

            for cam in cams:
                cid = cam['id']
                if cid not in active_threads or not active_threads[cid].is_alive():
                    stop_signals[cid] = False
                    t = threading.Thread(
                        target=process_camera, args=(cam, matcher), daemon=True
                    )
                    t.start()
                    active_threads[cid] = t
                    logger.info(f"Started processor for [{cam.get('name')}] (id={cid})")
        except Exception as e:
            logger.error(f"Main loop error: {e}")
        time.sleep(10)


if __name__ == "__main__":
    main()
