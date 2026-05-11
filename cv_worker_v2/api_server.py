"""
BlueEye CV Worker v2 — api_server.py
Flask API server (port 5000) for identity correction ("Not Him" rematching).
"""

import json
import logging
import os
import threading
from typing import Any, Dict

import cv2
import face_recognition
import numpy as np
from flask import Flask, jsonify, request

from . import config
from . import db_manager as db
from .biometric_memory import memory as bio_memory

# Haar cascade for face counting — loaded once, thread-safe for reads
_haar_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)

# Serialise all face_recognition / dlib calls (not thread-safe)
_encode_lock = threading.Lock()

logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False


# ─── Health ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return jsonify({"status": "ok", "service": "blueeye-cv-worker-v2"})


# ─── Rematching: "Not Him" ────────────────────────────────────────────────────

@app.post("/api/re-match")
def re_match():
    """
    User flagged identification as wrong. 
    Worker should re-analyze and assign to next best match or new unknown.
    """
    body = request.get_json(force=True, silent=True) or {}
    alert_id = body.get("alertId")

    if not isinstance(alert_id, int):
        return jsonify({"error": "alertId must be an integer"}), 400

    try:
        # In a real production scenario, this might trigger a background task
        # For now, we perform the update synchronously via db_manager
        result = db.process_not_him(alert_id)
        return jsonify({
            "status": "re-identified", 
            "alertId": alert_id, 
            "newPersonId": result.get("newPersonId"),
            "newPersonName": result.get("newPersonName")
        })
    except Exception as exc:
        logger.error("Re-match failed: %s", exc)
        return jsonify({"error": str(exc)}), 500


# ─── Face count in a saved frame ─────────────────────────────────────────────

@app.post("/api/count-faces")
def count_faces():
    """
    Count faces in a saved best-frame image using Haar cascade.
    Body: { "imageUrl": "/uploads/frame_xxx.jpg" }
    Returns: { "faceCount": N, "locations": [[x,y,w,h], ...] }
    """
    body = request.get_json(force=True, silent=True) or {}
    image_url = body.get("imageUrl", "")

    if not image_url:
        return jsonify({"error": "imageUrl is required"}), 400

    # Resolve URL path to filesystem path
    # imageUrl is like "/uploads/frame_xxx.jpg"
    rel_path = image_url.lstrip("/")  # "uploads/frame_xxx.jpg"
    abs_path = os.path.join(os.getcwd(), rel_path)

    # Try UPLOAD_DIR as well
    if not os.path.exists(abs_path):
        filename = os.path.basename(image_url)
        abs_path = os.path.join(config.UPLOAD_DIR, filename)

    if not os.path.exists(abs_path):
        return jsonify({"error": f"Image not found: {image_url}"}), 404

    img = cv2.imread(abs_path)
    if img is None:
        return jsonify({"error": "Could not read image"}), 422

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = _haar_cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=4,
        minSize=(30, 30),
    )

    face_list = []
    if len(faces) > 0:
        for (x, y, w, h) in faces:
            face_list.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h)})

    return jsonify({
        "faceCount": len(face_list),
        "locations": face_list,
        "imageUrl": image_url,
    })


# ─── Cooldown inspection (debug) ─────────────────────────────────────────────

@app.get("/api/memory/clear")
def clear_memory():
    """Clear the biometric cooldown cache (admin/debug use)."""
    bio_memory.clear()
    return jsonify({"status": "cleared"})


@app.post("/api/memory/invalidate")
def invalidate_person():
    """
    Invalidate cooldown entries for a specific person.

    Body: { "personId": 123 }
    """
    body = request.get_json(force=True, silent=True) or {}
    pid  = body.get("personId")
    if not isinstance(pid, int):
        return jsonify({"error": "personId must be an integer"}), 400
    removed = bio_memory.invalidate(pid)
    return jsonify({"status": "invalidated", "personId": pid, "removedEntries": removed})


# ─── Compute face encoding from saved photo ───────────────────────────────────

@app.post("/api/encode-person")
def encode_person():
    """
    Compute a face encoding from a person's stored photo and persist it.
    Body: { "personId": 123 }
    Returns: { "status": "ok"|"no_face"|"no_photo", "personId": 123 }
    """
    import pymysql.cursors as _cursors  # noqa: F811

    body = request.get_json(force=True, silent=True) or {}
    person_id = body.get("personId")

    if not isinstance(person_id, int):
        return jsonify({"error": "personId must be an integer"}), 400

    # 1. Fetch person photo URL from DB
    with db.get_connection() as conn:
        with conn.cursor(_cursors.DictCursor) as cur:
            cur.execute("SELECT id, photoUrl FROM persons WHERE id = %s", (person_id,))
            person = cur.fetchone()

    if not person:
        return jsonify({"error": f"Person {person_id} not found"}), 404

    photo_url = (person.get("photoUrl") or "").strip()
    if not photo_url:
        return jsonify({"status": "no_photo", "personId": person_id})

    # 2. Resolve photo URL to an absolute filesystem path
    filename = os.path.basename(photo_url)
    candidates = [
        os.path.join("/app/client/public", photo_url.lstrip("/")),
        os.path.join(os.getcwd(), "client/public", photo_url.lstrip("/")),
        os.path.join(config.UPLOAD_DIR, filename),
    ]
    abs_path = next((p for p in candidates if os.path.exists(p)), None)

    if abs_path is None:
        logger.warning("encode-person: photo not found for person %d: %s", person_id, photo_url)
        return jsonify({"status": "no_photo", "personId": person_id, "detail": f"file not found: {photo_url}"})

    # 3. Load image and compute encoding (serialised — dlib is not thread-safe)
    img = cv2.imread(abs_path)
    if img is None:
        return jsonify({"error": f"Could not read image: {abs_path}"}), 422

    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    with _encode_lock:
        locations = face_recognition.face_locations(rgb, model="hog")
        if not locations:
            logger.info("encode-person: no face found for person %d in %s", person_id, abs_path)
            return jsonify({"status": "no_face", "personId": person_id})
        encodings = face_recognition.face_encodings(rgb, locations)

    if not encodings:
        return jsonify({"status": "no_face", "personId": person_id})

    # 4. Persist the encoding (use the first/largest detected face)
    encoding_json = json.dumps(encodings[0].tolist())
    with db.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE persons SET faceEncoding = %s WHERE id = %s",
                (encoding_json, person_id),
            )
        conn.commit()

    logger.info("encode-person: stored encoding for person %d from %s", person_id, abs_path)
    return jsonify({"status": "ok", "personId": person_id})


# ─── Server launcher ─────────────────────────────────────────────────────────

class APIServer:
    """Wraps Flask in a daemon thread."""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="flask-api"
        )
        self._thread.start()
        logger.info(
            "Flask API server starting on %s:%d",
            config.FLASK_HOST, config.FLASK_PORT,
        )

    def _run(self) -> None:
        # Use werkzeug's simple server; swap for gunicorn in prod
        app.run(
            host=config.FLASK_HOST,
            port=config.FLASK_PORT,
            use_reloader=False,
            threaded=True,
        )
