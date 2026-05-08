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

ALERT_COOLDOWN_SECONDS = 30
cv_lock = threading.Lock()
face_lock = threading.Lock()
stop_signals = {} 

def get_db_connection():
    while True:
        try:
            return mysql.connector.connect(host=DB_HOST, user=DB_USER, password=DB_PASSWORD, database=DB_NAME)
        except:
            time.sleep(5)

def process_final_alert(cam, alert_data, cursor, conn):
    cam_id = cam.get('id')
    zone_id = cam.get('zoneId', 1)
    face_image = alert_data['face_image']
    frame = alert_data['full_frame']
    face_encoding = alert_data['face_encoding']
    person_id = alert_data['person_id']
    confidence = alert_data['confidence']
    role = alert_data['role']
    
    unique_id = str(uuid.uuid4())
    face_filename = f"face_{unique_id}.jpg"
    frame_filename = f"frame_{unique_id}.jpg"
    
    face_path = os.path.join(UPLOAD_DIR, face_filename)
    frame_path = os.path.join(UPLOAD_DIR, frame_filename)
    
    cv2.imwrite(face_path, face_image, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    cv2.imwrite(frame_path, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    
    face_url = f"/uploads/{face_filename}"
    frame_url = f"/uploads/{frame_filename}"
    
    if not person_id:
        try:
            unknown_name = f"unknown-{unique_id[:8]}"
            encoding_json = json.dumps(face_encoding.tolist())
            cursor.execute("INSERT INTO persons (name, role, photoUrl, faceEncoding) VALUES (%s, 'UNKNOWN', %s, %s)", 
                         (unknown_name, face_url, encoding_json))
            person_id = cursor.lastrowid
            conn.commit()
            role = 'UNKNOWN'
        except:
            conn.rollback()
            role = 'UNKNOWN'

    threat = 'high' if role == 'UNKNOWN' else 'medium'
    event_type = 'recognized' if (role and role != 'UNKNOWN') else 'unknown'
    
    logger.info(f"🚨 ALERT: {role} (ID: {person_id}) on {cam.get('name')}")
    
    try:
        cursor.execute("""
            INSERT INTO alerts (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl, confidence, status, threatLevel) 
            VALUES (%s, %s, %s, %s, %s, %s, 'active', %s)
        """, (person_id, cam_id, zone_id, face_url, frame_url, confidence, threat))
        
        cursor.execute("""
            INSERT INTO events (personId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl, confidence, eventType) 
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (person_id, cam_id, zone_id, face_url, frame_url, confidence, event_type))
        conn.commit()
    except Exception as e:
        logger.error(f"DB Error: {e}")
        conn.rollback()

# Global memory for biometric cooldowns
# Format: {'cam_id': [(encoding, timestamp), ...]}
biometric_memory = {}
biometric_memory_lock = threading.Lock()

def process_camera(cam, matcher, last_alert_times, pending_alerts):
    global biometric_memory
    cam_id = cam.get('id')
    # Use ANY available URL field to avoid KeyError
    backend_url = cam.get('rtspUrl') or cam.get('backendUrl') or cam.get('url')
    if not backend_url:
        logger.error(f"Camera {cam.get('name')} has no URL!")
        return

    # Docker network fix
    if "localhost" in backend_url or "127.0.0.1" in backend_url:
        backend_url = backend_url.replace("localhost", "host.docker.internal").replace("127.0.0.1", "host.docker.internal")

    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    cap = None
    frame_count = 0
    
    try:
        while not stop_signals.get(cam_id):
            if cap is None or not cap.isOpened():
                logger.info(f"Connecting to {cam.get('name')}...")
                cap = cv2.VideoCapture(backend_url)
                if not cap.isOpened():
                    time.sleep(5)
                    continue
                cursor.execute("UPDATE cameras SET status = 'online', lastSeen = NOW() WHERE id = %s", (cam_id,))
                conn.commit()

            ret, frame = cap.read()
            if not ret:
                cap.release()
                cap = None
                time.sleep(2)
                continue

            frame_count += 1
            if frame_count % 10 == 0:
                logger.info(f"Heartbeat: Camera {cam.get('name')} is processing frames (Total: {frame_count})")

            small_frame = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
            rgb_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
            
            with cv_lock:
                face_locations = face_recognition.face_locations(rgb_frame)
            
            if face_locations and len(face_locations) < 10:
                with face_lock:
                    face_encodings = face_recognition.face_encodings(rgb_frame, face_locations)
                    landmarks = face_recognition.face_landmarks(rgb_frame, face_locations)

                for box, encoding, landmark in zip(face_locations, face_encodings, landmarks):
                    # 1. Point count & Anatomy filter (Extreme anti-Tshirt)
                    # A real face has ~68 points. T-shirts with noise usually have < 25.
                    all_landmark_points = sum(len(p) for p in landmark.values())
                    if all_landmark_points < 35: continue
                    
                    # Must have eyes AND nose AND mouth
                    required = ['left_eye', 'right_eye', 'nose_bridge', 'top_lip']
                    if not all(k in landmark for k in required): continue

                    person_id = None
                    confidence = 0
                    role = None
                    person_id, confidence, role = matcher.match(encoding)

                    # 1. Biometric Cooldown Check (The 'Ultimate' Filter)
                    # Check if this face (unknown or known) has alerted recently on this camera
                    is_too_recent = False
                    with biometric_memory_lock:
                        if cam_id in biometric_memory:
                            # Clean up old entries first
                            biometric_memory[cam_id] = [m for m in biometric_memory[cam_id] if now - m[1] < 60]
                            
                            # Compare current face with recent alerts
                            recent_encodings = [m[0] for m in biometric_memory[cam_id]]
                            if recent_encodings:
                                distances = face_recognition.face_distance(recent_encodings, encoding)
                                if any(d < 0.45 for d in distances): # Strict matching
                                    is_too_recent = True
                                    logger.info(f"Biometric suppression triggered for camera {cam_id}: Same face detected recently.")
                    
                    if is_too_recent:
                        continue

                    # 2. Confidence Floor (Even for Unknowns)
                    # If the AI is less than 40% sure it's a face, reject noise
                    if confidence < 40: 
                        continue

                    # 3. Size Filter
                    top, right, bottom, left = [b * 2 for b in box]
                    if (bottom - top) < 40: # Ignore tiny distant faces/noise
                        continue
                    
                    tracking_id = person_id
                    
                    # Smart Tracking for Unknowns: 
                    # If it's unknown, look if we already have a pending unknown nearby
                    tracking_id = person_id
                    if not person_id:
                        # Try to find a nearby 'unknown' tracker
                        found_tracker = None
                        for p_key, p_data in pending_alerts.items():
                            if p_key[0] == cam_id and str(p_key[1]).startswith("unk_"):
                                # Calculate distance between current detection and existing tracker
                                old_top, old_left = p_data.get('last_pos', (top, left))
                                dist = ((top - old_top)**2 + (left - old_left)**2)**0.5
                                if dist < 400: # 400px radius for same person tracking
                                    found_tracker = p_key[1]
                                    break
                        
                        if found_tracker:
                            tracking_id = found_tracker
                        else:
                            # Create a truly unique tracking ID for this new person
                            tracking_id = f"unk_{str(uuid.uuid4())[:8]}"
                    
                    key = (cam_id, tracking_id)
                    
                    now = time.time()
                    if key in last_alert_times and (now - last_alert_times[key]) < ALERT_COOLDOWN_SECONDS:
                        continue
                        
                    if key not in pending_alerts:
                        pending_alerts[key] = {'start_time': now, 'best_size': 0, 'last_pos': (top, left)}
                    else:
                        # Update position for tracking
                        pending_alerts[key]['last_pos'] = (top, left)
                    
                    size = (bottom-top) * (right-left)
                    pending_alerts[key]['last_seen_time'] = now
                    if size > pending_alerts[key]['best_size']:
                        h, w = frame.shape[:2]
                        pad = int((bottom-top)*0.3)
                        s_top, s_bottom = max(0, top-pad), min(h, bottom+int(pad*1.2))
                        s_left, s_right = max(0, left-pad), min(w, right+pad)
                        face_img = frame[s_top:s_bottom, s_left:s_right]
                        if face_img.size > 0:
                            if face_img.shape[0] < 512: face_img = cv2.resize(face_img, (512, 512), interpolation=cv2.INTER_LANCZOS4)
                            pending_alerts[key].update({
                                'best_size': size, 'face_image': face_img, 'full_frame': frame.copy(),
                                'face_encoding': encoding, 'person_id': person_id, 'confidence': confidence, 'role': role
                            })

            # Buffer window: Increase to 3.0s for better grouping of moving people
            now = time.time()
            for k in list(pending_alerts.keys()):
                # We finalize if the person hasn't been seen for 1.5s OR if the window is > 3s
                time_since_start = now - pending_alerts[k]['start_time']
                time_since_last_seen = now - pending_alerts[k].get('last_seen_time', now)
                
                if time_since_start >= 3.0 or time_since_last_seen >= 1.5:
                    if 'face_image' in pending_alerts[k]:
                        process_final_alert(cam, pending_alerts[k], cursor, conn)
                        last_alert_times[k] = now
                        
                        # Add to Biometric Memory to prevent immediate duplicates
                        with biometric_memory_lock:
                            if cam_id not in biometric_memory:
                                biometric_memory[cam_id] = []
                            biometric_memory[cam_id].append((pending_alerts[k]['face_encoding'], now))
                            
                    del pending_alerts[k]

    except Exception as e:
        logger.error(f"Error in camera loop: {e}")
    finally:
        if cap: cap.release()
        try:
            cursor.execute("UPDATE cameras SET status = 'offline' WHERE id = %s", (cam_id,))
            conn.commit()
        except: pass
        cursor.close()
        conn.close()

class FaceMatcher:
    def __init__(self):
        self.known_encodings = []
        self.known_ids = []
        self.known_roles = []
        self.last_load = 0
    
    def load(self):
        if time.time() - self.last_load < 30: return
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT id, role, faceEncoding FROM persons WHERE faceEncoding IS NOT NULL")
        rows = cursor.fetchall()
        self.known_encodings = [np.array(json.loads(r['faceEncoding'])) for r in rows]
        self.known_ids = [r['id'] for r in rows]
        self.known_roles = [r['role'] for r in rows]
        self.last_load = time.time()
        cursor.close()
        conn.close()

    def match(self, encoding):
        if not self.known_encodings: return None, 0.0, None
        distances = face_recognition.face_distance(self.known_encodings, encoding)
        idx = np.argmin(distances)
        if distances[idx] < 0.5:
            return self.known_ids[idx], round((1-distances[idx])*100, 2), self.known_roles[idx]
        return None, round((1-distances[idx])*100, 2), None

def main():
    logger.info("Starting BlueEye CV Worker (Clean Version)...")
    matcher = FaceMatcher()
    last_alert_times = {}
    pending_alerts = {}
    active_threads = {}
    
    while True:
        try:
            matcher.load()
            conn = get_db_connection()
            cursor = conn.cursor(dictionary=True)
            cursor.execute("SELECT * FROM cameras WHERE status != 'deleted'")
            cams = cursor.fetchall()
            cursor.close()
            conn.close()
            
            for cam in cams:
                cid = cam['id']
                if cid not in active_threads or not active_threads[cid].is_alive():
                    t = threading.Thread(target=process_camera, args=(cam, matcher, last_alert_times, pending_alerts), daemon=True)
                    t.start()
                    active_threads[cid] = t
        except Exception as e:
            logger.error(f"Main loop error: {e}")
        time.sleep(10)

if __name__ == "__main__":
    main()
