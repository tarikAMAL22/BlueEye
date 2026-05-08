"""
BlueEye CV Worker v2 — main.py
Entry point. Orchestrates all modules and spawns per-camera threads.

Usage:
    python -m cv_worker_v2.main

Camera configuration is read from the `cameras` table in MySQL,
or falls back to the CAMERAS env var (JSON array of {id, rtspUrl}).

    CAMERAS='[{"id":1,"rtspUrl":"rtsp://..."}]' python -m cv_worker_v2.main
"""

import json
import logging
import os
import signal
import sys
import time
from typing import List, Dict, Any

from . import config                          # noqa: F401 — triggers logging setup
from . import db_manager as db
from .face_engine import engine as face_engine
from .processor import CameraProcessor
from .api_server import APIServer

logger = logging.getLogger(__name__)


# ─── Camera discovery ─────────────────────────────────────────────────────────

def _load_cameras_from_db() -> List[Dict[str, Any]]:
    """Fetch active cameras from the database."""
    sql = "SELECT id, zoneId, rtspUrl FROM cameras WHERE status = 'online'"
    with db.get_connection() as conn:
        import pymysql
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(sql)
            return cur.fetchall()


def _load_cameras_from_env() -> List[Dict[str, Any]]:
    raw = os.getenv("CAMERAS", "[]")
    try:
        cams = json.loads(raw)
        assert isinstance(cams, list)
        return cams
    except (json.JSONDecodeError, AssertionError):
        logger.error("CAMERAS env var is not valid JSON — expected [{id, rtspUrl}, ...]")
        return []


def load_cameras() -> List[Dict[str, Any]]:
    try:
        cams = _load_cameras_from_db()
        if cams:
            logger.info("Loaded %d cameras from database", len(cams))
            return cams
    except Exception as exc:
        logger.warning("Could not load cameras from DB: %s — falling back to env", exc)

    cams = _load_cameras_from_env()
    logger.info("Loaded %d cameras from CAMERAS env var", len(cams))
    return cams


# ─── Graceful shutdown ────────────────────────────────────────────────────────
_processors: Dict[int, CameraProcessor] = {}  # camera_id -> processor


def _shutdown(sig, frame):  # noqa: ARG001
    logger.info("Shutdown signal received — stopping all processors …")
    for proc in _processors.values():
        proc.stop()
    from .processor import detection_pool, persistence_worker
    detection_pool.stop()
    persistence_worker.stop()
    face_engine.stop()
    logger.info("BlueEye CV Worker v2 stopped.")
    sys.exit(0)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    logger.info("=" * 60)
    logger.info("  BlueEye CV Worker v2  —  starting up")
    logger.info("=" * 60)

    # Register signals
    signal.signal(signal.SIGINT,  _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    # Initialise face engine (loads identities, starts reload thread)
    face_engine.start()

    # Start Flask API server
    api = APIServer()
    api.start()

    # Start detection worker pool + persistence worker (decoupled pipeline)
    from .processor import detection_pool, persistence_worker
    detection_pool.start()
    persistence_worker.start()
    logger.info(
        "Detection pipeline started — detection_workers=%d, frame_queue_size=%d",
        detection_pool._n,
        detection_pool._n,
    )

    # Start Deep Analysis worker
    from .deep_analyzer import analyzer
    analyzer.start()

    logger.info("Dynamic camera discovery active (every %ds)", config.CAMERA_RELOAD_SEC)

    # Main orchestration loop
    while True:
        try:
            # Discover active cameras from DB
            active_cams = load_cameras()
            active_ids = {int(c["id"]) for c in active_cams}

            # 1. Stop processors for cameras no longer in the active list
            for cam_id in list(_processors.keys()):
                if cam_id not in active_ids:
                    logger.info("Stopping processor for camera %d (deactivated/deleted)", cam_id)
                    _processors[cam_id].stop()
                    del _processors[cam_id]

            # 2. Start processors for newly discovered active cameras
            for cam in active_cams:
                cam_id = int(cam["id"])
                if cam_id not in _processors:
                    rtsp_url = cam.get("rtspUrl") or cam.get("rtsp_url", "")
                    if not rtsp_url:
                        continue
                    zone_id = cam.get("zoneId") or 1
                    
                    logger.info("Starting new processor for camera %d: %s", cam_id, rtsp_url)
                    proc = CameraProcessor(camera_id=cam_id, zone_id=int(zone_id), rtsp_url=rtsp_url)
                    proc.start()
                    _processors[cam_id] = proc

            # 3. Monitor health of running processors
            dead_ids = []
            for cam_id, proc in _processors.items():
                # Check if thread died
                if not proc.is_alive():
                    logger.warning("Processor for camera %d has died!", cam_id)
                    dead_ids.append(cam_id)
                    continue
                
                # Check if stream is stuck (no frames for 60s)
                if time.time() - proc.last_frame_time > 60:
                    logger.warning("Processor for camera %d is STUCK (no frames for 60s) — restarting", cam_id)
                    proc.stop()
                    dead_ids.append(cam_id)
            
            # Remove dead/stuck processors from our tracking so they can be restarted next loop
            for d_id in dead_ids:
                del _processors[d_id]

        except Exception as exc:
            logger.error("Error in orchestration loop: %s", exc)

        time.sleep(config.CAMERA_RELOAD_SEC)


if __name__ == "__main__":
    main()
