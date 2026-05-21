"""
BlueEye CV Worker — pending_alerts buffer architecture
  - pending_alerts / last_alert_times / encoding_cooldowns LOCAL per camera thread
  - Quality-based best frame: sharpness × center_score × size_norm
  - IoU + encoding similarity tracker (40/60) for unknown persons
  - Encoding cooldown (enc_hash, 2 min) replaces UUID-based cooldown
  - Cross-contamination: face_image rebuilt from full_frame + crop_coords at finalization
  - Sanity check + encoding coherence check before alert fire
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

BLUR_THRESHOLD         = float(os.environ.get("BLUR_THRESHOLD", "30"))
ALERT_COOLDOWN_SECONDS = 30
ENCODING_COOLDOWN      = 120   # 2 min between alerts for the same face hash

face_lock    = threading.Lock()
stop_signals: dict = {}

_IS_DOCKER = os.environ.get("CV_WORKER_IN_DOCKER", "false").lower() == "true"

UPLOAD_DIR = (
    "/app/client/public/uploads"
    if _IS_DOCKER
    else os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
)
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Global biometric memory: {cam_id: [(encoding, timestamp), ...]}
biometric_memory      = {}
biometric_memory_lock = threading.Lock()


# ─── DB ───────────────────────────────────────────────────────────────────────

def get_db_connection():
    while True:
        try:
            return pymysql.connect(
                host=DB_HOST, user=DB_USER,
                password=DB_PASSWORD, database=DB_NAME,
                cursorclass=pymysql.cursors.DictCursor,
                autocommit=False,
            )
        except Exception as e:
            logger.warning(f"DB connection failed: {e}, retrying in 5s…")
            time.sleep(5)


# ─── Final alert writer ───────────────────────────────────────────────────────

def process_final_alert(cam, alert_data, cursor, conn):
    """Persist alert + event. Returns alert_id or None."""
    cam_id  = cam.get('id')
    zone_id = cam.get('zoneId', 1)

    face_image    = alert_data['face_image']
    frame         = alert_data['full_frame']
    face_encoding = alert_data['face_encoding']
    person_id     = alert_data['person_id']
    confidence    = alert_data['confidence']
    role          = alert_data['role']

    unique_id      = str(uuid.uuid4())
    face_filename  = f"face_{unique_id}.jpg"
    frame_filename = f"frame_{unique_id}.jpg"
    face_path      = os.path.join(UPLOAD_DIR, face_filename)
    frame_path     = os.path.join(UPLOAD_DIR, frame_filename)

    cv2.imwrite(face_path,  face_image, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    cv2.imwrite(frame_path, frame,      [int(cv2.IMWRITE_JPEG_QUALITY), 90])

    face_url  = f"/uploads/{face_filename}"
    frame_url = f"/uploads/{frame_filename}"

    if not person_id:
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
        except Exception as e:
            logger.error(f"Failed to insert unknown person: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            role = 'UNKNOWN'

    threat      = 'high' if role == 'UNKNOWN' else 'medium'
    event_type  = 'recognition' if (role and role != 'UNKNOWN') else 'unknown'
    det_type_db = 'FACE'

    logger.info(f"ALERT: {role} (ID:{person_id}) cam={cam.get('name')} conf={confidence:.1f}%")

    try:
        cursor.execute("""
            INSERT INTO alerts
              (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl,
               confidence, status, threatLevel, detectionType)
            VALUES (%s, %s, %s, %s, %s, %s, 'active', %s, %s)
        """, (person_id, cam_id, zone_id, face_url, frame_url,
              confidence if confidence is not None else 0, threat, det_type_db))
        alert_id = cursor.lastrowid
        conn.commit()
    except Exception as e:
        logger.error(f"Alert INSERT failed: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        return None

    try:
        cursor.execute("""
            INSERT INTO events
              (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl,
               confidence, eventType)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (person_id, cam_id, zone_id, face_url, frame_url,
              confidence if confidence is not None else 0, event_type))
        conn.commit()
    except Exception as e:
        logger.warning(f"Event INSERT failed (alert {alert_id} already saved): {e}")
        try:
            conn.rollback()
        except Exception:
            pass

    return alert_id


# ─── IoU helper ──────────────────────────────────────────────────────────────

