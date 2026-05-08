import cv2
import os
import uuid
import json
import numpy as np
import logging
from flask import Flask, request, jsonify
from .db_manager import get_db_connection
from .config import UPLOAD_DIR

logger = logging.getLogger("CV-Worker.API")

def create_app(matcher):
    app = Flask(__name__)

    @app.route('/re-match', methods=['POST'])
    def handle_re_match():
        data = request.json
        alert_id = data.get('alertId')
        if not alert_id:
            return jsonify({"error": "Missing alertId"}), 400
            
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        
        try:
            cursor.execute("SELECT * FROM alerts WHERE id = %s", (alert_id,))
            alert = cursor.fetchone()
            if not alert:
                return jsonify({"error": "Alert not found"}), 404
                
            old_person_id = alert['personId']
            face_url = alert['faceSnapshotUrl']
            
            local_path = face_url
            if face_url.startswith("/uploads/"):
                local_path = os.path.join("/app/client/public", face_url.lstrip("/"))
                
            image = cv2.imread(local_path)
            if image is None:
                return jsonify({"error": "Could not read image"}), 500
                
            rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            import face_recognition
            encodings = face_recognition.face_encodings(rgb_image)
                
            if not encodings:
                return jsonify({"error": "No face detected in snapshot"}), 404
                
            face_encoding = encodings[0]
            person_id, confidence, role = matcher.match(face_encoding)
            
            if person_id == old_person_id:
                person_id = None
            
            if not person_id:
                u_id = str(uuid.uuid4())
                unknown_name = f"unknown-{u_id[:8]}"
                encoding_json = json.dumps(face_encoding.tolist())
                cursor.execute(
                    "INSERT INTO persons (name, role, photoUrl, faceEncoding) VALUES (%s, 'UNKNOWN', %s, %s)", 
                    (unknown_name, face_url, encoding_json)
                )
                person_id = cursor.lastrowid
                logger.info(f"🆕 'Not Him' triggered: Created new unknown {unknown_name}")
            else:
                logger.info(f"🔄 'Not Him' triggered: Re-assigned to {person_id}")

            cursor.execute("UPDATE alerts SET personId = %s WHERE id = %s", (person_id, alert_id))
            cursor.execute("UPDATE events SET personId = %s WHERE faceSnapshotUrl = %s", (person_id, face_url))
            conn.commit()
            
            return jsonify({"success": True, "newPersonId": person_id})
            
        except Exception as e:
            logger.error(f"API Error: {e}")
            return jsonify({"error": str(e)}), 500
        finally:
            cursor.close()
            conn.close()

    return app
