"""
BlueEye CV Worker v2 — processor.py
Per-camera processing thread: RTSP capture → detection → tracking →
scene buffer → deep check → DB persistence.

Architecture (v2 — decoupled capture / detection):
─────────────────────────────────────────────────
  CaptureThread  (one per camera)
      └── reads RTSP frames as fast as possible
      └── drops old frames if queue is full  ← never blocks the capture
      └── pushes (camera_id, timestamp, frame) into a shared FrameQueue

  DetectionWorkerPool  (singleton, N worker threads)
      └── workers pull frames from FrameQueue
      └── run face detection + tracking in their own threads
      └── push finalised trackers into PersistenceQueue

  PersistenceWorker  (singleton, 1 thread)
      └── pulls from PersistenceQueue
      └── does validate() + DB writes + image saves
      └── completely decoupled from capture → DB stall ≠ missed frames

  CameraProcessor  (compatibility shim used by main.py)
      └── creates CaptureThread + registers camera state
      └── owns the SubjectTracker dict for its camera
      └── called by DetectionWorkerPool workers via shared registry

Key properties:
  - A slow CPU / DB never causes frame loss — the FrameQueue is bounded,
    dropping the oldest frame on overflow rather than blocking the reader.
  - Frame-skipping is *real*: the capture thread reads every frame
    (necessary to drain the RTSP buffer) but only enqueues 1 in N.
  - The PersistenceWorker queue is unbounded so zero finalized subjects
    are ever dropped, even under full hardware saturation.
"""

import logging
import math
import os
import queue
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


# ─── Tunables — all sourced from DB settings table ───────────────────────────
# These constants are used ONLY as bootstrap defaults before the first
# settings reload from the DB. Once the worker starts, all values come
# from settings.get("cvXxx", config.XXX_FALLBACK).
#
# The authoritative defaults live in the DB (migration 0009) and in
# config.py as Python-level fallbacks for the rare case where the DB
# is unreachable on startup.

# Used only to size the queue at module import time.
# After startup, cvFrameQueueSize from DB is respected via _sync_settings.
FRAME_QUEUE_MAXSIZE   = config.CV_FRAME_QUEUE_SIZE_DEFAULT
DETECTION_WORKERS     = config.CV_DETECTION_WORKERS_DEFAULT
PERSIST_QUEUE_MAXSIZE = 0  # unbounded — never lose a finalized subject


# ─── Shared data structures ───────────────────────────────────────────────────

@dataclass
class FrameJob:
    """Unit of work pushed by CaptureThread → consumed by DetectionWorkerPool."""
    camera_id:   int
    zone_id:     int
    frame_bgr:   np.ndarray
    captured_at: float = field(default_factory=time.time)


@dataclass
class PersistJob:
    """Unit of work pushed by DetectionWorkerPool → consumed by PersistenceWorker."""
    camera_id:  int
    zone_id:    int
    tracker:    "SubjectTracker"
    settings:   dict


@dataclass
class BestFrame:
    """Tracks the highest-quality frame for a subject during the scene buffer."""
    crop_bgr:   Optional[np.ndarray] = None
    full_frame: Optional[np.ndarray] = None
    encoding:   Optional[Encoding]   = None
    location:   Optional[FaceLocation] = None
    face_area:  float = 0.0
    sharpness:  float = 0.0


@dataclass
class SubjectTracker:
    """State kept for one tracked subject within a camera thread."""
    tracker_id:  str
    centroid:    Tuple[float, float]
    encoding:    Encoding
    best:        BestFrame = field(default_factory=BestFrame)
    frame_count: int       = 0
    first_seen:  float     = field(default_factory=time.time)
    last_seen:   float     = field(default_factory=time.time)
    finalized:   bool      = False


# ─── Global queues (module-level singletons) ──────────────────────────────────

# FrameQueue: bounded — oldest frame dropped on overflow (non-blocking put)
_frame_queue: "queue.Queue[FrameJob]" = queue.Queue(maxsize=FRAME_QUEUE_MAXSIZE)

# PersistQueue: unbounded — never lose a finalized subject
_persist_queue: "queue.Queue[PersistJob]" = queue.Queue(maxsize=PERSIST_QUEUE_MAXSIZE)

# Per-camera tracker state, protected by a per-camera lock.
# { camera_id: (lock, {tracker_id: SubjectTracker}, settings_dict) }
_camera_state: Dict[int, Tuple[threading.Lock, Dict[str, SubjectTracker], dict]] = {}
_camera_state_lock = threading.Lock()


