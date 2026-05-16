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
import uuid
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import pymysql

from . import config
from . import db_manager as db
from .face_engine import engine as face_engine
from .biometric_memory import memory as bio_memory

logger = logging.getLogger(__name__)

# ─── Optional heavy dependencies (graceful fallback) ──────────────────────────

_YOLO_AVAILABLE = False
_yolo_model = None

def _load_yolo() -> bool:
    """Try to load YOLOv8n. Returns True on success."""
    global _YOLO_AVAILABLE, _yolo_model
    try:
        import torch as _torch
        from ultralytics import YOLO  # type: ignore
        _yolo_model = YOLO("yolov8n.pt")
        _device = "cuda" if _torch.cuda.is_available() else "cpu"
        _yolo_model.to(_device)
        _YOLO_AVAILABLE = True
        logger.info("DeepAnalyzer: YOLOv8n loaded on %s", _device)
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
            "SELECT a.id, a.bestFrameSnapshotUrl, a.metadata, "
            "       a.personId, a.cameraId, a.zoneId, "
            "       m.id AS movementId "
            "FROM alerts a "
            "LEFT JOIN movements m ON m.alertId = a.id "
            "WHERE a.metadata IS NULL "
            "   OR JSON_EXTRACT(a.metadata, '$.deepAnalyzed') IS NULL "
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
        alert_id: int       = alert["id"]
        primary_person_id   = alert.get("personId")
        camera_id           = alert.get("cameraId")
        zone_id             = alert.get("zoneId")
        movement_id         = alert.get("movementId")
        frame_url: Optional[str] = alert.get("bestFrameSnapshotUrl")

        # Don't create further secondaries from an alert that is itself secondary
        existing_meta: Dict[str, Any] = {}
        if alert.get("metadata"):
            try:
                existing_meta = json.loads(alert["metadata"])
            except (json.JSONDecodeError, TypeError):
                pass
        is_secondary_alert = bool(existing_meta.get("secondaryDetection") or existing_meta.get("deepDetection"))

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
            # ── 9. Secondary alert creation for RetinaFace-only detections ─
            if (not is_secondary_alert and camera_id and zone_id
                    and movement_id and frame_url):
                primary_encoding = encodings[0] if encodings else None
                self._create_secondary_from_deep(
                    alert_id=alert_id,
                    frame_bgr=frame_bgr,
                    rgb=rgb,
                    retinaface_detections=face_detections,
                    body_detections=body_detections,
                    hog_locations=locations,
                    primary_person_id=primary_person_id,
                    primary_encoding=primary_encoding,
                    camera_id=camera_id,
                    zone_id=zone_id,
                    primary_movement_id=movement_id,
                    frame_snap_url=frame_url,
                )
        else:
            logger.info(
                "DeepAnalyzer: Alert #%d — OK (bodies=%d, faces=%d, %d ms)",
                alert_id, detected_bodies_count, detected_faces_count, elapsed_ms,
            )

    # ── Secondary alert creation from deep analysis ───────────────────────────

    def _create_secondary_from_deep(
        self,
        alert_id: int,
        frame_bgr: np.ndarray,
        rgb: np.ndarray,
        retinaface_detections: List[Dict[str, Any]],
        body_detections: List[Dict[str, Any]],
        hog_locations: List,
        primary_person_id: Optional[int],
        primary_encoding: Optional[np.ndarray],
        camera_id: int,
        zone_id: int,
        primary_movement_id: int,
        frame_snap_url: str,
    ) -> None:
        """
        Create secondary movement + alert for:
          1. Faces RetinaFace detected but HOG missed.
          2. YOLOv8 bodies that have no face inside them at all (back-turned / occluded).
        Called only when effectivePersonCount > 1 and this is not itself a secondary.
        """
        settings  = db.get_settings()
        tolerance = float(settings.get("cvRecognitionTolerance", config.RECOGNITION_TOLERANCE))
        h, w      = frame_bgr.shape[:2]
        MIN_FACE_PX = 30  # ignore noise detections smaller than this

        for face_det in retinaface_detections:
            x1, y1, x2, y2 = face_det["bbox"]
            face_w = x2 - x1
            face_h = y2 - y1

            if min(face_w, face_h) < MIN_FACE_PX:
                logger.debug(
                    "DeepAnalyzer: secondary face %dx%d too small — skipped", face_w, face_h
                )
                continue

            # face_recognition format: (top, right, bottom, left)
            face_loc = (y1, x2, y2, x1)

            # Skip if this RetinaFace detection overlaps a HOG-detected face
            # (those faces were already handled at primary persist time)
            overlaps_hog = any(
                _iou_loc(face_loc, hog_loc) > 0.3
                for hog_loc in hog_locations
            )
            if overlaps_hog:
                continue

            # Compute dlib encoding at the RetinaFace-detected location
            try:
                encs = face_engine.get_encodings_at_locations(rgb, [face_loc])
            except Exception as exc:
                logger.warning("DeepAnalyzer: deep secondary encode failed: %s", exc)
                continue

            if not encs:
                continue

            extra_enc = encs[0]

            # Skip if encoding is too close to the primary person
            if primary_encoding is not None:
                if face_engine.compare_encodings(primary_encoding, extra_enc) > 0.85:
                    logger.debug("DeepAnalyzer: secondary face matches primary — skipped")
                    continue

            # Identify
            extra_person, extra_sim = face_engine.identify(extra_enc, tolerance=tolerance)
            extra_person_id = extra_person["id"] if extra_person else None
            is_blacklisted  = extra_person is not None and bool(extra_person.get("isBlacklisted"))

            # Skip if identified as the same primary person
            if extra_person_id and extra_person_id == primary_person_id:
                continue

            if extra_person is None:
                extra_threat = "high"
            elif is_blacklisted:
                extra_threat = "critical"
            else:
                extra_threat = "low"

            # Cooldown — bypass for blacklisted
            if not is_blacklisted:
                cooldown = int(settings.get("cvAlertCooldownSec", config.ALERT_COOLDOWN_SEC))
                if not bio_memory.check_and_register(
                    extra_enc, person_id=extra_person_id, cooldown_sec=cooldown
                ):
                    logger.info(
                        "DeepAnalyzer: deep secondary person=%s suppressed by cooldown",
                        extra_person_id,
                    )
                    continue

            # Save face crop
            pad  = int(max(face_w, face_h) * 0.20)
            cx1  = max(0, x1 - pad)
            cy1  = max(0, y1 - pad)
            cx2  = min(w, x2 + pad)
            cy2  = min(h, y2 + pad)
            crop = frame_bgr[cy1:cy2, cx1:cx2]
            sec_face_url = (
                _deep_save_image(crop, "face_secondary")
                if crop.size > 0
                else frame_snap_url
            )

            # Auto-register unknown
            if extra_person_id is None:
                extra_person_id = db.insert_unknown_person(
                    extra_enc.tolist(), photo_url=sec_face_url
                )
                extra_threat = "high"

            # Create secondary movement + alert
            sec_movement_id = db.create_movement(
                camera_id=camera_id,
                zone_id=zone_id,
                tracker_id=f"deep_{alert_id}_sec",
                frame_urls=[],
                best_frame_url=frame_snap_url,
                face_crop_url=sec_face_url,
                face_count=1,
                frame_count=1,
                alert_id=None,
            )
            sec_alert_id = db.create_alert(
                camera_id=camera_id,
                zone_id=zone_id,
                person_id=extra_person_id,
                threat_level=extra_threat,
                confidence=round(extra_sim * 100, 2),
                face_snapshot_url=sec_face_url,
                best_frame_url=frame_snap_url,
                metadata={
                    "multiPersonFrame":   True,
                    "secondaryDetection": True,
                    "deepDetection":      True,
                    "deepAnalyzed":       True,
                    "primaryAlertId":     alert_id,
                    "primaryMovementId":  primary_movement_id,
                },
            )
            db.link_movement_to_alert(sec_movement_id, sec_alert_id)
            logger.info(
                "DeepAnalyzer: Deep secondary alert #%d movement #%d person=%s threat=%s",
                sec_alert_id, sec_movement_id, extra_person_id, extra_threat,
            )

        # ── Body-only detections: YOLOv8 bodies with no face inside them ─────
        # For each body bbox, check if any RetinaFace face center falls within it.
        # If not, this person has no detectable face → create body-only secondary.
        MIN_BODY_CONF = 0.50  # ignore low-confidence body detections
        MIN_BODY_PX   = 80    # body must be at least this tall (pixels)

        for body_det in body_detections:
            bx1, by1, bx2, by2 = body_det["bbox"]
            body_conf = body_det.get("confidence", 1.0)
            body_h    = by2 - by1

            if body_conf < MIN_BODY_CONF or body_h < MIN_BODY_PX:
                continue

            # Check if any RetinaFace face center falls inside this body bbox
            has_face = any(
                bx1 < (fd["bbox"][0] + fd["bbox"][2]) / 2 < bx2
                and by1 < (fd["bbox"][1] + fd["bbox"][3]) / 2 < by2
                for fd in retinaface_detections
            )
            if has_face:
                continue  # already handled by face-detection path above

            # Crop top 40% of body bbox as head snapshot
            head_y2   = by1 + int(body_h * 0.40)
            head_crop = frame_bgr[by1:head_y2, bx1:bx2]

            # Validate head_crop before saving — reject black/dark/empty zones
            body_snap_url = frame_snap_url  # safe default = annotated frame
            if (head_crop.size > 0
                    and head_crop.shape[0] >= 20
                    and head_crop.shape[1] >= 20
                    and len(head_crop.shape) == 3):
                gray_check = cv2.cvtColor(head_crop, cv2.COLOR_BGR2GRAY)
                mean_brightness = float(gray_check.mean())
                if mean_brightness > 20:
                    body_snap_url = _deep_save_image(head_crop, "body_secondary")
                else:
                    logger.info("[cam-%d] body head_crop too dark (%.1f) — using frame",
                                camera_id, mean_brightness)
            else:
                logger.info("[cam-%d] body head_crop invalid — using annotated frame", camera_id)

            # Body detected without face — no person inserted, person_id = None
            logger.info(
                "[cam-%d] body-only detection — no person inserted, "
                "alert created with body frame only",
                camera_id,
            )

            # Draw orange body bounding box on a dedicated best-frame for this alert
            body_annotated = frame_bgr.copy()
            cv2.rectangle(body_annotated, (bx1, by1), (bx2, by2), (0, 140, 255), 3)
            body_frame_url = _deep_save_image(body_annotated, "body_frame")

            sec_movement_id = db.create_movement(
                camera_id=camera_id,
                zone_id=zone_id,
                tracker_id=f"deep_{alert_id}_body",
                frame_urls=[],
                best_frame_url=body_frame_url,
                face_crop_url=body_snap_url,
                face_count=0,
                frame_count=1,
                alert_id=None,
            )
            sec_alert_id = db.create_alert(
                camera_id=camera_id,
                zone_id=zone_id,
                person_id=None,
                threat_level="medium",
                confidence=None,
                face_snapshot_url=body_snap_url,
                best_frame_url=body_frame_url,
                detection_type="NO_FACE",
                face_quality="NO_FACE",
                metadata={
                    "multiPersonFrame":   True,
                    "secondaryDetection": True,
                    "deepDetection":      True,
                    "bodyOnlyDetection":  True,
                    "primaryAlertId":     alert_id,
                },
            )
            db.link_movement_to_alert(sec_movement_id, sec_alert_id)
            logger.info(
                "DeepAnalyzer: Body-only alert #%d movement #%d (no face — back/occluded)",
                sec_alert_id, sec_movement_id,
            )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _iou_loc(loc_a: tuple, loc_b: tuple) -> float:
    """IoU for (top, right, bottom, left) face_recognition format."""
    top_a, right_a, bottom_a, left_a = loc_a
    top_b, right_b, bottom_b, left_b = loc_b
    i_top    = max(top_a,    top_b)
    i_right  = min(right_a,  right_b)
    i_bottom = min(bottom_a, bottom_b)
    i_left   = max(left_a,   left_b)
    inter    = max(0, i_right - i_left) * max(0, i_bottom - i_top)
    if inter == 0:
        return 0.0
    area_a = (right_a - left_a) * (bottom_a - top_a)
    area_b = (right_b - left_b) * (bottom_b - top_b)
    return inter / (area_a + area_b - inter)


def _deep_save_image(image: np.ndarray, prefix: str = "img") -> str:
    filename = f"{prefix}_{uuid.uuid4().hex}.jpg"
    path     = os.path.join(config.UPLOAD_DIR, filename)
    cv2.imwrite(path, image, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return f"/uploads/{filename}"


# ── Module-level singleton ────────────────────────────────────────────────────
analyzer = DeepAnalyzer()
