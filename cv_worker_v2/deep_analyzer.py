"""
BlueEye CV Worker v2 — deep_analyzer.py
Secondary analysis worker: scans full frames for multiple people and identifes them.
"""

import logging
import os
import time
import cv2
import json
import threading
import pymysql
from typing import List, Dict, Any

from . import config
from . import db_manager as db
from .face_engine import engine as face_engine

logger = logging.getLogger(__name__)

class DeepAnalyzer(threading.Thread):
    """
    Background worker that performs secondary high-precision scan on created alerts.
    Detects if multiple people are present in the full frame.
    """
    def __init__(self, interval_sec: int = 5):
        super().__init__(daemon=True, name="DeepAnalyzer")
        self.interval_sec = interval_sec
        self._stop_evt = threading.Event()

    def stop(self):
        self._stop_evt.set()

    def run(self):
        logger.info("DeepAnalyzer worker started")
        while not self._stop_evt.is_set():
            try:
                self._process_pending_alerts()
            except Exception as e:
                logger.error("DeepAnalyzer error: %s", e, exc_info=True)
            time.sleep(self.interval_sec)

    def _process_pending_alerts(self):
        # 1. Fetch alerts that haven't been deep-analyzed yet
        # We use metadata -> '$.deepAnalyzed' check
        sql = "SELECT id, bestFrameSnapshotUrl FROM alerts WHERE metadata IS NULL OR JSON_EXTRACT(metadata, '$.deepAnalyzed') IS NULL LIMIT 10"
        
        alerts_to_process = []
        with db.get_connection() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as dict_cur:
                dict_cur.execute(sql)
                alerts_to_process = dict_cur.fetchall()

        for alert in alerts_to_process:
            self._analyze_alert(alert)

    def _analyze_alert(self, alert: Dict[str, Any]):
        alert_id = alert['id']
        logger.info("DeepAnalyzer: Processing alert #%d for secondary analysis...", alert_id)
        frame_url = alert['bestFrameSnapshotUrl']
        if not frame_url:
            return

        # Map /uploads/ to local path
        filename = frame_url.replace("/uploads/", "")
        local_path = os.path.join(config.UPLOAD_DIR, filename)

        if not os.path.exists(local_path):
            logger.warning("DeepAnalyzer: Frame file not found: %s", local_path)
            self._mark_as_analyzed(alert_id, {"error": "file_not_found"})
            return

        # 2. Load image
        frame_bgr = cv2.imread(local_path)
        if frame_bgr is None:
            return

        # 3. Detect ALL faces with high precision (HOG + upsampling)
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        locations, encodings = face_engine.detect_faces(rgb, model="hog", upsample=1)
        
        # 3b. Detect ALL people (bodies) using OpenCV HOG detector
        # This helps if faces are too far but bodies are visible
        hog_people = cv2.HOGDescriptor()
        hog_people.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        (bodies, _) = hog_people.detectMultiScale(frame_bgr, winStride=(8,8), padding=(32,32), scale=1.05)
        
        detected_faces_count = len(locations)
        detected_bodies_count = len(bodies)
        
        # We consider 'multi-face' if we have multiple faces OR multiple bodies
        multi_detected = (detected_faces_count > 1) or (detected_bodies_count > 1)
        
        identified_persons = []

        if detected_faces_count > 0:
            for encoding in encodings:
                person, similarity = face_engine.identify(encoding)
                if person:
                    identified_persons.append({
                        "id": person["id"],
                        "name": person["name"],
                        "confidence": round(similarity * 100, 2)
                    })
                else:
                    identified_persons.append({
                        "id": None,
                        "name": "Unknown",
                        "confidence": 0
                    })

        # 4. Prepare metadata
        metadata = {
            "deepAnalyzed": True,
            "multiFaceDetected": multi_detected,
            "faceCount": detected_faces_count,
            "bodyCount": detected_bodies_count,
            "detectedPersons": identified_persons,
            "analyzedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        }

        # 5. Update alert
        self._mark_as_analyzed(alert_id, metadata)
        
        if multi_detected:
            logger.info("DeepAnalyzer: Alert #%d - MULTIPLE PEOPLE DETECTED (faces=%d, bodies=%d)", alert_id, detected_faces_count, detected_bodies_count)

    def _mark_as_analyzed(self, alert_id: int, metadata: Dict[str, Any]):
        # We need to merge with existing metadata if any
        # But for now, we just set it
        sql = "UPDATE alerts SET metadata = %s WHERE id = %s"
        with db.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (json.dumps(metadata), alert_id))
            conn.commit()

# Singleton instance
analyzer = DeepAnalyzer()