def _get_camera_state(
    camera_id: int,
) -> Tuple[threading.Lock, Dict[str, SubjectTracker], dict]:
    with _camera_state_lock:
        if camera_id not in _camera_state:
            _camera_state[camera_id] = (threading.Lock(), {}, {})
        return _camera_state[camera_id]


def _remove_camera_state(camera_id: int) -> None:
    with _camera_state_lock:
        _camera_state.pop(camera_id, None)


# ─── Persistence Worker (singleton thread) ────────────────────────────────────

class PersistenceWorker(threading.Thread):
    """
    Consumes PersistJobs from _persist_queue and performs all I/O:
      - validator.validate()
      - cv2.imwrite()
      - MySQL inserts

    This thread is the *only* place that touches the DB from the detection
    pipeline, so a slow DB never stalls frame capture or detection.
    """

    def __init__(self) -> None:
        super().__init__(daemon=True, name="PersistenceWorker")
        self._stop_evt = threading.Event()

    def stop(self) -> None:
        self._stop_evt.set()

    def run(self) -> None:
        logger.info("PersistenceWorker started")
        while not self._stop_evt.is_set():
            try:
                job: PersistJob = _persist_queue.get(timeout=1.0)
            except queue.Empty:
                continue
            try:
                _do_persist(job)
            except Exception as exc:
                logger.error("PersistenceWorker error: %s", exc, exc_info=True)
            finally:
                _persist_queue.task_done()


def _do_persist(job: PersistJob) -> None:
    """Execute one PersistJob — validate, save images, write DB."""
    tracker   = job.tracker
    camera_id = job.camera_id
    zone_id   = job.zone_id
    settings  = job.settings

    if tracker.best.crop_bgr is None:
        return

    logger.info(
        "[cam-%d] Persisting tracker %s (%d frames, sharpness=%.1f)",
        camera_id, tracker.tracker_id, tracker.frame_count, tracker.best.sharpness,
    )

    # ── Deep Check ────────────────────────────────────────────────────────
    result = validator.validate(tracker.best.crop_bgr)
    if not result.valid:
        logger.warning(
            "[cam-%d] Deep Check FAILED — %s (conf=%.2f)",
            camera_id, result.reason, result.confidence,
        )
        db.log_false_positive(camera_id, result.reason)
        db.create_event(
            camera_id=camera_id, zone_id=zone_id, person_id=None, alert_id=None,
            confidence=result.confidence, event_type="false_positive",
            payload={"reason": result.reason},
        )
        return

    encoding = tracker.best.encoding
    assert encoding is not None

    # ── Cooldown / dedup ───────────────────────────────────────────────────
    tolerance = float(settings.get("cvRecognitionTolerance", 0.50))
    person, similarity = face_engine.identify(encoding, tolerance=tolerance)
    person_id    = person["id"] if person else None
    threat_level = "low" if person else "high"

    cooldown = int(settings.get("cvAlertCooldownSec", config.ALERT_COOLDOWN_SEC))
    if not bio_memory.check_and_register(encoding, person_id=person_id, cooldown_sec=cooldown):
        logger.info("[cam-%d] Alert suppressed by cooldown (person=%s)", camera_id, person_id)
        return

    # ── Save images ────────────────────────────────────────────────────────
    face_snap_url  = _save_image(tracker.best.crop_bgr,   prefix="face")
    frame_snap_url = _save_image(tracker.best.full_frame, prefix="frame")

    # ── Auto-register unknown ──────────────────────────────────────────────
    if person_id is None:
        person_id    = db.insert_unknown_person(encoding.tolist(), photo_url=face_snap_url)
        threat_level = "high"

    # ── Create alert & event ───────────────────────────────────────────────
    alert_id = db.create_alert(
        camera_id=camera_id, zone_id=zone_id, person_id=person_id,
        threat_level=threat_level, confidence=round(similarity * 100, 2),
        face_snapshot_url=face_snap_url, best_frame_url=frame_snap_url,
    )
    db.create_event(
        camera_id=camera_id, zone_id=zone_id, person_id=person_id,
        alert_id=alert_id, confidence=round(similarity * 100, 2),
        event_type="recognition",
        payload={
            "trackerID":     tracker.tracker_id,
            "frameCount":    tracker.frame_count,
            "sharpness":     round(tracker.best.sharpness, 2),
            "similarity":    round(similarity, 4),
            "deepCheckConf": round(result.confidence, 4),
        },
    )
    logger.info(
        "[cam-%d] ✔ Alert #%d — person=%s threat=%s sim=%.2f",
        camera_id, alert_id, person_id, threat_level, similarity,
    )


