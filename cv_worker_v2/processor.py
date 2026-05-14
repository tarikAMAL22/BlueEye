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

# Haar cascade loaded once at module level — thread-safe for detectMultiScale reads
_haar = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)

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

# Per-(person_id, camera_id) locks — serialise alert creation to prevent
# parallel workers from both passing was_person_alerted_recently() before
# either has committed its INSERT.
_alert_create_locks: dict = {}
_alert_create_locks_mutex = threading.Lock()


def _get_alert_lock(person_id: int, camera_id: int) -> threading.Lock:
    key = (person_id, camera_id)
    with _alert_create_locks_mutex:
        if key not in _alert_create_locks:
            _alert_create_locks[key] = threading.Lock()
        return _alert_create_locks[key]


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
    tracker_id:        str
    centroid:          Tuple[float, float]
    encoding:          Encoding
    best:              BestFrame = field(default_factory=BestFrame)
    frame_count:       int       = 0
    first_seen:        float     = field(default_factory=time.time)
    last_seen:         float     = field(default_factory=time.time)
    finalized:         bool      = False
    multi_person_frame: bool     = False  # True if ever detected alongside another person
    clip_frame_urls:   List[str] = field(default_factory=list)  # Sampled frames for flipbook


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

    if tracker.best.crop_bgr is None or tracker.best.crop_bgr.size == 0:
        logger.warning(
            "[cam-%d] tracker=%s DROPPED — no best frame captured",
            camera_id, tracker.tracker_id,
        )
        return

    crop_h, crop_w = tracker.best.crop_bgr.shape[:2]
    logger.info(
        "[cam-%d] PERSIST tracker=%s frames=%d best_crop=%dx%d sharpness=%.1f",
        camera_id, tracker.tracker_id, tracker.frame_count,
        crop_w, crop_h, tracker.best.sharpness,
    )

    # Deep Check (informational only — does not block alert)
    result = validator.validate(tracker.best.crop_bgr)
    logger.info(
        "[cam-%d] tracker=%s VALIDATOR valid=%s reason='%s' conf=%.2f",
        camera_id, tracker.tracker_id, result.valid, result.reason, result.confidence,
    )

    encoding = tracker.best.encoding
    assert encoding is not None

    # Save best frame images (needed for movement log regardless of cooldown)
    full_frame_marked = tracker.best.full_frame.copy()
    if tracker.best.location:
        ft, fr, fb, fl = tracker.best.location
        # location is already in full-frame coords (scaled back at detection time).
        # Clamp to frame bounds before drawing to avoid out-of-range rectangles.
        h_fm, w_fm = full_frame_marked.shape[:2]
        ft = max(0, min(h_fm, ft))
        fb = max(0, min(h_fm, fb))
        fl = max(0, min(w_fm, fl))
        fr = max(0, min(w_fm, fr))
        cv2.rectangle(full_frame_marked, (fl, ft), (fr, fb), (0, 200, 50), 2)
    frame_snap_url = _save_image(full_frame_marked, prefix="frame")

    # Auto face-count on full frame (Haar cascade, thread-safe)
    h_full, w_full = tracker.best.full_frame.shape[:2]
    gray_full = cv2.cvtColor(tracker.best.full_frame, cv2.COLOR_BGR2GRAY)
    haar_raw = _haar.detectMultiScale(
        gray_full,
        scaleFactor=1.05,   # was 1.1 — finer pyramid catches small/distant faces
        minNeighbors=5,     # 3 generated FP on textured backgrounds (windows, screens); 5 keeps real faces
        minSize=(30, 30),   # was (50,50) — background faces are ~30-40px
        maxSize=(400, 400), # prevent full-frame false positives
    )
    # Deduplicate: remove overlapping / contained false-positive detections
    haar_faces = _nms_haar(list(haar_raw) if len(haar_raw) else [])
    haar_count = len(haar_faces)

    # face_count is at least 1 — dlib already confirmed this tracker's face.
    # Prevents NO FACE banner when Haar misses tilted/bottom-up faces that dlib caught.
    face_count = max(1, haar_count)

    # multi_person only when Haar finds secondary faces that don't overlap
    # the primary tracked location — avoids false positives on textured backgrounds.
    if haar_count > 1 and tracker.best.location:
        non_primary_count = sum(
            1 for (hx, hy, hw, hh) in haar_faces
            if _iou((hy, hx + hw, hy + hh, hx), tracker.best.location) < 0.10
        )
        multi_person = non_primary_count > 0
    else:
        multi_person = False

    # Re-crop face snapshot using the Haar detection that best overlaps the tracked location.
    # Haar gives a tight frontal-face bbox → correct framing, no body bleed-in.
    # Falls back to the HOG-tracked crop if no matching Haar face is found.
    primary_haar = None
    if len(haar_faces) > 0 and tracker.best.location:
        best_iou = 0.0
        for haar_cand in haar_faces:
            hx, hy, hw, hh = haar_cand
            haar_loc = (hy, hx + hw, hy + hh, hx)  # (top,right,bottom,left)
            iou_score = _iou(haar_loc, tracker.best.location)
            if iou_score > best_iou and iou_score > 0.10:
                best_iou = iou_score
                primary_haar = haar_cand

    if primary_haar is not None:
        hx, hy, hw, hh = primary_haar
        pad  = int(max(hw, hh) * 0.20)
        cx1  = max(0, hx - pad)
        cy1  = max(0, hy - pad)
        cx2  = min(w_full, hx + hw + pad)
        cy2  = min(h_full, hy + hh + pad)
        haar_crop = tracker.best.full_frame[cy1:cy2, cx1:cx2]
        if haar_crop.size > 0 and _is_bgr_sane(haar_crop):
            face_snap_url = _save_image(haar_crop, prefix="face")
            logger.debug("[cam-%d] tracker=%s face_snap from Haar (%dx%d)", camera_id, tracker.tracker_id, hw, hh)
        else:
            if haar_crop.size > 0 and not _is_bgr_sane(haar_crop):
                logger.error(
                    "[cam-%d] tracker=%s Haar crop has inverted channels (BGR/RGB bug) — HOG fallback",
                    camera_id, tracker.tracker_id,
                )
            face_snap_url = _save_image(tracker.best.crop_bgr, prefix="face")
            logger.debug("[cam-%d] tracker=%s face_snap Haar crop empty/corrupt → HOG fallback", camera_id, tracker.tracker_id)
    else:
        # Haar missed this face (tilted/bottom-up angle) → re-crop from full_frame
        # using the best dlib location. tracker.best.crop_bgr may be from an early
        # frame where the person was entering the scene (body visible, head out-of-frame).
        if tracker.best.location and tracker.best.full_frame is not None:
            ft, fr, fb, fl = tracker.best.location
            h_f, w_f = tracker.best.full_frame.shape[:2]
            pad = int(max(fb - ft, fr - fl) * 0.25)
            lx1 = max(0, fl - pad)
            ly1 = max(0, ft - pad)
            lx2 = min(w_f, fr + pad)
            ly2 = min(h_f, fb + pad)
            loc_crop = tracker.best.full_frame[ly1:ly2, lx1:lx2]
            if loc_crop.size > 0 and loc_crop.shape[0] >= 20 and loc_crop.shape[1] >= 20:
                hsv_loc  = cv2.cvtColor(loc_crop, cv2.COLOR_BGR2HSV)
                sat_loc  = float(hsv_loc[:, :, 1].mean()) / 255.0
                if _is_bgr_sane(loc_crop) and sat_loc >= 0.12:
                    face_snap_url = _save_image(loc_crop, prefix="face")
                    logger.debug(
                        "[cam-%d] tracker=%s dlib-loc crop OK sat=%.3f",
                        camera_id, tracker.tracker_id, sat_loc,
                    )
                else:
                    logger.warning(
                        "[cam-%d] tracker=%s dlib-loc crop rejected (sat=%.3f) — HOG fallback",
                        camera_id, tracker.tracker_id, sat_loc,
                    )
                    face_snap_url = _save_image(tracker.best.crop_bgr, prefix="face")
            else:
                face_snap_url = _save_image(tracker.best.crop_bgr, prefix="face")
        else:
            face_snap_url = _save_image(tracker.best.crop_bgr, prefix="face")
        logger.debug(
            "[cam-%d] tracker=%s face_snap no Haar match → dlib-location fallback",
            camera_id, tracker.tracker_id,
        )

    if not _is_bgr_sane(tracker.best.crop_bgr):
        logger.error(
            "[cam-%d] tracker=%s HOG crop_bgr has inverted channels — possible BGR/RGB bug upstream",
            camera_id, tracker.tracker_id,
        )

    detected_face_urls: list = []
    if multi_person:
        for (hx, hy, hw, hh) in haar_faces:
            pad = int(max(hw, hh) * 0.20)
            x1 = max(0, hx - pad)
            y1 = max(0, hy - pad)
            x2 = min(w_full, hx + hw + pad)
            y2 = min(h_full, hy + hh + pad)
            crop = tracker.best.full_frame[y1:y2, x1:x2]
            if crop.size > 0:
                detected_face_urls.append(_save_image(crop, prefix="face_haar"))

    logger.info(
        "[cam-%d] tracker=%s HAAR -> %d face(s) multi=%s",
        camera_id, tracker.tracker_id, face_count, multi_person,
    )

    # Identify person
    tolerance = float(settings.get("cvRecognitionTolerance", 0.50))
    person, similarity = face_engine.identify(encoding, tolerance=tolerance)
    person_id = person["id"] if person else None
    if person is None:
        threat_level = "high"
    elif person.get("isBlacklisted"):
        threat_level = "critical"
    else:
        threat_level = "low"

    # Log movement record (always — even if cooldown suppresses the alert)
    movement_id = db.create_movement(
        camera_id=camera_id,
        zone_id=zone_id,
        tracker_id=tracker.tracker_id,
        frame_urls=tracker.clip_frame_urls,
        best_frame_url=frame_snap_url,
        face_crop_url=face_snap_url,
        face_count=face_count,
        frame_count=tracker.frame_count,
        alert_id=None,  # filled in below if alert is created
    )

    is_blacklisted = person is not None and bool(person.get("isBlacklisted"))

    # Cooldown / dedup check — always bypassed for blacklisted persons
    if not is_blacklisted:
        cooldown = int(settings.get("cvAlertCooldownSec", config.ALERT_COOLDOWN_SEC))
        if not bio_memory.check_and_register(encoding, person_id=person_id, cooldown_sec=cooldown):
            logger.info(
                "[cam-%d] tracker=%s SUPPRESSED by cooldown (person=%s) — movement #%d logged",
                camera_id, tracker.tracker_id, person_id, movement_id,
            )
            return

        # Camera-level encoding dedup: check against ALL recent alerts (not just LIMIT 1).
        # This catches parallel-worker races where 2 alerts land simultaneously.
        dedup_window = float(settings.get("cvCameraDedupWindowSec", config.CAMERA_DEDUP_WINDOW_SEC))
        if dedup_window > 0:
            recent_encs = db.get_recent_alert_encodings(camera_id, dedup_window)
            if recent_encs:
                sim_threshold = 1.0 - config.DEDUP_TOLERANCE  # 0.35
                for recent_enc_list in recent_encs:
                    recent_enc = np.array(recent_enc_list, dtype=np.float64)
                    sim = face_engine.compare_encodings(encoding, recent_enc)
                    if sim >= sim_threshold:
                        logger.info(
                            "[cam-%d] tracker=%s ENCODING DEDUP — similar face in last %.0fs "
                            "(sim=%.3f >= %.3f) — movement #%d logged, alert suppressed",
                            camera_id, tracker.tracker_id, dedup_window,
                            sim, sim_threshold, movement_id,
                        )
                        return
    else:
        logger.info(
            "[cam-%d] tracker=%s BLACKLISTED — bypassing cooldown/dedup, forcing critical alert",
            camera_id, tracker.tracker_id,
        )

    # Auto-register unknown
    was_unknown = (person_id is None)
    if person_id is None:
        # Check if a parallel worker already inserted a similar unknown in the last window
        # (race: both workers see person_id=None at t=0 and t=0.1s → two unknown rows)
        dedup_win = float(settings.get("cvCameraDedupWindowSec", config.CAMERA_DEDUP_WINDOW_SEC))
        existing_pid = db.find_similar_unknown_person(
            encoding.tolist(),
            max_distance=config.DEDUP_TOLERANCE,
            window_sec=dedup_win,
        )
        if existing_pid is not None:
            person_id = existing_pid
            logger.info(
                "[cam-%d] tracker=%s reused existing unknown person_id=%d "
                "(parallel worker race condition prevented)",
                camera_id, tracker.tracker_id, person_id,
            )
        else:
            person_id = db.insert_unknown_person(encoding.tolist(), photo_url=face_snap_url)
            logger.info(
                "[cam-%d] tracker=%s new unknown person_id=%d created",
                camera_id, tracker.tracker_id, person_id,
            )
            face_engine.force_reload()
        threat_level = "high"

    # Person-ID dedup (primary gate) — permanent in DB, works even after bio_memory expires.
    # bio_memory is encoding-based and expires after cooldown_sec; person_id never expires.
    # Checked after insert_unknown_person so person_id is always set at this point.
    if not is_blacklisted:
        dedup_window_pid = float(settings.get("cvCameraDedupWindowSec", config.CAMERA_DEDUP_WINDOW_SEC))
        if db.was_person_alerted_recently(person_id, camera_id, dedup_window_pid):
            logger.info(
                "[cam-%d] tracker=%s PERSON_ID DEDUP — person=%d already alerted within %.0fs — movement #%d logged",
                camera_id, tracker.tracker_id, person_id, dedup_window_pid, movement_id,
            )
            return

    # Face quality — UNCLEAR when validator failed or crop is too blurry
    # sharpness < 80 was too strict (normal faces score 50-150); 30 rejects only real artifacts
    # similarity < 0.45 removed: unknowns always have similarity=0 → incorrectly tagged UNCLEAR
    face_quality = 'UNCLEAR' if (not result.valid or tracker.best.sharpness < 30) else 'CLEAR'

    # Serialise alert creation per (person_id, camera_id) to prevent race conditions
    # between parallel detection workers: both may pass was_person_alerted_recently()
    # before either commits its INSERT. The double-check inside the lock is the real gate.
    alert_lock = _get_alert_lock(person_id, camera_id)
    with alert_lock:
        dedup_win_final = float(settings.get("cvCameraDedupWindowSec", config.CAMERA_DEDUP_WINDOW_SEC))
        if not is_blacklisted and db.was_person_alerted_recently(person_id, camera_id, dedup_win_final):
            logger.info(
                "[cam-%d] tracker=%s DEDUP (inside lock) — person=%d already alerted within %.0fs — suppressed",
                camera_id, tracker.tracker_id, person_id, dedup_win_final,
            )
            return

        # Create alert
        alert_id = db.create_alert(
            camera_id=camera_id, zone_id=zone_id, person_id=person_id,
            threat_level=threat_level, confidence=round(similarity * 100, 2),
            face_snapshot_url=face_snap_url, best_frame_url=frame_snap_url,
            detection_type='FACE',
            face_quality=face_quality,
            metadata={
                "multiPersonFrame": multi_person,
                "faceCount":        face_count,
                "detectedFaceUrls": detected_face_urls,
                "sharpness":        round(tracker.best.sharpness, 2),
                "deepCheckPassed":  result.valid,
            },
        )

    # Link alert back to movement record
    db.link_movement_to_alert(movement_id, alert_id)

    # Create secondary alerts for any additional persons Haar detected in this frame
    if multi_person and face_count > 1:
        _create_secondary_alerts(
            tracker=tracker,
            camera_id=camera_id,
            zone_id=zone_id,
            haar_faces=haar_faces,
            primary_encoding=encoding,
            primary_location=tracker.best.location,
            tolerance=tolerance,
            settings=settings,
            primary_movement_id=movement_id,
            frame_snap_url=frame_snap_url,
        )

    db.create_event(
        camera_id=camera_id, zone_id=zone_id, person_id=person_id,
        alert_id=alert_id, confidence=round(similarity * 100, 2),
        event_type="unknown" if was_unknown else "recognition",
        payload={
            "trackerID":       tracker.tracker_id,
            "frameCount":      tracker.frame_count,
            "sharpness":       round(tracker.best.sharpness, 2),
            "similarity":      round(similarity, 4),
            "deepCheckConf":   round(result.confidence, 4),
            "deepCheckPassed": result.valid,
            "deepCheckReason": result.reason,
            "faceCount":       face_count,
            "movementId":      movement_id,
        },
    )
    logger.info(
        "[cam-%d] Alert #%d movement #%d person=%s threat=%s sim=%.2f faces=%d",
        camera_id, alert_id, movement_id, person_id, threat_level, similarity, face_count,
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

        h_orig, w_orig = frame_bgr.shape[:2]
        locations, encodings = face_engine.detect_faces(small_rgb)

        logger.debug(
            "[cam-%d] RAW detection: %d face(s) found on %dx%d frame (downscale=%.2f)",
            job.camera_id, len(locations), w_orig, h_orig, downscale,
        )

        if not locations:
            with cam_lock:
                _flush_stale_trackers(job.camera_id, job.zone_id, trackers, settings)
            return

        scale = 1.0 / downscale  # typically 2.0
        is_multi_person_frame = len(locations) > 1

        with cam_lock:
            for idx, (loc_small, encoding) in enumerate(zip(locations, encodings)):
                top    = int(loc_small[0] * scale)
                right  = int(loc_small[1] * scale)
                bottom = int(loc_small[2] * scale)
                left   = int(loc_small[3] * scale)
                location = (top, right, bottom, left)
                face_tag = f"[cam-{job.camera_id}][face-{idx}] bbox=({left},{top},{right},{bottom})"

                # ── 1a. Face height filter ──────────────────────────────────
                face_h = bottom - top
                min_h  = int(settings.get("cvFaceMinHeight", config.FACE_HEIGHT_MIN_PX))
                if face_h < min_h:
                    logger.info(
                        "%s REJECTED height=%dpx < min=%dpx",
                        face_tag, face_h, min_h,
                    )
                    continue
                logger.debug("%s height=%dpx >= min=%dpx OK", face_tag, face_h, min_h)

                # ── 1b. Landmark count filter ───────────────────────────────
                # Only run the expensive dlib landmark call for the very first
                # time a face is seen (no existing tracker). Once a tracker has
                # accumulated ≥1 frame the subject is already validated — no
                # need to re-run under the _dlib_lock every frame.
                is_new_face = not any(
                    not t.finalized and math.dist(t.centroid, _centroid(location)) < float(settings.get("cvSpatialMergePx", config.SPATIAL_MERGE_PX))
                    for t in trackers.values()
                )
                if is_new_face:
                    lm_min   = int(settings.get("cvLandmarkMinPoints", config.LANDMARK_MIN_POINTS))
                    lm_count = face_engine.count_landmarks(rgb, location)
                    if lm_count < lm_min:
                        logger.info(
                            "%s REJECTED landmarks=%d < min=%d",
                            face_tag, lm_count, lm_min,
                        )
                        continue
                    logger.debug("%s landmarks=%d >= min=%d OK", face_tag, lm_count, lm_min)

                    # ── 1c. Critical organs filter ──────────────────────────
                    has_organs = face_engine.has_critical_organs(rgb, location)
                    if not has_organs:
                        logger.info(
                            "%s REJECTED missing critical organs (eyes/nose)",
                            face_tag,
                        )
                        continue
                    logger.debug("%s critical organs OK", face_tag)
                else:
                    logger.debug("%s landmark/organ checks SKIPPED — tracker already validated", face_tag)

                # ── 2. Hybrid tracking ──────────────────────────────────────
                centroid = _centroid(location)
                existing_ids = set(trackers.keys())
                tracker  = _find_or_create_tracker(
                    job.camera_id, centroid, encoding, trackers, settings
                )
                is_new = tracker.tracker_id not in existing_ids
                logger.info(
                    "%s PASSED all filters → tracker=%s (%s) frames=%d",
                    face_tag,
                    tracker.tracker_id,
                    "NEW" if is_new else "existing",
                    tracker.frame_count + 1,
                )

                # Mark tracker if multiple people share this frame
                if is_multi_person_frame:
                    tracker.multi_person_frame = True

                # ── 3. Scene buffer / best-frame update ─────────────────────
                # Expand the bounding box by 20% on each side so the saved
                # face crop includes the full head rather than a tight cutout.
                h_fr, w_fr = frame_bgr.shape[:2]
                pad_h = int((bottom - top)  * 0.20)
                pad_w = int((right  - left) * 0.20)
                ct = max(0,    top    - pad_h)
                cb = min(h_fr, bottom + pad_h)
                cl = max(0,    left   - pad_w)
                cr = min(w_fr, right  + pad_w)
                crop = frame_bgr[ct:cb, cl:cr]
                if crop.size == 0:
                    logger.warning("%s SKIPPED — empty crop (invalid bbox)", face_tag)
                    tracker.frame_count += 1
                    tracker.last_seen = time.time()
                    continue
                _update_best_frame(tracker, frame_bgr, crop, encoding, location)

                # Sample frames for the motion clip (max 12, every 3rd detection).
                # Prefix includes the frame's capture timestamp (ms, zero-padded to 13
                # digits) so filenames sort lexicographically = chronologically.
                # This survives concurrent detection workers that may append out of order.
                if tracker.frame_count % 3 == 0 and len(tracker.clip_frame_urls) < 12:
                    h_fr2, w_fr2 = frame_bgr.shape[:2]
                    clip_small = cv2.resize(frame_bgr, (w_fr2 // 2, h_fr2 // 2))
                    ts_ms = int(job.captured_at * 1000)
                    tracker.clip_frame_urls.append(
                        _save_image(clip_small, prefix=f"clip_{ts_ms:013d}")
                    )

                tracker.last_seen    = time.time()
                tracker.frame_count += 1

                # ── 4. Enqueue persist when buffer elapsed ──────────────────
                elapsed    = time.time() - tracker.first_seen
                buffer_sec = float(settings.get("cvSceneBufferSec", config.SCENE_BUFFER_SEC))
                min_frames = int(settings.get("cvMinFrameCount", config.MIN_FRAME_COUNT))
                if elapsed >= buffer_sec and not tracker.finalized:
                    if tracker.frame_count < min_frames:
                        logger.info(
                            "[cam-%d] tracker=%s buffer elapsed but only %d/%d frames — waiting",
                            job.camera_id, tracker.tracker_id, tracker.frame_count, min_frames,
                        )
                    else:
                        tracker.finalized = True
                        tracker.clip_frame_urls.sort()  # chronological order via embedded timestamp
                        logger.info(
                            "[cam-%d] tracker=%s buffer elapsed (%.1fs >= %.1fs, frames=%d) → queued for persistence",
                            job.camera_id, tracker.tracker_id, elapsed, buffer_sec, tracker.frame_count,
                        )
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
    spatial_px    = float(settings.get("cvSpatialMergePx",      config.SPATIAL_MERGE_PX))
    biometric_sim = float(settings.get("cvBiometricMergeSim",   config.BIOMETRIC_MERGE_SIM))
    # Spatial merge uses a separate, looser similarity floor.
    # Same person across consecutive frames scores ~0.40–0.70 (face angle/lighting
    # variation); clearly different people score <0.30 even when spatially close.
    # Using recognition_tolerance as the floor (1 - 0.50 = 0.50) was too strict
    # and created false rejections at ~0.45.  SPATIAL_BIOMETRIC_SIM = 0.35 gives
    # enough headroom while still blocking obviously different faces.
    spatial_sim_min = float(settings.get("cvSpatialBiometricSim", config.SPATIAL_BIOMETRIC_SIM))

    # Spatial — find the closest non-finalized tracker within the threshold.
    # Guard with a loose biometric check so a different person who walks into
    # the same spot is never merged into the existing tracker.
    best_spatial: Optional[SubjectTracker] = None
    best_dist = float("inf")
    for t in trackers.values():
        if t.finalized:
            continue
        d = math.dist(t.centroid, centroid)
        if d < spatial_px and d < best_dist:
            best_dist = d
            best_spatial = t

    if best_spatial:
        sim = face_engine.compare_encodings(best_spatial.encoding, encoding)
        if sim >= spatial_sim_min:
            best_spatial.centroid = centroid
            return best_spatial
        else:
            logger.info(
                "[cam-%d] Spatial candidate tracker=%s REJECTED (sim=%.3f < %.3f) — different person at same location",
                camera_id, best_spatial.tracker_id, sim, spatial_sim_min,
            )
            # Fall through to biometric search, then new tracker.

    # Biometric fallback (no spatial hint) — strict threshold
    for t in trackers.values():
        if t.finalized:
            continue
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
    if crop.size == 0:
        return

    # Reject corrupt crops (BGR/RGB channel inversion)
    if not _is_bgr_sane(crop):
        return

    # Reject glass/light reflections — they have high Laplacian variance (sharp edges)
    # and would win the composite score over real faces.
    # Real skin: sat_mean 0.15–0.40; glass/light: 0.03–0.10
    hsv      = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    sat_mean = float(hsv[:, :, 1].mean()) / 255.0
    if sat_mean < 0.12:
        # Accept only if we have no best frame yet (placeholder rather than artifact)
        if tracker.best.crop_bgr is not None:
            return

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
    min_frames       = int(settings.get("cvMinFrameCount", config.MIN_FRAME_COUNT))
    to_remove: List[str] = []
    for tid, t in trackers.items():
        inactive = now - t.last_seen
        if inactive > inactivity_sec and not t.finalized:
            t.finalized = True
            if t.frame_count < min_frames:
                logger.info(
                    "[cam-%d] tracker=%s STALE DROPPED — only %d/%d frames (inactive=%.1fs)",
                    camera_id, tid, t.frame_count, min_frames, inactive,
                )
            else:
                t.clip_frame_urls.sort()  # chronological order via embedded timestamp
                logger.info(
                    "[cam-%d] tracker=%s STALE (inactive=%.1fs > %.1fs, frames=%d) → queued for persistence",
                    camera_id, tid, inactive, inactivity_sec, t.frame_count,
                )
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
            logger.debug("[cam-%d] tracker=%s already finalized — removing from active set", camera_id, tid)
            to_remove.append(tid)
    for tid in to_remove:
        trackers.pop(tid, None)


def _nms_haar(faces, iou_thresh: float = 0.25) -> list:
    """Non-maximum suppression for Haar detections (x, y, w, h).

    Two passes:
      1. IOU — suppress any candidate that overlaps a larger detection above
         iou_thresh (catches the same face detected twice at different scales).
      2. Containment — suppress any candidate whose center falls inside a
         larger detection (catches a body-region false positive sitting just
         below a real face detection with zero overlap).
    """
    if len(faces) <= 1:
        return list(faces)

    # Largest area first so we always keep the most confident detection.
    sorted_f = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
    keep: list = []

    for cx, cy, cw, ch in sorted_f:
        suppress = False
        for rx, ry, rw, rh in keep:
            # IOU
            ix1 = max(cx, rx);   iy1 = max(cy, ry)
            ix2 = min(cx+cw, rx+rw); iy2 = min(cy+ch, ry+rh)
            inter = max(0, ix2-ix1) * max(0, iy2-iy1)
            if inter > 0:
                union = cw*ch + rw*rh - inter
                if union > 0 and inter/union > iou_thresh:
                    suppress = True
                    break
            # Center containment: candidate's center inside a kept bbox?
            ccx, ccy = cx + cw // 2, cy + ch // 2
            if rx <= ccx <= rx+rw and ry <= ccy <= ry+rh:
                suppress = True
                break
        if not suppress:
            keep.append((cx, cy, cw, ch))

    return keep


def _iou(loc_a: tuple, loc_b: tuple) -> float:
    """Intersection-over-Union for two (top, right, bottom, left) bboxes."""
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


def _create_secondary_alerts(
    tracker:            "SubjectTracker",
    camera_id:          int,
    zone_id:            int,
    haar_faces,
    primary_encoding:   np.ndarray,
    primary_location:   Optional[tuple],
    tolerance:          float,
    settings:           dict,
    primary_movement_id: int,
    frame_snap_url:     str,
) -> None:
    """
    For each Haar-detected face that doesn't overlap the primary tracked face,
    compute a dlib encoding, identify the person, and create a secondary alert.
    Called only when face_count > 1.
    """
    rgb_full = cv2.cvtColor(tracker.best.full_frame, cv2.COLOR_BGR2RGB)
    h_full, w_full = tracker.best.full_frame.shape[:2]

    for (hx, hy, hw, hh) in haar_faces:
        # face_recognition location format: (top, right, bottom, left)
        haar_loc = (hy, hx + hw, hy + hh, hx)

        # Skip if this bbox heavily overlaps the primary tracked face
        if primary_location and _iou(haar_loc, primary_location) > 0.4:
            continue

        # Get dlib encoding for this face location
        try:
            extra_encs = face_engine.get_encodings_at_locations(rgb_full, [haar_loc])
        except Exception as exc:
            logger.warning("[cam-%d] secondary encode failed: %s", camera_id, exc)
            continue

        if not extra_encs:
            continue

        extra_enc = extra_encs[0]

        # Skip if dlib considers this the same face as the primary
        if face_engine.compare_encodings(primary_encoding, extra_enc) > 0.85:
            continue

        # Identify
        extra_person, extra_sim = face_engine.identify(extra_enc, tolerance=tolerance)
        extra_person_id = extra_person["id"] if extra_person else None
        is_blacklisted  = extra_person is not None and bool(extra_person.get("isBlacklisted"))

        if extra_person is None:
            extra_threat = "high"
        elif is_blacklisted:
            extra_threat = "critical"
        else:
            extra_threat = "low"

        # Cooldown — bypass for blacklisted
        if not is_blacklisted:
            cooldown = int(settings.get("cvAlertCooldownSec", config.ALERT_COOLDOWN_SEC))
            if not bio_memory.check_and_register(extra_enc, person_id=extra_person_id, cooldown_sec=cooldown):
                logger.info(
                    "[cam-%d] secondary person=%s SUPPRESSED by cooldown", camera_id, extra_person_id
                )
                continue

        # Save face crop for the secondary person
        pad = int(max(hw, hh) * 0.20)
        x1, y1 = max(0, hx - pad), max(0, hy - pad)
        x2, y2 = min(w_full, hx + hw + pad), min(h_full, hy + hh + pad)
        sec_crop = tracker.best.full_frame[y1:y2, x1:x2]
        if sec_crop.size > 0 and not _is_bgr_sane(sec_crop):
            logger.error(
                "[cam-%d] secondary Haar crop has inverted channels — skipping save, using frame snap",
                camera_id,
            )
            sec_crop = np.zeros((0,), dtype=np.uint8)  # force fallback
        sec_face_url = _save_image(sec_crop, prefix="face_secondary") if sec_crop.size > 0 else frame_snap_url

        # Auto-register unknown secondary person
        if extra_person_id is None:
            extra_person_id = db.insert_unknown_person(extra_enc.tolist(), photo_url=sec_face_url)
            extra_threat = "high"

        # Create movement + alert for secondary person
        sec_movement_id = db.create_movement(
            camera_id=camera_id,
            zone_id=zone_id,
            tracker_id=tracker.tracker_id + "_sec",
            frame_urls=tracker.clip_frame_urls,
            best_frame_url=frame_snap_url,
            face_crop_url=sec_face_url,
            face_count=1,
            frame_count=tracker.frame_count,
            alert_id=None,
        )
        sec_face_quality = 'CLEAR' if extra_sim >= 0.45 else 'UNCLEAR'
        sec_alert_id = db.create_alert(
            camera_id=camera_id,
            zone_id=zone_id,
            person_id=extra_person_id,
            threat_level=extra_threat,
            confidence=round(extra_sim * 100, 2),
            face_snapshot_url=sec_face_url,
            best_frame_url=frame_snap_url,
            detection_type='FACE',
            face_quality=sec_face_quality,
            metadata={
                "multiPersonFrame":   True,
                "secondaryDetection": True,
                "primaryMovementId":  primary_movement_id,
            },
        )
        db.link_movement_to_alert(sec_movement_id, sec_alert_id)
        logger.info(
            "[cam-%d] Secondary alert #%d movement #%d person=%s threat=%s (multi-person frame)",
            camera_id, sec_alert_id, sec_movement_id, extra_person_id, extra_threat,
        )


def _is_bgr_sane(img: np.ndarray) -> bool:
    """Return False when blue channel dominates red by >1.5× — likely an RGB/BGR swap."""
    if img.ndim < 3 or img.shape[2] < 3:
        return True
    b_mean = float(np.mean(img[:, :, 0]))
    r_mean = float(np.mean(img[:, :, 2]))
    return not (r_mean > 0 and b_mean > r_mean * 1.5)


def _save_image(image: np.ndarray, prefix: str = "img") -> str:
    filename = f"{prefix}_{uuid.uuid4().hex}.jpg"
    path     = os.path.join(config.UPLOAD_DIR, filename)
    cv2.imwrite(path, image, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return f"/uploads/{filename}"
