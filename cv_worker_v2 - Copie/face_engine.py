import face_recognition
import numpy as np
import json
import time
import threading
import logging
from .db_manager import get_db_connection
from .config import MATCH_THRESHOLD, BIOMETRIC_COOLDOWN_DISTANCE, BIOMETRIC_COOLDOWN_SECONDS

logger = logging.getLogger("CV-Worker.FaceEngine")
face_lock = threading.Lock()

class FaceMatcher:
    def __init__(self):
        self.known_encodings = []
        self.known_ids = []
        self.known_roles = []
        self.last_load = 0
    
    def load(self):
        if time.time() - self.last_load < 10:
            return
            
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        try:
            cursor.execute("SELECT id, role, faceEncoding FROM persons WHERE faceEncoding IS NOT NULL")
            rows = cursor.fetchall()
            self.known_encodings = [np.array(json.loads(r['faceEncoding'])) for r in rows]
            self.known_ids = [r['id'] for r in rows]
            self.known_roles = [r['role'] for r in rows]
            self.last_load = time.time()
            logger.info(f"Loaded {len(self.known_encodings)} known identities.")
        finally:
            cursor.close()
            conn.close()

    def match(self, encoding):
        if not self.known_encodings:
            return None, 0.0, None
            
        distances = face_recognition.face_distance(self.known_encodings, encoding)
        idx = np.argmin(distances)
        confidence = round((1 - distances[idx]) * 100, 2)
        
        if distances[idx] < MATCH_THRESHOLD:
            return self.known_ids[idx], confidence, self.known_roles[idx]
        return None, confidence, None

class BiometricMemory:
    def __init__(self):
        self.memory = {} # cam_id: [(encoding, timestamp)]
        self.lock = threading.Lock()

    def is_recent(self, cam_id, encoding):
        now = time.time()
        with self.lock:
            if cam_id not in self.memory:
                return False
            
            # Clean up old
            self.memory[cam_id] = [m for m in self.memory[cam_id] if now - m[1] < BIOMETRIC_COOLDOWN_SECONDS]
            
            recent_encodings = [m[0] for m in self.memory[cam_id]]
            if not recent_encodings:
                return False
                
            distances = face_recognition.face_distance(recent_encodings, encoding)
            if any(d < BIOMETRIC_COOLDOWN_DISTANCE for d in distances):
                return True
        return False

    def add(self, cam_id, encoding):
        now = time.time()
        with self.lock:
            if cam_id not in self.memory:
                self.memory[cam_id] = []
            self.memory[cam_id].append((encoding, now))
