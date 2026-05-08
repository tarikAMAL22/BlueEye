import cv2
import uuid
import os
import json
import logging
from .config import UPLOAD_DIR

logger = logging.getLogger("CV-Worker.Alerts")

def save_alert_to_db(cam, alert_data, cursor, conn):
    cam_id = cam.get('id')
    zone_id = cam.get('zoneId', 1)
    face_image = alert_data['face_image']
    frame = alert_data['full_frame']
    face_encoding = alert_data['face_encoding']
    person_id = alert_data['person_id']
    confidence = alert_data['confidence']
    role = alert_data.get('role', 'UNKNOWN')
    
    unique_id = str(uuid.uuid4())
    face_filename = f"face_{unique_id}.jpg"
    frame_filename = f"frame_{unique_id}.jpg"
    
    face_path = os.path.join(UPLOAD_DIR, face_filename)
    frame_path = os.path.join(UPLOAD_DIR, frame_filename)
    
    # Save files
    cv2.imwrite(face_path, face_image, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    cv2.imwrite(frame_path, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    
    face_url = f"/uploads/{face_filename}"
    frame_url = f"/uploads/{frame_filename}"
    
    # Auto-register unknown persons
    if not person_id:
        try:
            unknown_name = f"unknown-{unique_id[:8]}"
            encoding_json = json.dumps(face_encoding.tolist())
            cursor.execute(
                "INSERT INTO persons (name, role, photoUrl, faceEncoding) VALUES (%s, 'UNKNOWN', %s, %s)", 
                (unknown_name, face_url, encoding_json)
            )
            person_id = cursor.lastrowid
            conn.commit()
            role = 'UNKNOWN'
        except Exception as e:
            logger.error(f"Failed to register unknown: {e}")
            conn.rollback()
            role = 'UNKNOWN'

    threat = 'high' if role == 'UNKNOWN' else 'medium'
    event_type = 'recognized' if (role and role != 'UNKNOWN') else 'unknown'
    
    logger.info(f"🚨 FINALIZING ALERT: {role} (ID: {person_id}) on {cam.get('name')}")
    
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
        logger.error(f"Database insertion error: {e}")
        conn.rollback()
