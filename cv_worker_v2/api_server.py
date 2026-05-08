"""
BlueEye CV Worker v2 — api_server.py
Flask API server (port 5000) for identity correction ("Not Him" rematching).
"""

import logging
import threading
from typing import Any, Dict

from flask import Flask, jsonify, request

from . import config
from . import db_manager as db
from .biometric_memory import memory as bio_memory

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
