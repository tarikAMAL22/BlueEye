import cv2
import time
import logging
import face_recognition
import numpy as np
import uuid
from .config import (
    MIN_LANDMARK_POINTS, MIN_FACE_HEIGHT, CONFIDENCE_FLOOR, 
    SCENE_BUFFER_SECONDS, PERSON_IDLE_SECONDS, ALERT_COOLDOWN_SECONDS
)
from .db_manager import get_db_connection, update_camera_status
from .alert_manager import save_alert_to_db

from .vision.validator import is_real_face

logger = logging.getLogger("CV-Worker.Processor")
stop_signals = {}

def process_camera(cam, matcher, biometric_memory, last_alert_times, pending_alerts):
    cam_id = cam.get('id')
    raw_url = cam.get('rtspUrl') or cam.get('backendUrl') or cam.get('url', '')
    
    # Docker network fix
    backend_url = raw_url
    if "localhost" in backend_url or "127.0.0.1" in backend_url:
        backend_url = backend_url.replace("localhost", "host.docker.internal").replace("127.0.0.1", "host.docker.internal")

    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    cap = None
    frame_count = 0
    
    try:
        while not stop_signals.get(cam_id):
            if cap is None or not cap.isOpened():
                logger.info(f"Connecting to {cam.get('name')} at {backend_url}...")
                cap = cv2.VideoCapture(backend_url)
                if not cap.isOpened():
                    time.sleep(5)
                    continue
                update_camera_status(cursor, conn, cam_id, 'online')

            ret, frame = cap.read()
            if not ret:
                cap.release()
                cap = None
                time.sleep(2)
                continue

            frame_count += 1
            if frame_count % 10 == 0:
                logger.info(f"Heartbeat: {cam.get('name')} is alive (Total: {frame_count}).")

            # Sampling
            small_frame = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
            rgb_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
            
            face_locations = face_recognition.face_locations(rgb_frame)
            
            if face_locations and len(face_locations) < 10:
                face_encodings = face_recognition.face_encodings(rgb_frame, face_locations)
                landmarks = face_recognition.face_landmarks(rgb_frame, face_locations)

                for box, encoding, landmark in zip(face_locations, face_encodings, landmarks):
                    # 1. Anatomy Filter
                    all_points = sum(len(p) for p in landmark.values())
                    if all_points < MIN_LANDMARK_POINTS:
                        logger.info(f"Face rejected (Anatomy): Only {all_points} points found (Min: {MIN_LANDMARK_POINTS})")
                        continue
                    
                    missing = [k for k in ['left_eye', 'right_eye', 'nose_bridge'] if k not in landmark]
                    if missing:
                        logger.info(f"Face rejected (Incomplete): Missing {missing}")
                        continue

                    # 2. Recognition
                    person_id, confidence, role = matcher.match(encoding)

                    # 3. Biometric Suppression
                    if biometric_memory.is_recent(cam_id, encoding):
                        continue
                    
                    # 4. Confidence & Size Filters
                    # Only apply confidence floor if it's a match. Unknowns can be 0.0% if DB is empty.
                    if person_id is not None and confidence < CONFIDENCE_FLOOR:
                        logger.info(f"Face rejected (Match Confidence): Score {confidence}% too low for match (Min: {CONFIDENCE_FLOOR})")
                        continue
                        
                    top, right, bottom, left = [b * 2 for b in box]
                    face_h = bottom - top
                    if face_h < MIN_FACE_HEIGHT:
                        logger.info(f"Face rejected (Size): Height {face_h}px too small (Min: {MIN_FACE_HEIGHT})")
                        continue

                    # 5. Tracking Logic (Proximity + Biometric 1:1)
                    tracking_id = person_id
                    if not person_id:
                        found_tracker = None
                        for p_key, p_data in pending_alerts.items():
                            if p_key[0] == cam_id and str(p_key[1]).startswith("unk_"):
                                # A. Check Spatial Proximity
                                o_top, o_left = p_data.get('last_pos', (top, left))
                                if ((top-o_top)**2 + (left-o_left)**2)**0.5 < 400:
                                    found_tracker = p_key[1]
                                    break
                                
                                # B. Check Biometric 1:1 (If spatial failed)
                                # Compare current encoding with pending encoding
                                if 'face_encoding' in p_data:
                                    dist = face_recognition.face_distance([p_data['face_encoding']], encoding)[0]
                                    if dist < 0.60: # More permissive merge
                                        found_tracker = p_key[1]
                                        logger.info(f"Biometric Merge (Aggressive): Combined {p_key[1]} based on 1:1 match.")
                                        break
                                    
                        tracking_id = found_tracker if found_tracker else f"unk_{str(uuid.uuid4())[:8]}"

                    key = (cam_id, tracking_id)
                    now = time.time()
                    
                    # Cooldown check
                    if key in last_alert_times and (now - last_alert_times[key]) < ALERT_COOLDOWN_SECONDS:
                        continue
                        
                    if key not in pending_alerts:
                        pending_alerts[key] = {'start_time': now, 'best_size': 0, 'last_pos': (top, left), 'face_encoding': encoding}
                    
                    pending_alerts[key]['last_pos'] = (top, left)
                    pending_alerts[key]['last_seen_time'] = now
                    
                    size = (bottom-top) * (right-left)
                    if size > pending_alerts[key]['best_size']:
                        h, w = frame.shape[:2]
                        pad = int((bottom-top)*0.3)
                        s_top, s_bottom = max(0, top-pad), min(h, bottom+int(pad*1.2))
                        s_left, s_right = max(0, left-pad), min(w, right+pad)
                        face_img = frame[s_top:s_bottom, s_left:s_right]
                        if face_img.size > 0:
                            if face_img.shape[0] < 512: 
                                face_img = cv2.resize(face_img, (512, 512), interpolation=cv2.INTER_LANCZOS4)
                            pending_alerts[key].update({
                                'best_size': size, 'face_image': face_img, 'full_frame': frame.copy(),
                                'face_encoding': encoding, 'person_id': person_id, 'confidence': confidence, 'role': role
                            })

            # Process aging alerts
            now = time.time()
            for k in list(pending_alerts.keys()):
                time_since_start = now - pending_alerts[k]['start_time']
                time_since_last_seen = now - pending_alerts[k].get('last_seen_time', now)
                
                if time_since_start >= SCENE_BUFFER_SECONDS or time_since_last_seen >= PERSON_IDLE_SECONDS:
                    if 'face_image' in pending_alerts[k]:
                        # FINAL VALIDATION: Secondary Check
                        if is_real_face(pending_alerts[k]['face_image']):
                            save_alert_to_db(cam, pending_alerts[k], cursor, conn)
                            last_alert_times[k] = now
                            biometric_memory.add(cam_id, pending_alerts[k]['face_encoding'])
                        else:
                            logger.info(f"Alert Suppressed: Face verification failed on finalize for {k}")
                    del pending_alerts[k]

    except Exception as e:
        logger.error(f"Processor Error for {cam.get('name')}: {e}")
    finally:
        if cap: cap.release()
        update_camera_status(cursor, conn, cam_id, 'offline')
        cursor.close()
        conn.close()
