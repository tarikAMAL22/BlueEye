"""
BlueEye CV Worker v2 — processor.py
Per-camera processing thread: RTSP capture → detection → tracking →
scene buffer → deep check → DB persistence.
"""

import logging
import math
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

from . import config
from . import db_manager as db
from .biometric_memory import memory as bio_memory
from .face_engine import engine as face_engine, Encoding, FaceLocation
from .validator import validator, sharpness_score

logger = logging.getLogger(__name__)


# ─── Data structures ──────────────────────────────────────────────────────────

@dataclass
class BestFrame:
    """Tracks the highest-quality frame for a subject during the scene buffer."""
    crop_bgr:    Optional[np.ndarray] = None
    full_frame:  Optional[np.ndarray] = None
    encoding:    Optional[Encoding]   = None
    location:    Optional[FaceLocation] = None
    face_area:   float = 0.0
    sharpness:   float = 0.0


@dataclass
class SubjectTracker:
    """State kept for one tracked subject within a camera thread."""
    tracker_id:   str
    centroid:     Tuple[float, float]
    encoding:     Encoding
    best:         BestFrame                = field(default_factory=BestFrame)
    frame_count:  int                      = 0
    first_seen:   float                    = field(default_factory=time.time)
    last_seen:    float                    = field(default_factory=time.time)
    finalized:    bool                     = False


# ─── Main processor ──────────────────────────────────────────────────────────