# ─── Detection Worker Pool (singleton) ────────────────────────────────────────

class DetectionWorkerPool:
    """
    Pool of N threads that consume FrameJobs from _frame_queue, run face
    detection, update per-camera tracker state, and push PersistJobs.

    Instantiated once at module level; started by main.py.
    """

    def __init__(self, n_workers: int = DETECTION_WORKERS) -> None:
        self._workers: List[threading.Thread] = []
        self._stop_evt = threading.Event()
        self._n = n_workers

    def start(self) -> None:
        for i in range(self._n):
            t = threading.Thread(
                target=self._worker_loop,
                daemon=True,
                name=f"DetectionWorker-{i}",
            )
            t.start()
            self._workers.append(t)
        logger.info("DetectionWorkerPool started — %d workers", self._n)

    def stop(self) -> None:
        self._stop_evt.set()

    def _worker_loop(self) -> None:
        while not self._stop_evt.is_set():
            try:
                job: FrameJob = _frame_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self._process_frame_job(job)
            except Exception as exc:
                logger.error("DetectionWorker error cam-%d: %s", job.camera_id, exc, exc_info=True)
            finally:
                _frame_queue.task_done()

    def _process_frame_job(self, job: FrameJob) -> None:
        cam_lock, trackers, settings = _get_camera_state(job.camera_id)

        frame_bgr = job.frame_bgr
        rgb       = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        downscale = float(settings.get("cvDownscaleFactor", 0.5))
        small_rgb = cv2.resize(rgb, (0, 0), fx=downscale, fy=downscale)

        locations, encodings = face_engine.detect_faces(small_rgb)
        if not locations:
            # Still need to flush stale trackers even on empty frames
            with cam_lock:
                _flush_stale_trackers(job.camera_id, job.zone_id, trackers, settings)
            return

        scale = 1.0 / downscale  # typically 2.0

        with cam_lock:
            for loc_small, encoding in zip(locations, encodings):
                top    = int(loc_small[0] * scale)
                right  = int(loc_small[1] * scale)
                bottom = int(loc_small[2] * scale)
                left   = int(loc_small[3] * scale)
                location = (top, right, bottom, left)

                # ── 1. Anatomical filter ────────────────────────────────────
                face_h = bottom - top
                min_h  = int(settings.get("cvFaceMinHeight", config.FACE_HEIGHT_MIN_PX))
                if face_h < min_h:
                    continue

                lm_min   = int(settings.get("cvLandmarkMinPoints", config.LANDMARK_MIN_POINTS))
                lm_count = face_engine.count_landmarks(rgb, location)
                if lm_count < lm_min:
                    continue

                if not face_engine.has_critical_organs(rgb, location):
                    continue

                # ── 2. Hybrid tracking ──────────────────────────────────────
                centroid = _centroid(location)
                tracker  = _find_or_create_tracker(
                    job.camera_id, centroid, encoding, trackers, settings
                )

                # ── 3. Scene buffer / best-frame update ─────────────────────
                crop = frame_bgr[top:bottom, left:right]
                _update_best_frame(tracker, frame_bgr, crop, encoding, location)

                tracker.last_seen    = time.time()
                tracker.frame_count += 1

                # ── 4. Enqueue persist when buffer elapsed ──────────────────
                elapsed    = time.time() - tracker.first_seen
                buffer_sec = float(settings.get("cvSceneBufferSec", config.SCENE_BUFFER_SEC))
                if elapsed >= buffer_sec and not tracker.finalized:
                    tracker.finalized = True
                    _persist_queue.put(
                        PersistJob(
                            camera_id=job.camera_id,
                            zone_id=job.zone_id,
                            tracker=tracker,
                            settings=dict(settings),
                        )
                    )

            _flush_stale_trackers(job.camera_id, job.zone_id, trackers, settings)


# Module-level singleton pool
detection_pool = DetectionWorkerPool()
persistence_worker = PersistenceWorker()


# ─── CaptureThread ────────────────────────────────────────────────────────────