def compute_iou(boxA, boxB):
    """Both boxes: (top, right, bottom, left) full-resolution."""
    aT, aR, aB, aL = boxA
    bT, bR, bB, bL = boxB
    iT = max(aT, bT); iL = max(aL, bL)
    iB = min(aB, bB); iR = min(aR, bR)
    inter = max(0, iB - iT) * max(0, iR - iL)
    if inter == 0:
        return 0.0
    aArea = (aB - aT) * (aR - aL)
    bArea = (bB - bT) * (bR - bL)
    return inter / (aArea + bArea - inter)


# ─── Camera worker ────────────────────────────────────────────────────────────

def process_camera(cam, matcher):
    """
    Each camera runs in its own thread with FULLY LOCAL state:
      - pending_alerts     : tracker buffer, accumulates best-quality frame over 3s
      - last_alert_times   : cooldown by tracker key
      - encoding_cooldowns : biometric cooldown by face hash (2 min, enc_hash)
    """
    global biometric_memory

    cam_id      = cam.get('id')
    backend_url = cam.get('rtspUrl') or cam.get('backendUrl') or cam.get('url')
    if not backend_url:
        logger.error(f"Camera {cam.get('name')} has no URL configured.")
        return

    if _IS_DOCKER and ("localhost" in backend_url or "127.0.0.1" in backend_url):
        backend_url = (backend_url
                       .replace("localhost",  "host.docker.internal")
                       .replace("127.0.0.1", "host.docker.internal"))

    conn   = get_db_connection()
    cursor = conn.cursor()
    cap    = None
    frame_count = 0

    # ── LOCAL STATE — never shared between threads ────────────────────────────
    pending_alerts    = {}   # {(cam_id, tracking_id): tracker_dict}
    last_alert_times  = {}   # {(cam_id, tracking_id): timestamp}
    encoding_cooldowns = {}  # {enc_hash: timestamp}

    try:
        while not stop_signals.get(cam_id):

            # ── Connect / reconnect ───────────────────────────────────────────
            if cap is None or not cap.isOpened():
                logger.info(f"Connecting to camera {cam.get('name')} …")
                cap = cv2.VideoCapture(backend_url)
                if not cap.isOpened():
                    time.sleep(5)
                    continue
                try:
                    cursor.execute(
                        "UPDATE cameras SET status='online', lastSeen=NOW() WHERE id=%s",
                        (cam_id,)
                    )
                    conn.commit()
                except Exception as e:
                    logger.error(f"DB heartbeat error: {e}")

            ret, frame = cap.read()
            if not ret:
                cap.release()
                cap = None
                time.sleep(2)
                continue

            frame_count += 1
            if frame_count % 100 == 0:
                logger.info(f"Camera {cam.get('name')}: {frame_count} frames processed")

            # ── Detect faces (HOG on 0.5× frame) ─────────────────────────────
            small_frame = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
            rgb_small   = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)

            with face_lock:
                face_locations = face_recognition.face_locations(rgb_small)

            if face_locations and len(face_locations) < 10:
                with face_lock:
                    face_encodings = face_recognition.face_encodings(rgb_small, face_locations)
                    landmarks      = face_recognition.face_landmarks(rgb_small, face_locations)

                h_frame, w_frame = frame.shape[:2]

                for box, encoding, landmark in zip(face_locations, face_encodings, landmarks):

                    # define now FIRST — before any use
                    now = time.time()

                    # ── Anatomy filter ────────────────────────────────────────
                    n_points = sum(len(v) for v in landmark.values())
                    if n_points < 35:
                        continue
                    if not all(k in landmark for k in
                               ['left_eye', 'right_eye', 'nose_bridge', 'top_lip']):
                        continue

                    # ── Face match ────────────────────────────────────────────
                    person_id, confidence, role = matcher.match(encoding)

                    # ── Biometric cooldown (global per camera) ────────────────
                    is_too_recent = False
                    with biometric_memory_lock:
                        if cam_id in biometric_memory:
                            biometric_memory[cam_id] = [
                                m for m in biometric_memory[cam_id]
                                if now - m[1] < 60
                            ]
                            recent = [m[0] for m in biometric_memory[cam_id]]
                            if recent:
                                dists = face_recognition.face_distance(recent, encoding)
                                if any(d < 0.45 for d in dists):
                                    is_too_recent = True
                    if is_too_recent:
                        continue

                    # ── Encoding cooldown (2 min per face hash) ───────────────
                    enc_hash = tuple(np.round(encoding[:8], 2))
                    if enc_hash in encoding_cooldowns:
                        if now - encoding_cooldowns[enc_hash] < ENCODING_COOLDOWN:
                            continue

                    # ── Confidence floor ──────────────────────────────────────
                    if confidence < 40:
                        continue

                    # ── Scale bbox to full resolution ─────────────────────────
                    f_top, f_right, f_bottom, f_left = [b * 2 for b in box]

                    # ── Size filter ───────────────────────────────────────────
                    if (f_bottom - f_top) < 40:
                        continue

                    # ── IoU + encoding tracker (40/60) for unknowns ───────────
                    tracking_id = person_id

                    if not person_id:
                        found_tracker = None
                        best_score    = 0.0
                        curr_box      = (f_top, f_right, f_bottom, f_left)

                        for p_key, p_data in list(pending_alerts.items()):
                            if p_key[0] != cam_id:
                                continue
                            if not str(p_key[1]).startswith("unk_"):
                                continue

                            stored_box = p_data.get('last_box')
                            iou = compute_iou(curr_box, stored_box) if stored_box else 0.0

                            stored_enc = p_data.get('face_encoding')
                            enc_sim    = 0.0
                            if stored_enc is not None:
                                d       = face_recognition.face_distance([stored_enc], encoding)[0]
                                enc_sim = max(0.0, 1.0 - d)

                            score = 0.4 * iou + 0.6 * enc_sim
                            if score > 0.35 and score > best_score:
                                best_score    = score
                                found_tracker = p_key[1]

                        tracking_id = found_tracker if found_tracker else \
                                      f"unk_{str(uuid.uuid4())[:8]}"

                    key = (cam_id, tracking_id)

                    if key in last_alert_times and \
                       (now - last_alert_times[key]) < ALERT_COOLDOWN_SECONDS:
                        continue

                    # ── Init or update tracker ────────────────────────────────
                    curr_box = (f_top, f_right, f_bottom, f_left)
                    if key not in pending_alerts:
                        pending_alerts[key] = {
                            'start_time':   now,
                            'best_quality': 0.0,
                            'last_box':     curr_box,
                        }
                    else:
                        pending_alerts[key]['last_box'] = curr_box

                    pending_alerts[key]['last_seen_time'] = now

                    # ── Quality-based best frame: sharpness × center × size ───
                    pad       = int((f_bottom - f_top) * 0.3)
                    ct        = max(0,       f_top    - pad)
                    cb        = min(h_frame, f_bottom + int(pad * 1.2))
                    cl        = max(0,       f_left   - pad)
                    cr        = min(w_frame, f_right  + pad)
                    candidate = frame[ct:cb, cl:cr]

                    if candidate.size == 0:
                        continue

                    gray      = cv2.cvtColor(candidate, cv2.COLOR_BGR2GRAY)
                    sharpness = cv2.Laplacian(gray, cv2.CV_64F).var()

                    face_cx      = (f_left + f_right) / 2
                    center_score = 1.0 - (abs(face_cx - w_frame / 2) / (w_frame / 2)) * 0.3
                    size_norm    = ((f_bottom - f_top) * (f_right - f_left)) / (w_frame * h_frame)
                    quality      = sharpness * center_score * (1.0 + size_norm * 2.0)

                    if quality > pending_alerts[key].get('best_quality', 0.0):
                        face_img = candidate.copy()
                        if face_img.shape[0] < 512:
                            face_img = cv2.resize(
                                face_img, (512, 512),
                                interpolation=cv2.INTER_LANCZOS4,
                            )
                        pending_alerts[key].update({
                            'best_quality':  quality,
                            'face_image':    face_img,
                            'full_frame':    frame.copy(),
                            'face_encoding': encoding,
                            'person_id':     person_id,
                            'confidence':    confidence,
                            'role':          role,
                            'crop_coords':   (ct, cb, cl, cr),
                        })

            # ── Finalize matured trackers ──────────────────────────────────────
            now = time.time()
            for k in list(pending_alerts.keys()):
                ts_start = now - pending_alerts[k]['start_time']
                ts_idle  = now - pending_alerts[k].get('last_seen_time', now)

                if ts_start >= 3.0 or ts_idle >= 1.5:
                    data = pending_alerts[k]
                    if 'face_image' not in data:
                        del pending_alerts[k]
                        continue

                    # Fix cross-contamination: rebuild face_image from stored coords
                    if 'crop_coords' in data and 'full_frame' in data:
                        ct2, cb2, cl2, cr2 = data['crop_coords']
                        rebuilt = data['full_frame'][ct2:cb2, cl2:cr2]
                        if rebuilt.size > 0:
                            if rebuilt.shape[0] < 512:
                                rebuilt = cv2.resize(rebuilt, (512, 512),
                                                     interpolation=cv2.INTER_LANCZOS4)
                            data['face_image'] = rebuilt

                    # Sanity check: face must be detectable in the crop
                    rgb_check = cv2.cvtColor(data['face_image'], cv2.COLOR_BGR2RGB)
                    with face_lock:
                        check_locs = face_recognition.face_locations(rgb_check)
                    if not check_locs:
                        logger.warning(f"Sanity fail for {k}: no face in crop — skipping")
                        del pending_alerts[k]
                        continue

                    # Encoding coherence check
                    with face_lock:
                        check_encs = face_recognition.face_encodings(rgb_check, check_locs)
                    if check_encs:
                        d = face_recognition.face_distance([data['face_encoding']],
                                                           check_encs[0])[0]
                        if d > 0.60:
                            logger.warning(
                                f"Cross-tracker contamination {k}: dist={d:.3f} — skipping"
                            )
                            del pending_alerts[k]
                            continue

                    process_final_alert(cam, data, cursor, conn)
                    last_alert_times[k] = now

                    enc_hash = tuple(np.round(data['face_encoding'][:8], 2))
                    encoding_cooldowns[enc_hash] = now

                    with biometric_memory_lock:
                        biometric_memory.setdefault(cam_id, [])
                        biometric_memory[cam_id].append((data['face_encoding'], now))

                    del pending_alerts[k]

    except Exception as e:
        logger.error(f"Camera loop error ({cam.get('name')}): {e}")
    finally:
        if cap:
            cap.release()
        try:
            cursor.execute(
                "UPDATE cameras SET status='offline' WHERE id=%s", (cam_id,)
            )
            conn.commit()
        except Exception as e:
            logger.error(f"Failed to mark camera offline: {e}")
        cursor.close()
        conn.close()


