import cv2
import time
import os
import uuid
import mysql.connector
import logging
import threading
import numpy as np
import requests
import face_recognition
import json
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("CV-Worker")
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

DB_HOST = os.environ.get("DB_HOST", "db")
DB_USER = os.environ.get("DB_USER", "root")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "my-secret-pw")
DB_NAME = os.environ.get("DB_NAME", "blueeye")

UPLOAD_DIR = "/app/client/public/uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

cv_lock = threading.Lock()
face_lock = threading.Lock()
stop_signals = {}

# P2: HOG person detector — initialized once at module level (~30ms per frame)
hog = cv2.HOGDescriptor()
hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

# ── Detection sensitivity config (DB-backed, live-reloaded every 30s) ────────
_cv_config = {
    'alert_cooldown_seconds':       5,    # was 30 — faster re-detection of follow-up persons
    'biometric_memory_seconds':     20,   # was 45 — shorter dedup window
    'biometric_distance_threshold': 0.40,
    'tracking_radius_px':           80,   # was 100 — tighter, prevents merging adjacent persons
    'detection_buffer_seconds':     1.0,  # was 1.5 — faster finalization per person
    'max_presence_seconds':         8.0,
    'frame_analysis_interval_ms':   150,
    'min_face_pixels':              50,   # was 80 — catches background faces (65-75px crop)
}
_cv_config_lock = threading.Lock()


def get_config(key):
    """Thread-safe read of the live detection config."""
    with _cv_config_lock:
        return _cv_config.get(key)


def load_cv_config_from_db(cursor):
    """Pull the latest row from cv_worker_config; silently falls back to defaults."""
    try:
        cursor.execute("SELECT * FROM cv_worker_config ORDER BY id DESC LIMIT 1")
        row = cursor.fetchone()
        if row:
            with _cv_config_lock:
                _cv_config.update({
                    'alert_cooldown_seconds':       int(row['alertCooldownSeconds']),
                    'biometric_memory_seconds':     int(row['biometricMemorySeconds']),
                    'biometric_distance_threshold': float(row['biometricDistanceThreshold']),
                    'tracking_radius_px':           int(row['trackingRadiusPx']),
                    'detection_buffer_seconds':     float(row['detectionBufferSeconds']),
                    'max_presence_seconds':         float(row['maxPresenceSeconds']),
                    'frame_analysis_interval_ms':   int(row['frameAnalysisIntervalMs']),
                    'min_face_pixels':              int(row['minFacePixels']),
                })
            logger.info(
                f"CV Config reloaded: cooldown={_cv_config['alert_cooldown_seconds']}s "
                f"radius={_cv_config['tracking_radius_px']}px "
                f"buffer={_cv_config['detection_buffer_seconds']}s "
                f"bio_thresh={_cv_config['biometric_distance_threshold']}"
            )
    except Exception as e:
        logger.warning(f"CV Config load failed (using defaults): {e}")


def _config_reload_loop():
    """Background thread: reload config from DB every 30s."""
    while True:
        time.sleep(30)
        try:
            conn   = get_db_connection()
            cursor = conn.cursor(dictionary=True)
            load_cv_config_from_db(cursor)
            cursor.close()
            conn.close()
        except Exception as e:
            logger.warning(f"CV Config reload error: {e}")


def get_db_connection():
    while True:
        try:
            return mysql.connector.connect(host=DB_HOST, user=DB_USER, password=DB_PASSWORD, database=DB_NAME)
        except:
            time.sleep(5)


def _get_zone_threat(zone_id, cursor) -> str:
    """Return the threat level for a zone (DB lookup, called once per camera start)."""
    try:
        cursor.execute("SELECT threatLevel FROM zones WHERE id = %s", (zone_id,))
        zone = cursor.fetchone()
        return zone['threatLevel'] if zone else 'medium'
    except Exception:
        return 'medium'