class CaptureThread(threading.Thread):
    """
    Reads frames from one RTSP stream as fast as possible.

    - Never blocks on detection (frames are pushed into _frame_queue).
    - If _frame_queue is full, the *oldest* frame is evicted (non-blocking put).
      This keeps the queue fresh instead of growing stale.
    - Real frame-skipping: every N-th frame is enqueued; the rest are read and
      discarded to drain the codec buffer.
    """

    def __init__(self, camera_id: int, zone_id: int, rtsp_url: str) -> None:
        super().__init__(daemon=True, name=f"cap-{camera_id}")
        self.camera_id      = camera_id
        self.zone_id        = zone_id
        self.rtsp_url       = _resolve_url(rtsp_url)
        self._stop_evt      = threading.Event()
        self.last_frame_time = time.time()
        self._frame_counter  = 0

    def stop(self) -> None:
        self._stop_evt.set()

    def run(self) -> None:
        logger.info("[cap-%d] Starting — %s", self.camera_id, self.rtsp_url)
        backoff = config.RTSP_BACKOFF_INITIAL
        while not self._stop_evt.is_set():
            cap = _open_capture(self.rtsp_url)
            if cap is None:
                logger.warning("[cap-%d] Reconnecting in %.1fs", self.camera_id, backoff)
                time.sleep(backoff)
                backoff = min(backoff * config.RTSP_BACKOFF_FACTOR, config.RTSP_BACKOFF_MAX)
                continue

            backoff = config.RTSP_BACKOFF_INITIAL
            logger.info("[cap-%d] Stream opened", self.camera_id)
            try:
                self._capture_loop(cap)
            except Exception as exc:
                logger.error("[cap-%d] Unhandled error: %s", self.camera_id, exc, exc_info=True)
            finally:
                cap.release()

    def _capture_loop(self, cap: cv2.VideoCapture) -> None:
        _, _, settings = _get_camera_state(self.camera_id)

        while not self._stop_evt.is_set():
            ret, frame_bgr = cap.read()
            if not ret:
                logger.warning("[cap-%d] Frame read failed — reconnecting", self.camera_id)
                break

            self.last_frame_time = time.time()
            self._frame_counter += 1

            # ── Real frame-skipping ───────────────────────────────────────
            # Read every frame to drain the RTSP/codec buffer.
            # Enqueue only 1 in N to limit detection CPU usage.
            interval = int(settings.get(
                "cvDetectionInterval",
                getattr(config, "cvDetectionInterval", 2),
            ))
            if self._frame_counter % max(1, interval) != 0:
                continue

            # ── Non-blocking enqueue with oldest-frame eviction ───────────
            # If the queue is at capacity, drop the oldest frame before
            # pushing the new one — keeps data fresh, never blocks capture.
            if _frame_queue.full():
                try:
                    _frame_queue.get_nowait()
                    logger.debug("[cap-%d] Queue full — dropped oldest frame", self.camera_id)
                except queue.Empty:
                    pass

            try:
                _frame_queue.put_nowait(
                    FrameJob(
                        camera_id=self.camera_id,
                        zone_id=self.zone_id,
                        frame_bgr=frame_bgr.copy(),
                    )
                )
            except queue.Full:
                pass  # race condition — ignore


# ─── CameraProcessor (compatibility shim used by main.py) ────────────────────

class CameraProcessor(threading.Thread):
    """
    Thin shim kept for backward compatibility with main.py.

    Wraps CaptureThread — all real work happens in DetectionWorkerPool
    and PersistenceWorker.
    """

    def __init__(self, camera_id: int, zone_id: int, rtsp_url: str) -> None:
        super().__init__(daemon=True, name=f"cam-{camera_id}")
        self.camera_id = camera_id
        self.zone_id   = zone_id
        self._cap_thread = CaptureThread(camera_id, zone_id, rtsp_url)
        self._stop_evt   = threading.Event()
        self.settings    = {}

        # Expose last_frame_time so main.py health-check works unchanged
        self._last_settings_reload = 0
        self._reload_interval      = 30

    @property
    def last_frame_time(self) -> float:  # type: ignore[override]
        return self._cap_thread.last_frame_time

    def stop(self) -> None:
        self._stop_evt.set()
        self._cap_thread.stop()

    def run(self) -> None:
        # Push initial settings into shared state
        self._sync_settings()

        # Start the real capture thread
        self._cap_thread.start()

        # Periodically reload settings and push them to shared state
        while not self._stop_evt.is_set():
            if time.time() - self._last_settings_reload > self._reload_interval:
                self._sync_settings()
                self._last_settings_reload = time.time()
            time.sleep(5)

    def _sync_settings(self) -> None:
        try:
            new_settings = db.get_settings()
            _, _, settings_ref = _get_camera_state(self.camera_id)
            settings_ref.clear()
            settings_ref.update(new_settings)
            self.settings = new_settings
        except Exception as exc:
            logger.error("[cam-%d] Failed to reload settings: %s", self.camera_id, exc)


