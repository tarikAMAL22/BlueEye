"""
BlueEye CV Worker v2 — deep_analyzer.py
Threat Scene Analysis worker: post-processing of Best Frame images.

Architecture:
  - Runs as a background daemon thread, polling for unanalyzed alerts.
  - NEVER touches the live RTSP stream — works exclusively on files in UPLOAD_DIR.
  - Accepts a longer processing time (2–3 s) in exchange for high precision.

Detection stack (two independent layers):
  1. Person / Body detection  → YOLOv8n  (ultralytics)
     Robust to partial occlusion, distance, and crowding.
  2. Face detection           → RetinaFace (retinaface package)
     Detects small / blurry / partially occluded faces missed by HOG.
  3. Face identification      → existing FaceEngine (face_recognition / dlib)
     Unchanged — keeps backward-compatibility with the enrolled identity DB.

Fallback strategy:
  If YOLOv8 is unavailable at import time (e.g. ultralytics not installed),
  the module transparently falls back to the legacy OpenCV HOG detector so
  the worker remains functional without crashing.
  Same for RetinaFace → falls back to face_recognition HOG (upsample=2).
"""

import json
import logging
import os
import time
import threading
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import pymysql

from . import config
from . import db_manager as db
from .face_engine import engine as face_engine

logger = logging.getLogger(__name__)

# ─── Optional heavy dependencies (graceful fallback) ──────────────────────────

_YOLO_AVAILABLE = False
_yolo_model = None

def _load_yolo() -> bool:
    """Try to load YOLOv8n. Returns True on success."""
    global _YOLO_AVAILABLE, _yolo_model
    try:
        from ultralytics import YOLO  # type: ignore
        # 'yolov8n.pt' auto-downloads on first use (~6 MB) — only 'person' class needed
        _yolo_model = YOLO("yolov8n.pt")
        _YOLO_AVAILABLE = True
        logger.info("DeepAnalyzer: YOLOv8n loaded successfully")
        return True
    except Exception as exc:
        logger.warning("DeepAnalyzer: YOLOv8 not available (%s) — falling back to HOG", exc)
        return False

_RETINAFACE_AVAILABLE = False

def _load_retinaface() -> bool:
    """Try to import RetinaFace. Returns True on success."""
    global _RETINAFACE_AVAILABLE
    try:
        import retinaface  # type: ignore  # noqa: F401
        _RETINAFACE_AVAILABLE = True
        logger.info("DeepAnalyzer: RetinaFace loaded successfully")
        return True
    except Exception as exc:
        logger.warning("DeepAnalyzer: RetinaFace not available (%s) — falling back to face_recognition HOG", exc)
        return False


# ─── Body Detection ───────────────────────────────────────────────────────────