def _compute_cooldown(zone_threat: str) -> int:
    """Compute cooldown in seconds for a threat level, scaling from the live config."""
    base = get_config('alert_cooldown_seconds')
    return {
        'low':      base * 2,
        'medium':   base,
        'high':     max(5, base // 2),
        'critical': max(3, base // 6),
    }.get(zone_threat, base)


# P1: Thread-safe frame buffer for decoupled RTSP reading and analysis
class FrameBuffer:
    def __init__(self):
        self.frame = None
        self.lock = threading.Lock()
        self.timestamp = 0.0

    def update(self, frame):
        with self.lock:
            self.frame = frame.copy()
            self.timestamp = time.time()

    def read(self):
        with self.lock:
            return self.frame, self.timestamp


def frame_reader_thread(cap, buffer, stop_signal):
    """P1: Dedicated RTSP reader — never blocks the analysis thread."""
    while not stop_signal.get('stop'):
        ret, frame = cap.read()
        if ret:
            buffer.update(frame)
        else:
            time.sleep(0.01)


def is_valid_face_crop(face_image) -> bool:
    """Return True only if face_image is a usable identity photo."""
    if face_image is None or face_image.size == 0:
        return False
    h, w = face_image.shape[:2]
    if h < 80 or w < 80:
        return False
    gray = cv2.cvtColor(face_image, cv2.COLOR_BGR2GRAY)
    if cv2.Laplacian(gray, cv2.CV_64F).var() < 50:
        return False
    if np.std(face_image) < 20:
        return False
    ratio = h / w
    if ratio < 0.8 or ratio > 2.5:
        return False
    # BGR sanity: blue channel should not dominate red by >1.5× (catches RGB/BGR swap)
    b_mean = float(np.mean(face_image[:, :, 0]))
    r_mean = float(np.mean(face_image[:, :, 2]))
    if r_mean > 0 and b_mean > r_mean * 1.5:
        return False
    return True


def create_no_face_alert(cam, body_crop, full_frame, cursor, conn):
    """P2: Alert for a person detected without a visible face (back, hat, too far)."""
    cam_id  = cam.get('id')
    zone_id = cam.get('zoneId', 1)

    if body_crop is None or body_crop.size == 0:
        return

    unique_id      = str(uuid.uuid4())
    body_filename  = f"body_{unique_id}.jpg"
    frame_filename = f"frame_{unique_id}.jpg"
    body_path  = os.path.join(UPLOAD_DIR, body_filename)
    frame_path = os.path.join(UPLOAD_DIR, frame_filename)

    cv2.imwrite(body_path,  body_crop,  [cv2.IMWRITE_JPEG_QUALITY, 90])
    cv2.imwrite(frame_path, full_frame, [cv2.IMWRITE_JPEG_QUALITY, 85])

    body_url  = f"/uploads/{body_filename}"
    frame_url = f"/uploads/{frame_filename}"

    logger.info(f"👤 NO-FACE PERSON detected on {cam.get('name')}")

    try:
        cursor.execute("""
            INSERT INTO alerts
                (personId, cameraId, zoneId, faceSnapshotUrl,
                 bestFrameSnapshotUrl, confidence, status, threatLevel, detectionType)
            VALUES (NULL, %s, %s, %s, %s, NULL, 'active', 'medium', 'NO_FACE')
        """, (cam_id, zone_id, body_url, frame_url))
        cursor.execute("""
            INSERT INTO events
                (personId, cameraId, zoneId, faceSnapshotUrl,
                 bestFrameSnapshotUrl, confidence, eventType)
            VALUES (NULL, %s, %s, %s, %s, NULL, 'no_face')
        """, (cam_id, zone_id, body_url, frame_url))
        conn.commit()
    except Exception as e:
        logger.error(f"DB Error no_face alert: {e}")
        conn.rollback()


def process_final_alert(cam, alert_data, cursor, conn):
    cam_id       = cam.get('id')
    zone_id      = cam.get('zoneId', 1)
    face_image   = alert_data['face_image']
    frame        = alert_data['full_frame']
    face_encoding = alert_data['face_encoding']
    person_id    = alert_data['person_id']
    confidence   = alert_data['confidence']
    role         = alert_data['role']
    face_visible = alert_data.get('face_visible', True)

    unique_id      = str(uuid.uuid4())
    face_filename  = f"face_{unique_id}.jpg"
    frame_filename = f"frame_{unique_id}.jpg"
    face_path  = os.path.join(UPLOAD_DIR, face_filename)
    frame_path = os.path.join(UPLOAD_DIR, frame_filename)
    cv2.imwrite(face_path,  face_image, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    cv2.imwrite(frame_path, frame,      [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    face_url  = f"/uploads/{face_filename}"
    frame_url = f"/uploads/{frame_filename}"

    if not face_visible:
        # Person looking away / profile: no reliable encoding — create body-only alert.
        metadata = json.dumps({"bodyOnlyDetection": True})
        logger.info(f"🚨 NO-FACE ALERT on {cam.get('name')} (back/profile — no identity)")
        try:
            cursor.execute("""
                INSERT INTO alerts
                    (personId, cameraId, zoneId, faceSnapshotUrl,
                     bestFrameSnapshotUrl, confidence, status, threatLevel, detectionType, metadata)
                VALUES (NULL, %s, %s, %s, %s, NULL, 'active', 'high', 'NO_FACE', %s)
            """, (cam_id, zone_id, face_url, frame_url, metadata))
            alert_id = cursor.lastrowid
            cursor.execute("""
                INSERT INTO events
                    (personId, cameraId, zoneId, faceSnapshotUrl,
                     bestFrameSnapshotUrl, confidence, eventType)
                VALUES (NULL, %s, %s, %s, %s, NULL, 'no_face')
            """, (cam_id, zone_id, face_url, frame_url))
            conn.commit()
            return alert_id
        except Exception as e:
            logger.error(f"DB Error (no-face alert): {e}")
            conn.rollback()
            return None

    # Normal face-visible path
    if not person_id:
        if not is_valid_face_crop(face_image):
            logger.warning(
                f"Invalid face crop on {cam.get('name')} — skipping unknown-person insert"
            )
            return
        try:
            unknown_name  = f"unknown-{unique_id[:8]}"
            encoding_json = json.dumps(face_encoding.tolist())
            cursor.execute(
                "INSERT INTO persons (name, role, photoUrl, faceEncoding) VALUES (%s, 'UNKNOWN', %s, %s)",
                (unknown_name, face_url, encoding_json),
            )
            person_id = cursor.lastrowid
            conn.commit()
            role = 'UNKNOWN'
        except:
            conn.rollback()
            role = 'UNKNOWN'

    threat     = 'high' if role == 'UNKNOWN' else 'medium'
    event_type = 'recognized' if (role and role != 'UNKNOWN') else 'unknown'

    logger.info(f"🚨 ALERT: {role} (ID: {person_id}) on {cam.get('name')}")

    try:
        cursor.execute("""
            INSERT INTO alerts
                (personId, cameraId, zoneId, faceSnapshotUrl,
                 bestFrameSnapshotUrl, confidence, status, threatLevel, detectionType)
            VALUES (%s, %s, %s, %s, %s, %s, 'active', %s, 'FACE')
        """, (person_id, cam_id, zone_id, face_url, frame_url, confidence, threat))
        alert_id = cursor.lastrowid
        cursor.execute("""
            INSERT INTO events
                (personId, cameraId, zoneId, faceSnapshotUrl,
                 bestFrameSnapshotUrl, confidence, eventType)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (person_id, cam_id, zone_id, face_url, frame_url, confidence, event_type))
        conn.commit()
        return alert_id
    except Exception as e:
        logger.error(f"DB Error: {e}")
        conn.rollback()
        return None


def create_movement_record(cam, tracker_data, alert_id, cursor, conn):
    """Persist a movement record for every finalized tracker — alerted or suppressed."""
    cam_id  = cam.get('id')
    zone_id = cam.get('zoneId', 1)
    tracker_id = str(tracker_data.get('tracker_id', 'unknown'))
    best_frame_url = None
    face_crop_url  = None

    if tracker_data.get('full_frame') is not None:
        uid   = str(uuid.uuid4())
        fname = f"mov_frame_{uid}.jpg"
        cv2.imwrite(os.path.join(UPLOAD_DIR, fname), tracker_data['full_frame'], [cv2.IMWRITE_JPEG_QUALITY, 85])
        best_frame_url = f"/uploads/{fname}"

    # Best face crop → faceCropUrl
    if tracker_data.get('face_image') is not None:
        uid   = str(uuid.uuid4())
        fname = f"mov_face_{uid}.jpg"
        cv2.imwrite(os.path.join(UPLOAD_DIR, fname), tracker_data['face_image'], [cv2.IMWRITE_JPEG_QUALITY, 90])
        face_crop_url = f"/uploads/{fname}"

    # All accumulated face crops → frameUrls (powers the movement flipbook)
    all_urls = []
    for i, crop in enumerate(tracker_data.get('face_images_all', [])):
        uid   = str(uuid.uuid4())
        fname = f"mov_crop_{uid}_{i}.jpg"
        cv2.imwrite(os.path.join(UPLOAD_DIR, fname), crop['image'], [cv2.IMWRITE_JPEG_QUALITY, 88])
        all_urls.append(f"/uploads/{fname}")

    suppression_reason  = tracker_data.get('suppression_reason')
    suppression_details = json.dumps(tracker_data.get('suppression_details') or {})
    face_count = tracker_data.get('face_count_seen', 1)
    frame_urls = json.dumps(all_urls)

    try:
        cursor.execute("""
            INSERT INTO movements
                (cameraId, zoneId, trackerId, frameUrls, bestFrameUrl, faceCropUrl,
                 faceCount, frameCount, alertId, suppressionReason, suppressionDetails)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (cam_id, zone_id, tracker_id, frame_urls, best_frame_url, face_crop_url,
              face_count, 0, alert_id, suppression_reason, suppression_details))
        conn.commit()
    except Exception:
        # Fallback for DBs without suppressionReason/suppressionDetails columns yet
        conn.rollback()
        try:
            cursor.execute("""
                INSERT INTO movements
                    (cameraId, zoneId, trackerId, frameUrls, bestFrameUrl, faceCropUrl,
                     faceCount, frameCount, alertId)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (cam_id, zone_id, tracker_id, frame_urls, best_frame_url, face_crop_url,
                  face_count, 0, alert_id))
            conn.commit()
        except Exception as e2:
            logger.error(f"Movement record save failed: {e2}")
            conn.rollback()


# Global memory for biometric cooldowns
# Format: {(cam_id, tracking_id): last_alert_timestamp}  — per-tracker, not per-camera
biometric_memory = {}
biometric_memory_lock = threading.Lock()


def process_camera(cam, matcher, last_alert_times, pending_alerts):
    global biometric_memory
    cam_id  = cam.get('id')
    zone_id = cam.get('zoneId', 1)
    backend_url = cam.get('rtspUrl') or cam.get('backendUrl') or cam.get('url')
    if not backend_url:
        logger.error(f"Camera {cam.get('name')} has no URL!")
        return

    if "localhost" in backend_url or "127.0.0.1" in backend_url:
        backend_url = (backend_url
                       .replace("localhost", "host.docker.internal")
                       .replace("127.0.0.1", "host.docker.internal"))

    conn   = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    # Zone threat level: looked up once; cooldown is computed inline from live config
    zone_threat = _get_zone_threat(zone_id, cursor)

    cap             = None
    frame_buffer    = FrameBuffer()
    reader_stop     = {'stop': False}
    reader_thread   = None
    last_analyzed_ts = 0.0
    last_heartbeat  = time.time()
    analysis_count  = 0

    try:
        while not stop_signals.get(cam_id):
            # ── Connection / reconnection ─────────────────────────────────
            needs_connect = cap is None or not cap.isOpened()
            if not needs_connect:
                _, buf_ts = frame_buffer.read()
                if buf_ts > 0 and (time.time() - buf_ts) > 5.0:
                    needs_connect = True
                    logger.warning(f"Camera {cam.get('name')} stalled, reconnecting...")

            if needs_connect:
                reader_stop['stop'] = True
                if reader_thread and reader_thread.is_alive():
                    reader_thread.join(timeout=2)
                reader_stop['stop'] = False
                if cap:
                    cap.release()
                    cap = None

                logger.info(f"Connecting to {cam.get('name')}...")
                cap = cv2.VideoCapture(backend_url)
                if not cap.isOpened():
                    time.sleep(5)
                    continue
                cursor.execute("UPDATE cameras SET status = 'online', lastSeen = NOW() WHERE id = %s", (cam_id,))
                conn.commit()
                frame_buffer    = FrameBuffer()
                last_analyzed_ts = 0.0

                # P1: dedicated reader thread — keeps buffer fresh without blocking analysis
                reader_thread = threading.Thread(
                    target=frame_reader_thread,
                    args=(cap, frame_buffer, reader_stop),
                    daemon=True,
                )
                reader_thread.start()

            # ── P1: Pull latest frame (non-blocking) ──────────────────────
            frame, ts = frame_buffer.read()
            if frame is None or ts == last_analyzed_ts:
                time.sleep(0.05)
                continue

            now = time.time()
            if now - ts > 1.0:
                # Frame too stale; skip without analyzing
                last_analyzed_ts = ts
                time.sleep(0.05)
                continue
            last_analyzed_ts = ts

            analysis_count += 1
            if now - last_heartbeat >= 30:
                logger.info(f"Heartbeat: Camera {cam.get('name')} — {analysis_count} analyses")
                last_heartbeat = now

            # Compute zone cooldown from live config each frame (cheap, in-memory)
            zone_cooldown = _compute_cooldown(zone_threat)

            # ── P2: HOG body detection gates face recognition ─────────────
            small_for_hog = cv2.resize(frame, (640, 360))
            raw_locations, _ = hog.detectMultiScale(
                small_for_hog,
                winStride=(4, 4),    # finer stride catches smaller/background persons
                padding=(8, 8),      # more padding helps partial detections
                scale=1.03,          # finer pyramid catches small far-away persons
                hitThreshold=0.0,    # accept all HOG responses; NMS filters duplicates
                finalThreshold=0.0,
            )
            # Manual NMS to merge overlapping boxes (replaces hitThreshold filtering)
            if len(raw_locations) > 0:
                rects = np.array([(x, y, x + w, y + h) for (x, y, w, h) in raw_locations])
                pick  = []
                x1, y1, x2, y2 = rects[:,0], rects[:,1], rects[:,2], rects[:,3]
                area  = (x2 - x1 + 1) * (y2 - y1 + 1)
                idxs  = np.argsort(y2)
                while len(idxs) > 0:
                    last = len(idxs) - 1
                    i    = idxs[last]
                    pick.append(i)
                    xx1  = np.maximum(x1[i], x1[idxs[:last]])
                    yy1  = np.maximum(y1[i], y1[idxs[:last]])
                    xx2  = np.minimum(x2[i], x2[idxs[:last]])
                    yy2  = np.minimum(y2[i], y2[idxs[:last]])
                    w_   = np.maximum(0, xx2 - xx1 + 1)
                    h_   = np.maximum(0, yy2 - yy1 + 1)
                    overlap = (w_ * h_) / area[idxs[:last]]
                    idxs = np.delete(idxs, np.concatenate(([last], np.where(overlap > 0.60)[0])))
                rects = rects[pick]
                body_locations = [(x, y, x2 - x, y2 - y) for (x, y, x2, y2) in rects]
            else:
                body_locations = []
            persons_detected = len(body_locations)

            face_locations      = []
            face_encodings_list = []
            landmarks_list      = []
            if persons_detected > 0:
                small_frame = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
                rgb_frame   = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
                with cv_lock:
                    face_locations = face_recognition.face_locations(rgb_frame, number_of_times_to_upsample=2)
                if face_locations and len(face_locations) < 10:
                    with face_lock:
                        face_encodings_list = face_recognition.face_encodings(rgb_frame, face_locations)
                        landmarks_list      = face_recognition.face_landmarks(rgb_frame, face_locations)

            # ── P2: Body-to-face matching → no-face alert for unmatched bodies ──
            scale_x = frame.shape[1] / 640.0
            scale_y = frame.shape[0] / 360.0

            for bx, by, bw, bh in body_locations:
                bx_f = int(bx * scale_x)
                by_f = int(by * scale_y)
                bw_f = int(bw * scale_x)
                bh_f = int(bh * scale_y)
                body_cx = bx_f + bw_f // 2

                face_matched = False
                body_cy = by_f + bh_f // 4   # upper quarter — face sits near the top of a body box
                for top_hf, right_hf, bottom_hf, left_hf in face_locations:
                    face_cx_full = left_hf + right_hf
                    face_cy_full = top_hf  + bottom_hf
                    tolerance_x  = max(80, bw_f * 0.8)
                    tolerance_y  = max(120, bh_f * 0.5)
                    if abs(face_cx_full - body_cx) < tolerance_x and abs(face_cy_full - body_cy) < tolerance_y:
                        face_matched = True
                        break

                if not face_matched:
                    body_crop = frame[
                        max(0, by_f):min(frame.shape[0], by_f + bh_f),
                        max(0, bx_f):min(frame.shape[1], bx_f + bw_f),
                    ]
                    # Spatial grid key prevents alert flooding for the same body position
                    body_key = (cam_id, f"body_{bx_f // 60}_{by_f // 60}")
                    if body_key not in last_alert_times or (now - last_alert_times[body_key]) >= zone_cooldown:
                        create_no_face_alert(cam, body_crop, frame, cursor, conn)
                        last_alert_times[body_key] = now

            # ── Face recognition pipeline ──────────────────────────────────
            bio_window   = get_config('biometric_memory_seconds')
            track_radius = get_config('tracking_radius_px')
            min_face_px  = get_config('min_face_pixels')

            # Bug B: prevent two faces in the same frame from sharing a tracker
            assigned_in_frame = set()

            for box, encoding, landmark in zip(face_locations, face_encodings_list, landmarks_list):
                # Anatomy filter
                all_landmark_points = sum(len(p) for p in landmark.values())
                if all_landmark_points < 10:
                    continue
                required = ['left_eye', 'right_eye', 'nose_bridge', 'top_lip']
                if not all(k in landmark for k in required):
                    continue

                top, right, bottom, left = [b * 2 for b in box]
                if (bottom - top) < 20:
                    continue

                person_id, confidence, role = matcher.match(encoding)
                # Do not gate on confidence — unknown persons legitimately score low
                # against the DB (25-39%). Safety ensured by landmark + size filters
                # above and is_valid_face_crop() before DB insert.
                if np.all(encoding == 0):
                    continue

                # Bug A: determine tracking_id BEFORE suppression checks
                tracking_id = person_id
                if not person_id:
                    best_tracker = None
                    best_dist    = float('inf')
                    for p_key, p_data in pending_alerts.items():
                        if p_key[0] == cam_id and str(p_key[1]).startswith("unk_"):
                            # Bug B: skip trackers already assigned to another face this frame
                            if p_key[1] in assigned_in_frame:
                                continue
                            old_top, old_left = p_data.get('last_pos', (top, left))
                            d = ((top - old_top) ** 2 + (left - old_left) ** 2) ** 0.5
                            if d < track_radius and d < best_dist:
                                # Encoding check: reject if biometrically too different (different person)
                                prev_enc = p_data.get('face_encoding')
                                if prev_enc is not None:
                                    enc_dist = face_recognition.face_distance([prev_enc], encoding)[0]
                                    if enc_dist > 0.5:
                                        continue
                                best_dist    = d
                                best_tracker = p_key[1]
                    tracking_id = best_tracker if best_tracker else f"unk_{str(uuid.uuid4())[:8]}"

                assigned_in_frame.add(tracking_id)
                key = (cam_id, tracking_id)
                now = time.time()

                # Bug A: biometric dedup keyed per tracker, not per camera
                is_too_recent      = False
                bio_last_seen_secs = None
                with biometric_memory_lock:
                    if key in biometric_memory:
                        elapsed = now - biometric_memory[key]
                        if elapsed < bio_window:
                            is_too_recent      = True
                            bio_last_seen_secs = round(elapsed, 1)
                        else:
                            del biometric_memory[key]

                # Cooldown check per tracker
                cooldown_remaining = 0.0
                if key in last_alert_times:
                    elapsed = now - last_alert_times[key]
                    if elapsed < zone_cooldown:
                        cooldown_remaining = round(zone_cooldown - elapsed, 1)

                # Classify suppression for this specific tracker
                suppression_reason: str | None  = None
                suppression_details: dict        = {}
                if is_too_recent:
                    suppression_reason  = 'dedup'
                    suppression_details = {'secondsAgo': bio_last_seen_secs, 'windowSeconds': bio_window}
                    logger.info(f"Dedup: {cam.get('name')} tracker={tracking_id} seen {bio_last_seen_secs}s ago")
                elif cooldown_remaining > 0:
                    suppression_reason  = 'cooldown'
                    suppression_details = {'secondsRemaining': cooldown_remaining, 'cooldownSeconds': zone_cooldown}
                    logger.info(f"Cooldown: {cam.get('name')} tracker={tracking_id} — {cooldown_remaining}s left")

                # Always register tracker so a movement record is saved even for suppressed persons
                if key not in pending_alerts:
                    pending_alerts[key] = {
                        'start_time': now, 'best_size': 0, 'last_pos': (top, left),
                        'tracker_id': str(tracking_id),
                        'suppression_reason': suppression_reason,
                        'suppression_details': suppression_details,
                        'face_count_seen': 0,
                    }
                else:
                    pending_alerts[key]['last_pos'] = (top, left)
                    if suppression_reason and not pending_alerts[key].get('suppression_reason'):
                        pending_alerts[key]['suppression_reason'] = suppression_reason
                        pending_alerts[key]['suppression_details'] = suppression_details

                pending_alerts[key]['last_seen_time'] = now
                pending_alerts[key]['face_count_seen'] = pending_alerts[key].get('face_count_seen', 0) + 1

                if suppression_reason:
                    continue  # Skip face crop; movement record still saved at finalization

                # Face-visibility check via inter-ocular distance
                face_width   = right - left
                face_visible = True
                if 'left_eye' in landmark and 'right_eye' in landmark:
                    le           = np.mean(landmark['left_eye'], axis=0)
                    re           = np.mean(landmark['right_eye'], axis=0)
                    eye_dist     = float(np.linalg.norm(re - le)) * 2
                    face_visible = eye_dist > face_width * 0.15
                else:
                    face_visible = False

                # Update best face crop for this tracker
                size = (bottom - top) * (right - left)
                if size > pending_alerts[key]['best_size']:
                    h, w     = frame.shape[:2]
                    pad      = int((bottom - top) * 0.25)
                    s_top    = max(0, top    - pad)
                    s_bottom = min(h, bottom + pad)
                    s_left   = max(0, left   - pad)
                    s_right  = min(w, right  + pad)
                    face_img = frame[s_top:s_bottom, s_left:s_right]
                    if face_img.size == 0 or face_img.shape[0] < min_face_px or face_img.shape[1] < min_face_px:
                        continue
                    new_sharpness = cv2.Laplacian(face_img, cv2.CV_64F).var()
                    if new_sharpness < pending_alerts[key].get('sharpness', 0) * 0.70:
                        continue
                    if face_img.shape[0] < 512:
                        scale    = 512 / face_img.shape[0]
                        new_w    = int(face_img.shape[1] * scale)
                        face_img = cv2.resize(face_img, (new_w, 512), interpolation=cv2.INTER_LANCZOS4)
                    pending_alerts[key].update({
                        'best_size': size, 'sharpness': new_sharpness,
                        'face_image': face_img, 'full_frame': frame.copy(),
                        'face_encoding': encoding, 'person_id': person_id,
                        'confidence': confidence, 'role': role,
                        'face_visible': face_visible,
                    })
                    # Accumulate every good crop so the movement record shows all faces seen
                    pending_alerts[key].setdefault('face_images_all', []).append({
                        'image': face_img, 'size': size,
                        'face_visible': face_visible, 'encoding': encoding,
                    })
                    # Clear suppression if the tracker later captures a real face
                    pending_alerts[key]['suppression_reason']  = None
                    pending_alerts[key]['suppression_details'] = {}

            # ── P5: Buffer window finalization ────────────────────────────
            min_window = get_config('detection_buffer_seconds')
            max_window = get_config('max_presence_seconds')
            now = time.time()
            for k in list(pending_alerts.keys()):
                time_since_start     = now - pending_alerts[k]['start_time']
                time_since_last_seen = now - pending_alerts[k].get('last_seen_time', now)

                if time_since_last_seen >= min_window or time_since_start >= max_window:
                    alert_id  = None
                    suppressed = pending_alerts[k].get('suppression_reason')

                    if not suppressed and 'face_image' in pending_alerts[k]:
                        alert_id = process_final_alert(cam, pending_alerts[k], cursor, conn)
                        if alert_id:
                            last_alert_times[k] = now
                            with biometric_memory_lock:
                                # Bug A: per-tracker biometric memory (not per-camera)
                                biometric_memory[k] = now

                    # Save a movement record for every finalized tracker, suppressed or not
                    create_movement_record(cam, pending_alerts[k], alert_id, cursor, conn)
                    del pending_alerts[k]

    except Exception as e:
        logger.error(f"Error in camera loop: {e}")
    finally:
        reader_stop['stop'] = True
        if reader_thread and reader_thread.is_alive():
            reader_thread.join(timeout=2)
        if cap:
            cap.release()
        try:
            cursor.execute("UPDATE cameras SET status = 'offline' WHERE id = %s", (cam_id,))
            conn.commit()
        except:
            pass
        cursor.close()
        conn.close()


class FaceMatcher:
    def __init__(self):
        self.known_encodings = []
        self.known_ids       = []
        self.known_roles     = []
        self.last_load       = 0

    def _parse_rows(self, rows: list) -> tuple:
        """Parse DB rows into (encodings, ids, roles), skipping bad entries."""
        valid_enc, valid_ids, valid_roles = [], [], []
        skipped = 0
        for r in rows:
            try:
                enc = np.array(json.loads(r['faceEncoding']), dtype=np.float64)
                if enc.shape == (128,):
                    valid_enc.append(enc)
                    valid_ids.append(r['id'])
                    valid_roles.append(r['role'])
                else:
                    skipped += 1
            except (json.JSONDecodeError, ValueError):
                skipped += 1
        if skipped:
            logger.warning(f"FaceMatcher: skipped {skipped} person(s) with invalid/empty encodings")
        return valid_enc, valid_ids, valid_roles, skipped

    def load(self):
        if time.time() - self.last_load < 30:
            return
        conn   = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT id, role, faceEncoding FROM persons WHERE faceEncoding IS NOT NULL")
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        enc, ids, roles, _ = self._parse_rows(rows)
        self.known_encodings = enc
        self.known_ids       = ids
        self.known_roles     = roles
        self.last_load       = time.time()

    def match(self, encoding):
        if not self.known_encodings:
            return None, 0.0, None
        distances = face_recognition.face_distance(self.known_encodings, encoding)
        idx = np.argmin(distances)
        if distances[idx] < 0.5:
            return self.known_ids[idx], round((1 - distances[idx]) * 100, 2), self.known_roles[idx]
        return None, round((1 - distances[idx]) * 100, 2), None


def main():
    logger.info("Starting BlueEye CV Worker...")

    # Load initial config from DB; fall back to in-memory defaults if DB not ready
    try:
        conn   = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        load_cv_config_from_db(cursor)
        cursor.close()
        conn.close()
    except Exception as e:
        logger.warning(f"Initial config load skipped: {e}")

    # Background thread refreshes config every 30s without disrupting camera threads
    threading.Thread(target=_config_reload_loop, daemon=True).start()

    matcher          = FaceMatcher()
    last_alert_times = {}
    pending_alerts   = {}
    active_threads   = {}

    while True:
        try:
            matcher.load()
            conn   = get_db_connection()
            cursor = conn.cursor(dictionary=True)
            cursor.execute("SELECT * FROM cameras WHERE status != 'deleted'")
            cams = cursor.fetchall()
            cursor.close()
            conn.close()

            for cam in cams:
                cid = cam['id']
                if cid not in active_threads or not active_threads[cid].is_alive():
                    t = threading.Thread(
                        target=process_camera,
                        args=(cam, matcher, last_alert_times, pending_alerts),
                        daemon=True,
                    )
                    t.start()
                    active_threads[cid] = t
        except Exception as e:
            logger.error(f"Main loop error: {e}")
        time.sleep(10)


if __name__ == "__main__":
    main()