class CameraProcessor(threading.Thread):
    """
    Dedicated thread for one camera.

    Lifecycle: start() → run loop → stop().
    Implements:
    - Exponential back-off RTSP reconnection
    - Anatomical landmark filter
    - Hybrid tracking (spatial + biometric merge)
    - 10-second scene buffer with best-frame selection
    - Deep Check via Validator before DB write
    """

    def __init__(self, camera_id: int, zone_id: int, rtsp_url: str) -> None:
        super().__init__(daemon=True, name=f"cam-{camera_id}")
        self.camera_id = camera_id
        self.zone_id   = zone_id
        self.rtsp_url  = self._resolve_url(rtsp_url)
        self._stop_evt = threading.Event()
        self._trackers: Dict[str, SubjectTracker] = {}
        self.settings = {}
        self._last_settings_reload = 0
        self._reload_interval = 30 # seconds
        self.last_frame_time = time.time()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def stop(self) -> None:
        self._stop_evt.set()

    def run(self) -> None:
        logger.info("[cam-%d] Starting — %s", self.camera_id, self.rtsp_url)
        backoff = config.RTSP_BACKOFF_INITIAL
        while not self._stop_evt.is_set():
            cap = self._open_capture()
            if cap is None:
                logger.warning("[cam-%d] Reconnecting in %.1fs", self.camera_id, backoff)
                time.sleep(backoff)
                backoff = min(backoff * config.RTSP_BACKOFF_FACTOR, config.RTSP_BACKOFF_MAX)
                continue

            backoff = config.RTSP_BACKOFF_INITIAL
            logger.info("[cam-%d] Stream opened", self.camera_id)
            try:
                self._capture_loop(cap)
            except Exception as exc:
                logger.error("[cam-%d] Unhandled error: %s", self.camera_id, exc, exc_info=True)
            finally:
                cap.release()

    # ── RTSP helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _resolve_url(url: str) -> str:
        """
        Ensures the RTSP URL is reachable from within Docker.
        Maps localhost/127.0.0.1 to host.docker.internal.
        """
        import socket
        internal_alias = config.HOST_INTERNAL_ALIAS
        
        # 1. If url contains localhost or 127.0.0.1, we might need to map it to host.docker.internal
        if "localhost" in url or "127.0.0.1" in url:
            try:
                # Check if host.docker.internal is resolvable (we are in Docker)
                socket.gethostbyname(internal_alias)
                url = url.replace("localhost", internal_alias).replace("127.0.0.1", internal_alias)
                logger.debug("Remapped local URL to %s", internal_alias)
            except socket.gaierror:
                # Not in docker or alias not available, keep as is
                pass
        
        # 2. Reverse mapping: if we are NOT in docker but URL uses host.docker.internal
        elif internal_alias in url:
            try:
                socket.gethostbyname(internal_alias)
            except socket.gaierror:
                url = url.replace(internal_alias, "127.0.0.1")
                logger.debug("Resolved host.docker.internal → 127.0.0.1 (Legacy fallback)")
        
        return url

    def _open_capture(self) -> Optional[cv2.VideoCapture]:
        cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
        if not cap.isOpened():
            return None
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    # ── Main capture loop ────────────────────────────────────────────────────

    def _capture_loop(self, cap: cv2.VideoCapture) -> None:
        while not self._stop_evt.is_set():
            # Periodically reload settings
            if time.time() - self._last_settings_reload > self._reload_interval:
                self._load_dynamic_settings()
                self._last_settings_reload = time.time()

            ret, frame_bgr = cap.read()
            if not ret:
                logger.warning("[cam-%d] Frame read failed — reconnecting", self.camera_id)
                break
            
            self.last_frame_time = time.time()
            
            # Use dynamic interval (frame skipping)
            interval = int(self.settings.get("cvDetectionInterval", config.cvDetectionInterval if hasattr(config, 'cvDetectionInterval') else 2))
            # (In a real implementation we'd skip frames here, but for simplicity we process)
            
            self._process_frame(frame_bgr)
            self._flush_stale_trackers()

    def _load_dynamic_settings(self) -> None:
        try:
            self.settings = db.get_settings()
            logger.debug("[cam-%d] Dynamic settings reloaded", self.camera_id)
        except Exception as e:
            logger.error("[cam-%d] Failed to reload settings: %s", self.camera_id, e)

    # ── Per-frame processing ──────────────────────────────────────────────────

    def _process_frame(self, frame_bgr: np.ndarray) -> None:
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        # Downsample for speed (Dynamic)
        downscale = float(self.settings.get("cvDownscaleFactor", 0.5))
        small_rgb = cv2.resize(rgb, (0, 0), fx=downscale, fy=downscale)

        locations, encodings = face_engine.detect_faces(small_rgb)
        if not locations:
            return

        for loc_small, encoding in zip(locations, encodings):
            # Scale location back to full-frame coordinates
            top, right, bottom, left = [v * 2 for v in loc_small]
            location = (top, right, bottom, left)

            # ── 1. Anatomical filter ────────────────────────────────────────
            face_h = bottom - top
            min_h = int(self.settings.get("cvFaceMinHeight", config.FACE_HEIGHT_MIN_PX))
            if face_h < min_h:
                continue

            lm_min = int(self.settings.get("cvLandmarkMinPoints", config.LANDMARK_MIN_POINTS))
            lm_count = face_engine.count_landmarks(rgb, location)
            if lm_count < lm_min:
                logger.debug("[cam-%d] Rejected: only %d landmarks", self.camera_id, lm_count)
                continue

            if not face_engine.has_critical_organs(rgb, location):
                logger.debug("[cam-%d] Rejected: critical organs missing", self.camera_id)
                continue

            # ── 2. Hybrid tracking ──────────────────────────────────────────
            centroid = self._centroid(location)
            tracker  = self._find_or_create_tracker(centroid, encoding)

            # ── 3. Scene buffer / best-frame update ─────────────────────────
            crop = frame_bgr[top:bottom, left:right]
            self._update_best_frame(tracker, frame_bgr, crop, encoding, location)

            tracker.last_seen   = time.time()
            tracker.frame_count += 1

            # ── 4. Finalise when buffer window has elapsed ──────────────────
            elapsed = time.time() - tracker.first_seen
            buffer_sec = float(self.settings.get("cvSceneBufferSec", config.SCENE_BUFFER_SEC))
            if elapsed >= buffer_sec and not tracker.finalized:
                tracker.finalized = True
                self._finalise_tracker(tracker)

    # ── Tracking helpers ──────────────────────────────────────────────────────

    def _find_or_create_tracker(
        self, centroid: Tuple[float, float], encoding: Encoding
    ) -> SubjectTracker:
        """Hybrid: try spatial match first, then biometric merge."""
        # Spatial search
        best_spatial: Optional[SubjectTracker] = None
        best_dist = float("inf")
        for t in self._trackers.values():
            d = math.dist(t.centroid, centroid)
            if d < config.SPATIAL_MERGE_PX and d < best_dist:
                best_dist = d
                best_spatial = t

        if best_spatial:
            best_spatial.centroid = centroid
            return best_spatial

        # Biometric 1:1 fallback
        for t in self._trackers.values():
            sim = face_engine.compare_encodings(t.encoding, encoding)
            if sim >= config.BIOMETRIC_MERGE_SIM:
                logger.debug("[cam-%d] Biometric merge %.2f", self.camera_id, sim)
                t.centroid = centroid
                t.encoding = encoding
                return t

        # New tracker
        tracker_id = str(uuid.uuid4())[:8]
        tracker = SubjectTracker(tracker_id=tracker_id, centroid=centroid, encoding=encoding)
        self._trackers[tracker_id] = tracker
        logger.debug("[cam-%d] New tracker %s", self.camera_id, tracker_id)
        return tracker

    def _flush_stale_trackers(self) -> None:
        """Finalise and remove trackers that have been inactive too long."""
        now = time.time()
        to_remove = []
        for tid, t in self._trackers.items():
            inactive = now - t.last_seen
            if inactive > config.INACTIVITY_TIMEOUT_SEC and not t.finalized:
                t.finalized = True
                self._finalise_tracker(t)
                to_remove.append(tid)
            elif t.finalized:
                to_remove.append(tid)
        for tid in to_remove:
            self._trackers.pop(tid, None)

    # ── Best-frame selection ──────────────────────────────────────────────────

    @staticmethod
    def _update_best_frame(
        tracker: SubjectTracker,
        full_frame: np.ndarray,
        crop: np.ndarray,
        encoding: Encoding,
        location: FaceLocation,
    ) -> None:
        top, right, bottom, left = location
        area = float((bottom - top) * (right - left))
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        sharp = sharpness_score(gray)

        # Combine area and sharpness into a single score
        score = area * 0.6 + sharp * 0.4
        current_score = tracker.best.face_area * 0.6 + tracker.best.sharpness * 0.4

        if score > current_score:
            tracker.best.crop_bgr   = crop.copy()
            tracker.best.full_frame = full_frame.copy()
            tracker.best.encoding   = encoding
            tracker.best.location   = location
            tracker.best.face_area  = area
            tracker.best.sharpness  = sharp

    # ── Finalisation ──────────────────────────────────────────────────────────

    def _finalise_tracker(self, tracker: SubjectTracker) -> None:
        if tracker.best.crop_bgr is None:
            logger.debug("[cam-%d] Tracker %s has no best frame — skipping", self.camera_id, tracker.tracker_id)
            return

        logger.info(
            "[cam-%d] Finalising tracker %s (%d frames, sharpness=%.1f)",
            self.camera_id, tracker.tracker_id, tracker.frame_count, tracker.best.sharpness,
        )

        # ── Deep Check ──────────────────────────────────────────────────────
        result = validator.validate(tracker.best.crop_bgr)
        if not result.valid:
            logger.warning(
                "[cam-%d] Deep Check FAILED — %s (conf=%.2f)",
                self.camera_id, result.reason, result.confidence,
            )
            db.log_false_positive(self.camera_id, result.reason)
            # Create a rejected event
            db.create_event(
                camera_id=self.camera_id,
                zone_id=self.zone_id,
                person_id=None,
                alert_id=None,
                confidence=result.confidence,
                event_type="false_positive",
                payload={"reason": result.reason}
            )
            return

        encoding = tracker.best.encoding
        assert encoding is not None

        # ── Cooldown / dedup check ───────────────────────────────────────────
        tolerance = float(self.settings.get("cvRecognitionTolerance", 0.50))
        person, similarity = face_engine.identify(encoding, tolerance=tolerance)
        person_id   = person["id"]   if person else None
        # Use 'low' as default for known persons, 'high' for unknowns
        threat_level = "low" if person else "high"

        cooldown = int(self.settings.get("cvAlertCooldownSec", config.ALERT_COOLDOWN_SEC))
        allowed = bio_memory.check_and_register(encoding, person_id=person_id, cooldown_sec=cooldown)
        if not allowed:
            logger.info("[cam-%d] Alert suppressed by cooldown (person=%s, cooldown=%ds)", self.camera_id, person_id, cooldown)
            return

        # ── Save images ──────────────────────────────────────────────────────
        face_snap_url  = self._save_image(tracker.best.crop_bgr,   prefix="face")
        frame_snap_url = self._save_image(tracker.best.full_frame, prefix="frame")

        # ── Auto-register unknown ────────────────────────────────────────────
        if person_id is None:
            person_id = db.insert_unknown_person(encoding.tolist(), photo_url=face_snap_url)
            threat_level = "high"

        # ── Create alert & event ─────────────────────────────────────────────
        alert_id = db.create_alert(
            camera_id=self.camera_id,
            zone_id=self.zone_id,
            person_id=person_id,
            threat_level=threat_level,
            confidence=round(similarity * 100, 2), # Similarity is 0-1, we want 0-100%
            face_snapshot_url=face_snap_url,
            best_frame_url=frame_snap_url,
        )
        db.create_event(
            camera_id=self.camera_id,
            zone_id=self.zone_id,
            person_id=person_id,
            alert_id=alert_id,
            confidence=round(similarity * 100, 2),
            event_type="recognition",
            payload={
                "trackerID":    tracker.tracker_id,
                "frameCount":   tracker.frame_count,
                "sharpness":    round(tracker.best.sharpness, 2),
                "similarity":   round(similarity, 4),
                "deepCheckConf": round(result.confidence, 4),
            },
        )
        logger.info(
            "[cam-%d] ✔ Alert #%d — person=%d threat=%s sim=%.2f",
            self.camera_id, alert_id, person_id, threat_level, similarity,
        )

    # ── Image persistence ────────────────────────────────────────────────────

    @staticmethod
    def _save_image(image: np.ndarray, prefix: str = "img") -> str:
        filename = f"{prefix}_{uuid.uuid4().hex}.jpg"
        path = os.path.join(config.UPLOAD_DIR, filename)
        cv2.imwrite(path, image, [cv2.IMWRITE_JPEG_QUALITY, 90])
        return f"/uploads/{filename}"

    # ── Geometry helper ──────────────────────────────────────────────────────

    @staticmethod
    def _centroid(location: FaceLocation) -> Tuple[float, float]:
        top, right, bottom, left = location
        return ((left + right) / 2.0, (top + bottom) / 2.0)