def _detect_bodies_yolo(frame_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """
    Detect all persons using YOLOv8n.
    Returns a list of dicts: {bbox: [x1,y1,x2,y2], confidence: float}
    YOLO class 0 = 'person'.
    """
    results = _yolo_model(
        frame_bgr,
        classes=[0],        # person only
        conf=0.25,          # low threshold → catch distant/partial figures
        iou=0.45,           # NMS IoU
        verbose=False,
    )
    detections = []
    for r in results:
        boxes = r.boxes
        if boxes is None:
            continue
        for box in boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            conf = float(box.conf[0])
            detections.append({
                "bbox": [int(x1), int(y1), int(x2), int(y2)],
                "confidence": round(conf, 3),
            })
    return detections


def _detect_bodies_hog(frame_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """Legacy HOG fallback — less robust but always available."""
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    rects, weights = hog.detectMultiScale(
        frame_bgr,
        winStride=(8, 8),
        padding=(32, 32),
        scale=1.05,
    )
    detections = []
    for i, (x, y, w, h) in enumerate(rects):
        conf = float(weights[i]) if len(weights) > i else 1.0
        detections.append({
            "bbox": [int(x), int(y), int(x + w), int(y + h)],
            "confidence": round(min(conf, 1.0), 3),
        })
    return detections


def detect_bodies(frame_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """Unified body detector — uses YOLOv8 when available, else HOG."""
    if _YOLO_AVAILABLE:
        return _detect_bodies_yolo(frame_bgr)
    return _detect_bodies_hog(frame_bgr)


# ─── Face Detection ───────────────────────────────────────────────────────────

def _detect_faces_retinaface(frame_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """
    Detect faces using RetinaFace — handles small, blurry, partially occluded faces.
    Returns list of dicts: {bbox: [x1,y1,x2,y2], confidence: float}
    """
    from retinaface import RetinaFace  # type: ignore

    # RetinaFace expects BGR (same as cv2) — threshold=0.5 catches distant faces
    resp = RetinaFace.detect_faces(frame_bgr, threshold=0.5)

    detections = []
    if not isinstance(resp, dict):
        return detections

    for _face_key, face_data in resp.items():
        area = face_data.get("facial_area", [])  # [x1, y1, x2, y2]
        score = float(face_data.get("score", 1.0))
        if len(area) == 4:
            detections.append({
                "bbox": [int(area[0]), int(area[1]), int(area[2]), int(area[3])],
                "confidence": round(score, 3),
            })
    return detections


def _detect_faces_hog(
    frame_bgr: np.ndarray,
) -> Tuple[List[Any], List[Any]]:
    """
    Fallback: face_recognition HOG with upsample=2 for small faces.
    Returns (locations, encodings) in face_recognition format.
    """
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    locations, encodings = face_engine.detect_faces(rgb, model="hog", upsample=2)
    return locations, encodings


def detect_faces_raw(frame_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """
    Unified face detector returning bbox dicts.
    Used only for *counting* — identification uses face_recognition separately.
    """
    if _RETINAFACE_AVAILABLE:
        return _detect_faces_retinaface(frame_bgr)

    # HOG fallback — convert locations to bbox dicts
    locations, _ = _detect_faces_hog(frame_bgr)
    result = []
    for (top, right, bottom, left) in locations:
        result.append({
            "bbox": [left, top, right, bottom],
            "confidence": 1.0,
        })
    return result


# ─── Worker Thread ─────────────────────────────────────────────────────────────

class DeepAnalyzer(threading.Thread):
    """
    Background worker that performs high-precision Threat Scene Analysis
    on stored Best Frame snapshots after an alert has been created.

    Contract:
      - Reads only from UPLOAD_DIR (never from live RTSP streams).
      - Updates alerts.metadata with enriched scene data.
      - Tolerates 2–3 s per image (precision > speed).
    """

    def __init__(self, interval_sec: int = 5) -> None:
        super().__init__(daemon=True, name="DeepAnalyzer")
        self.interval_sec = interval_sec
        self._stop_evt = threading.Event()
        # Lazy-load heavy models once on first worker start
        self._models_loaded = False

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def stop(self) -> None:
        self._stop_evt.set()

    def run(self) -> None:
        logger.info("DeepAnalyzer worker started")
        self._init_models()
        while not self._stop_evt.is_set():
            try:
                self._process_pending_alerts()
            except Exception as exc:
                logger.error("DeepAnalyzer error: %s", exc, exc_info=True)
            time.sleep(self.interval_sec)

    def _init_models(self) -> None:
        """Load optional heavy models once, on worker start (not at import time)."""
        if self._models_loaded:
            return
        _load_yolo()
        _load_retinaface()
        self._models_loaded = True

    # ── DB helpers ────────────────────────────────────────────────────────────

    def _fetch_pending_alerts(self) -> List[Dict[str, Any]]:
        sql = (
            "SELECT id, bestFrameSnapshotUrl, metadata "
            "FROM alerts "
            "WHERE metadata IS NULL "
            "   OR JSON_EXTRACT(metadata, '$.deepAnalyzed') IS NULL "
            "LIMIT 10"
        )
        with db.get_connection() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(sql)
                return cur.fetchall()

    def _mark_as_analyzed(
        self,
        alert_id: int,
        new_data: Dict[str, Any],
        existing_raw: Optional[str] = None,
    ) -> None:
        """
        Merge *new_data* into whatever metadata already exists for the alert,
        then persist to DB.
        """
        if existing_raw:
            try:
                existing = json.loads(existing_raw)
            except (json.JSONDecodeError, TypeError):
                existing = {}
        else:
            existing = {}

        existing.update(new_data)
        sql = "UPDATE alerts SET metadata = %s WHERE id = %s"
        with db.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (json.dumps(existing), alert_id))
            conn.commit()

    # ── Processing pipeline ───────────────────────────────────────────────────

    def _process_pending_alerts(self) -> None:
        alerts = self._fetch_pending_alerts()
        for alert in alerts:
            try:
                self._analyze_alert(alert)
            except Exception as exc:
                logger.error(
                    "DeepAnalyzer: Failed to analyze alert #%s: %s",
                    alert.get("id"), exc,
                    exc_info=True,
                )
                # Mark as analyzed with error so we don't retry forever
                self._mark_as_analyzed(
                    alert["id"],
                    {"deepAnalyzed": True, "error": str(exc)},
                    existing_raw=alert.get("metadata"),
                )

    def _analyze_alert(self, alert: Dict[str, Any]) -> None:
        alert_id: int = alert["id"]
        frame_url: Optional[str] = alert.get("bestFrameSnapshotUrl")

        logger.info("DeepAnalyzer: Processing alert #%d …", alert_id)

        if not frame_url:
            logger.warning("DeepAnalyzer: Alert #%d has no bestFrameSnapshotUrl — skipping", alert_id)
            self._mark_as_analyzed(
                alert_id,
                {"deepAnalyzed": True, "error": "no_frame_url"},
                existing_raw=alert.get("metadata"),
            )
            return

        # ── 1. Resolve file path (never touches RTSP) ─────────────────────
        filename = frame_url.lstrip("/").replace("uploads/", "", 1)
        local_path = os.path.join(config.UPLOAD_DIR, filename)

        if not os.path.exists(local_path):
            logger.warning("DeepAnalyzer: Frame file not found: %s", local_path)
            self._mark_as_analyzed(
                alert_id,
                {"deepAnalyzed": True, "error": "file_not_found"},
                existing_raw=alert.get("metadata"),
            )
            return

        # ── 2. Load image ─────────────────────────────────────────────────
        t_start = time.monotonic()
        frame_bgr = cv2.imread(local_path)
        if frame_bgr is None:
            logger.error("DeepAnalyzer: cv2.imread returned None for %s", local_path)
            self._mark_as_analyzed(
                alert_id,
                {"deepAnalyzed": True, "error": "unreadable_image"},
                existing_raw=alert.get("metadata"),
            )
            return

        # ── 3. Person / body detection (YOLOv8 or HOG fallback) ──────────
        body_detections = detect_bodies(frame_bgr)
        detected_bodies_count = len(body_detections)

        # ── 4. Face detection (RetinaFace or HOG fallback) ────────────────
        face_detections = detect_faces_raw(frame_bgr)
        detected_faces_count = len(face_detections)

        # ── 5. Face identification via existing FaceEngine ────────────────
        #      Run face_recognition on the same frame to get 128-d encodings.
        #      We use upsample=1 here (same as before) — the raw count already
        #      comes from RetinaFace which is more sensitive for distant faces.
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        locations, encodings = face_engine.detect_faces(rgb, model="hog", upsample=1)

        identified_persons: List[Dict[str, Any]] = []
        for encoding in encodings:
            person, similarity = face_engine.identify(encoding)
            if person:
                identified_persons.append({
                    "id":         person["id"],
                    "name":       person["name"],
                    "confidence": round(similarity * 100, 2),
                })
            else:
                identified_persons.append({
                    "id":         None,
                    "name":       "Unknown",
                    "confidence": 0,
                })

        # ── 6. Threat scene verdict ───────────────────────────────────────
        #      We consider "multiple people" if either detector found > 1.
        #      Using max() gives the most conservative (safe) count.
        effective_person_count = max(detected_bodies_count, detected_faces_count)
        multi_detected = effective_person_count > 1

        elapsed_ms = round((time.monotonic() - t_start) * 1000)
        engine_used = {
            "bodyDetector":  "yolov8n" if _YOLO_AVAILABLE else "hog",
            "faceDetector":  "retinaface" if _RETINAFACE_AVAILABLE else "face_recognition_hog",
        }

        # ── 7. Build enriched metadata ────────────────────────────────────
        metadata = {
            "deepAnalyzed":          True,
            "analysisEngines":       engine_used,
            "multiFaceDetected":     multi_detected,
            "effectivePersonCount":  effective_person_count,
            "faceCount":             detected_faces_count,
            "bodyCount":             detected_bodies_count,
            "faceDetections":        face_detections,
            "bodyDetections":        body_detections,
            "detectedPersons":       identified_persons,
            "analyzedAt":            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "processingTimeMs":      elapsed_ms,
        }

        # ── 8. Persist ────────────────────────────────────────────────────
        self._mark_as_analyzed(alert_id, metadata, existing_raw=alert.get("metadata"))

        if multi_detected:
            logger.warning(
                "DeepAnalyzer: Alert #%d — ⚠ MULTIPLE PEOPLE DETECTED "
                "(bodies=%d, faces=%d, engine=%s/%s, %d ms)",
                alert_id,
                detected_bodies_count,
                detected_faces_count,
                engine_used["bodyDetector"],
                engine_used["faceDetector"],
                elapsed_ms,
            )
        else:
            logger.info(
                "DeepAnalyzer: Alert #%d — OK (bodies=%d, faces=%d, %d ms)",
                alert_id, detected_bodies_count, detected_faces_count, elapsed_ms,
            )


# ── Module-level singleton ────────────────────────────────────────────────────
analyzer = DeepAnalyzer()