# ─── Pure helper functions (no self) ─────────────────────────────────────────

def _resolve_url(url: str) -> str:
    import socket
    alias = config.HOST_INTERNAL_ALIAS
    if "localhost" in url or "127.0.0.1" in url:
        try:
            socket.gethostbyname(alias)
            url = url.replace("localhost", alias).replace("127.0.0.1", alias)
        except socket.gaierror:
            pass
    elif alias in url:
        try:
            socket.gethostbyname(alias)
        except socket.gaierror:
            url = url.replace(alias, "127.0.0.1")
    return url


def _open_capture(rtsp_url: str) -> Optional[cv2.VideoCapture]:
    cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        return None
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


def _centroid(location: FaceLocation) -> Tuple[float, float]:
    top, right, bottom, left = location
    return ((left + right) / 2.0, (top + bottom) / 2.0)


def _find_or_create_tracker(
    camera_id: int,
    centroid: Tuple[float, float],
    encoding: Encoding,
    trackers: Dict[str, SubjectTracker],
    settings: dict,
) -> SubjectTracker:
    """Hybrid spatial + biometric tracker lookup. Call under cam_lock."""
    spatial_px   = float(settings.get("cvSpatialMergePx",   config.SPATIAL_MERGE_PX))
    biometric_sim = float(settings.get("cvBiometricMergeSim", config.BIOMETRIC_MERGE_SIM))

    # Spatial
    best_spatial: Optional[SubjectTracker] = None
    best_dist = float("inf")
    for t in trackers.values():
        d = math.dist(t.centroid, centroid)
        if d < spatial_px and d < best_dist:
            best_dist = d
            best_spatial = t

    if best_spatial:
        best_spatial.centroid = centroid
        return best_spatial

    # Biometric fallback
    for t in trackers.values():
        if face_engine.compare_encodings(t.encoding, encoding) >= biometric_sim:
            t.centroid = centroid
            t.encoding = encoding
            return t

    # New tracker
    tid     = str(uuid.uuid4())[:8]
    tracker = SubjectTracker(tracker_id=tid, centroid=centroid, encoding=encoding)
    trackers[tid] = tracker
    logger.debug("[cam-%d] New tracker %s", camera_id, tid)
    return tracker


def _update_best_frame(
    tracker: SubjectTracker,
    full_frame: np.ndarray,
    crop: np.ndarray,
    encoding: Encoding,
    location: FaceLocation,
) -> None:
    top, right, bottom, left = location
    area  = float((bottom - top) * (right - left))
    gray  = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    sharp = sharpness_score(gray)
    score = area * 0.6 + sharp * 0.4
    current = tracker.best.face_area * 0.6 + tracker.best.sharpness * 0.4
    if score > current:
        tracker.best.crop_bgr   = crop.copy()
        tracker.best.full_frame = full_frame.copy()
        tracker.best.encoding   = encoding
        tracker.best.location   = location
        tracker.best.face_area  = area
        tracker.best.sharpness  = sharp


def _flush_stale_trackers(
    camera_id: int,
    zone_id: int,
    trackers: Dict[str, SubjectTracker],
    settings: dict,
) -> None:
    """Enqueue finalization for inactive trackers. Call under cam_lock."""
    now              = time.time()
    inactivity_sec   = float(settings.get("cvInactivityTimeoutSec", config.INACTIVITY_TIMEOUT_SEC))
    to_remove: List[str] = []
    for tid, t in trackers.items():
        inactive = now - t.last_seen
        if inactive > inactivity_sec and not t.finalized:
            t.finalized = True
            _persist_queue.put(
                PersistJob(
                    camera_id=camera_id,
                    zone_id=zone_id,
                    tracker=t,
                    settings=dict(settings),
                )
            )
            to_remove.append(tid)
        elif t.finalized:
            to_remove.append(tid)
    for tid in to_remove:
        trackers.pop(tid, None)


def _save_image(image: np.ndarray, prefix: str = "img") -> str:
    filename = f"{prefix}_{uuid.uuid4().hex}.jpg"
    path     = os.path.join(config.UPLOAD_DIR, filename)
    cv2.imwrite(path, image, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return f"/uploads/{filename}"
