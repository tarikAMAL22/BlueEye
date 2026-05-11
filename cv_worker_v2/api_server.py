"""
BlueEye CV Worker v2 — api_server.py
Flask API server (port 5000) for identity correction ("Not Him" rematching).
"""

import logging
import os
import threading
from typing import Any, Dict

import cv2
from flask import Flask, jsonify, request

from . import config
from . import db_manager as db
from .biometric_memory import memory as bio_memory

# Haar cascade for face counting — loaded once, thread-safe for reads
_haar_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)

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