# ─── Face matcher ─────────────────────────────────────────────────────────────

class FaceMatcher:
    def __init__(self):
        self.known_encodings = []
        self.known_ids       = []
        self.known_roles     = []
        self.last_load       = 0
        self._lock           = threading.Lock()

    def load(self):
        if time.time() - self.last_load < 30:
            return
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, role, faceEncoding FROM persons WHERE faceEncoding IS NOT NULL"
        )
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        with self._lock:
            self.known_encodings = [np.array(json.loads(r['faceEncoding'])) for r in rows]
            self.known_ids       = [r['id']   for r in rows]
            self.known_roles     = [r['role'] for r in rows]
            self.last_load       = time.time()
        logger.info(f"FaceMatcher: loaded {len(self.known_encodings)} person(s)")

    def match(self, encoding):
        with self._lock:
            if not self.known_encodings:
                return None, 0.0, None
            dists = face_recognition.face_distance(self.known_encodings, encoding)
            idx   = int(np.argmin(dists))
            conf  = round((1.0 - dists[idx]) * 100, 2)
            if dists[idx] < 0.5:
                return self.known_ids[idx], conf, self.known_roles[idx]
            return None, conf, None


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    logger.info("Starting BlueEye CV Worker …")
    matcher        = FaceMatcher()
    active_threads = {}

    while True:
        try:
            matcher.load()
            conn   = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM cameras WHERE status = 'online'")
            cams = cursor.fetchall()
            cursor.close()
            conn.close()

            online_ids = {cam['id'] for cam in cams}

            # Stop threads for cameras that went offline
            for cid in list(active_threads.keys()):
                if cid not in online_ids and active_threads[cid].is_alive():
                    stop_signals[cid] = True

            for cam in cams:
                cid = cam['id']
                if cid not in active_threads or not active_threads[cid].is_alive():
                    stop_signals[cid] = False
                    t = threading.Thread(
                        target=process_camera,
                        args=(cam, matcher),
                        daemon=True,
                    )
                    t.start()
                    active_threads[cid] = t
                    logger.info(f"Started thread for camera {cam.get('name')} (id={cid})")

        except Exception as e:
            logger.error(f"Main loop error: {e}")

        time.sleep(10)


if __name__ == "__main__":
    main()
