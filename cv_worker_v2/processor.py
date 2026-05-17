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

# Haar cascade — kept as fallback when MediaPipe unavailable
_haar = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)

logger = logging.getLogger(__name__)

# MediaPipe Face Detection — primary detector
# Handles tilted, bottom-up, and partial faces that Haar misses.
# model_selection=1: full-range model (up to 5m — suitable for corridor cameras)
# NOT thread-safe → protected by _mp_lock
try:
    import mediapipe as mp
    _mp_detector = mp.solutions.face_detection.FaceDetection(
        model_selection=1,
        min_detection_confidence=0.5,
    )
    _mp_lock      = threading.Lock()
    _mp_available = True
    logger.info("MediaPipe Face Detection loaded (model_selection=1)")
except Exception as _mp_err:
    _mp_available = False
    logger.warning("MediaPipe unavailable — falling back to Haar: %s", _mp_err)

import urllib.request, os as _os

_YUNET_PATH = _os.path.join(_os.path.dirname(__file__), "models", "yunet.onnx")
_YUNET_URL  = ("https://github.com/opencv/opencv_zoo/raw/main/models/"
               "face_detection_yunet/face_detection_yunet_2023mar.onnx")
_yunet_detector = None
_yunet_lock     = threading.Lock()
_YUNET_AVAILABLE = False

def _init_yunet() -> None:
    global _yunet_detector, _YUNET_AVAILABLE
    try:
        _os.makedirs(_os.path.dirname(_YUNET_PATH), exist_ok=True)
        if not _os.path.exists(_YUNET_PATH):
            logger.info("Downloading YuNet model from %s", _YUNET_URL)
            urllib.request.urlretrieve(_YUNET_URL, _YUNET_PATH)
            size = _os.path.getsize(_YUNET_PATH)
            logger.info("YuNet downloaded: %.1f KB", size / 1024)
            if size < 100_000:
                logger.error("YuNet download too small (%d bytes) — deleting", size)
                _os.remove(_YUNET_PATH)
                return
        det = cv2.FaceDetectorYN.create(
            _YUNET_PATH, "", (320, 320),
            score_threshold=0.60,
            nms_threshold=0.30,
            top_k=100,
        )
        _yunet_detector = det
        _YUNET_AVAILABLE = True
        logger.info("YuNet initialized ✓ (path=%s)", _YUNET_PATH)
    except Exception as exc:
        logger.warning("YuNet init failed: %s", exc)
        _YUNET_AVAILABLE = False

_init_yunet()

def _yunet_has_face(crop_bgr: np.ndarray, min_score: float = 0.55) -> bool:
    """Return True if YuNet detects at least one face in crop_bgr."""
    if not _YUNET_AVAILABLE or _yunet_detector is None:
        return False
    if crop_bgr is None or crop_bgr.size == 0:
        return False
    h, w = crop_bgr.shape[:2]
    if h < 20 or w < 20:
        return False
    try:
        with _yunet_lock:
            _yunet_detector.setInputSize((w, h))
            _, faces = _yunet_detector.detect(crop_bgr)
        if faces is None:
            return False
        return any(float(f[14]) >= min_score for f in faces)
    except Exception as exc:
        logger.debug("YuNet detect error: %s", exc)
        return False

# ─── dlib CUDA check — determines face detection model ───────────────────────
try:
    import dlib as _dlib_mod
    _USE_CNN = bool(_dlib_mod.DLIB_USE_CUDA)
except Exception:
    _USE_CNN = False
_FACE_MODEL = "cnn" if _USE_CNN else "hog"
logger.info("Face detection model: %s (CUDA=%s)", _FACE_MODEL, _USE_CNN)


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

# Serialises find-or-create for unknown persons across all detection workers.
# Without this, 4 parallel workers can all call find_similar_unknown_person()
# at the same millisecond, all get None, and all insert a new duplicate person.
_unknown_person_lock = threading.Lock()

# Presence-based dedup: tracks when each (person_id, camera_id) pair last had
# a tracker finish. A new tracker finishing < SAME_PASSAGE_GAP_SEC after the
# previous one is the same physical passage → suppress duplicate alert.
# A gap > SAME_PASSAGE_GAP_SEC means the person left and came back → new alert.
_person_last_seen: dict = {}        # (person_id, camera_id) -> monotonic float
_person_last_seen_lock = threading.Lock()


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

    # Face detection for count + crop selection.
    # Primary: MediaPipe (handles tilted/partial/bottom-up faces, low FP rate).
    # Fallback: Haar (if MediaPipe unavailable or returns empty on clear face).
    h_full, w_full = tracker.best.full_frame.shape[:2]
    haar_faces = _detect_faces_mp(tracker.best.full_frame) if _mp_available else []
    if not haar_faces:
        gray_full  = cv2.cvtColor(tracker.best.full_frame, cv2.COLOR_BGR2GRAY)
        haar_raw   = _haar.detectMultiScale(
            gray_full, scaleFactor=1.05, minNeighbors=5,
            minSize=(30, 30), maxSize=(400, 400),
        )
        haar_faces = _nms_haar(list(haar_raw) if len(haar_raw) else [])
        logger.debug(
            "[cam-%d] tracker=%s MediaPipe empty → Haar fallback (%d faces)",
            camera_id, tracker.tracker_id, len(haar_faces),
        )
    haar_count = len(haar_faces)

    # face_count is at least 1 — dlib already confirmed this tracker's face.
    # Prevents NO FACE banner when detector misses tilted/bottom-up faces.
    face_count = max(1, haar_count)

    # multi_person only when secondary faces don't overlap the primary tracked location.
    if haar_count > 1 and tracker.best.location:
        non_primary_count = sum(
            1 for (hx, hy, hw, hh) in haar_faces
            if _iou((hy, hx + hw, hy + hh, hx), tracker.best.location) < 0.10
        )
        multi_person = non_primary_count > 0
    else:
        multi_person = False

    # Re-crop face snapshot using the detected bbox that best overlaps the tracked location.
    # MediaPipe/Haar gives a tight face bbox → correct framing, no body bleed-in.
    # Falls back to dlib-location recrop or HOG crop if no match found.
    # ── Face snapshot selection: 3-step waterfall ────────────────────────────
    # Step 1: Haar/MediaPipe tight bbox → re-crop.
    # Step 2: dlib-location re-crop (Haar missed, too large, or MP-rejected).
    # Step 3: HOG crop_bgr fallback (last resort).
    face_snap_url = None

    primary_haar = None
    if len(haar_faces) > 0 and tracker.best.location:
        best_iou   = 0.0
        max_face_h = int(h_full * 0.35)
        max_face_w = int(w_full * 0.35)
        for haar_cand in haar_faces:
            hx, hy, hw, hh = haar_cand
            if hh < 20 or hw < 20:
                continue
            if hh > max_face_h or hw > max_face_w:
                continue
            haar_loc  = (hy, hx + hw, hy + hh, hx)
            iou_score = _iou(haar_loc, tracker.best.location)
            if iou_score > best_iou and iou_score > 0.30:
                best_iou     = iou_score
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
            mp_ok = _detect_faces_mp(haar_crop, min_confidence=0.3) \
                    if _mp_available else True
            if mp_ok:
                face_snap_url = _save_image(haar_crop, prefix="face")
                logger.debug("[cam-%d] tracker=%s Haar crop validated by MP (%dx%d)",
                             camera_id, tracker.tracker_id, hw, hh)
            else:
                logger.info("[cam-%d] tracker=%s Haar crop rejected by MP "
                            "(tableau/badge) — dlib fallback", camera_id, tracker.tracker_id)
                face_snap_url = None
                primary_haar  = None
        else:
            face_snap_url = _save_image(tracker.best.crop_bgr, prefix="face")

    # Step 2 — dlib-location re-crop (FIX 3: no sat_loc gate, use MediaPipe instead)
    # Runs when: Haar was None, too large (size-rejected), or MP-rejected above.
    if face_snap_url is None and tracker.best.location and tracker.best.full_frame is not None:
        ft, fr, fb, fl = tracker.best.location
        h_f, w_f = tracker.best.full_frame.shape[:2]
        pad = int(max(fb - ft, fr - fl) * 0.25)
        lx1 = max(0, fl - pad)
        ly1 = max(0, ft - pad)
        lx2 = min(w_f, fr + pad)
        ly2 = min(h_f, fb + pad)
        loc_crop = tracker.best.full_frame[ly1:ly2, lx1:lx2]
        if (loc_crop.size > 0 and _is_bgr_sane(loc_crop)
                and loc_crop.shape[0] >= 20 and loc_crop.shape[1] >= 20):
            if _mp_available:
                if _detect_faces_mp(loc_crop, min_confidence=0.3):
                    face_snap_url = _save_image(loc_crop, prefix="face")
                    logger.debug("[cam-%d] tracker=%s dlib-loc crop validated by MP",
                                 camera_id, tracker.tracker_id)
                else:
                    logger.info("[cam-%d] tracker=%s dlib-loc crop rejected by MP — "
                                "trying crop_bgr", camera_id, tracker.tracker_id)
                    # Validate crop_bgr too before using it
                    if (_is_bgr_sane(tracker.best.crop_bgr)
                            and tracker.best.crop_bgr is not None
                            and tracker.best.crop_bgr.size > 0
                            and _detect_faces_mp(tracker.best.crop_bgr, min_confidence=0.3)):
                        face_snap_url = _save_image(tracker.best.crop_bgr, prefix="face")
                        logger.info("[cam-%d] tracker=%s crop_bgr validated by MP",
                                    camera_id, tracker.tracker_id)
                    else:
                        # Both loc_crop and crop_bgr rejected — use annotated frame
                        logger.info("[cam-%d] tracker=%s ALL crops rejected by MP — "
                                    "using annotated frame_snap as face snapshot",
                                    camera_id, tracker.tracker_id)
                        face_snap_url = frame_snap_url
            else:
                face_snap_url = _save_image(loc_crop, prefix="face")

    # Step 3 — last resort fallback
    if face_snap_url is None:
        # Validate crop_bgr before saving
        if (tracker.best.crop_bgr is not None
                and tracker.best.crop_bgr.size > 0
                and _is_bgr_sane(tracker.best.crop_bgr)):
            if not _mp_available or _detect_faces_mp(
                    tracker.best.crop_bgr, min_confidence=0.3):
                face_snap_url = _save_image(tracker.best.crop_bgr, prefix="face")
            else:
                face_snap_url = frame_snap_url  # annotated frame as absolute last resort
        else:
            face_snap_url = frame_snap_url

    if not _is_bgr_sane(tracker.best.crop_bgr):
        logger.error(
            "[cam-%d] tracker=%s HOG crop_bgr has inverted channels — possible BGR/RGB bug upstream",
            camera_id, tracker.tracker_id,
        )

    raw_detected_face_urls: list = []
    if multi_person:
        for (hx, hy, hw, hh) in haar_faces:
            pad = int(max(hw, hh) * 0.20)
            x1 = max(0, hx - pad)
            y1 = max(0, hy - pad)
            x2 = min(w_full, hx + hw + pad)
            y2 = min(h_full, hy + hh + pad)
            crop = tracker.best.full_frame[y1:y2, x1:x2]
            if crop.size > 0:
                # Reject Haar false positives (walls, patterns, glass) via YuNet.
                # Haar is very noisy when used as fallback without MediaPipe.
                if _YUNET_AVAILABLE and not _yunet_has_face(crop, min_score=0.45):
                    continue
                raw_detected_face_urls.append(_save_image(crop, prefix="face_haar"))

    # Filter out invalid/duplicate URLs; primary face_snap_url always goes first
    detected_face_urls = [url for url in raw_detected_face_urls if url and url != face_snap_url]
    if face_snap_url:
        detected_face_urls.insert(0, face_snap_url)

    # Recompute face count from validated detections.
    # Raw haar_count includes false positives; validated_face_count reflects real faces.
    validated_face_count = max(1, len(detected_face_urls))
    if validated_face_count <= 1:
        multi_person = False  # YuNet rejected all secondary faces

    logger.info(
        "[cam-%d] tracker=%s HAAR -> %d raw / %d validated face(s) multi=%s",
        camera_id, tracker.tracker_id, face_count, validated_face_count, multi_person,
    )

    # ── FACE VALIDITY CHECK ──────────────────────────────────────────────────
    # Read back the saved crop to confirm it contains a real face via MediaPipe.
    # If invalid → NO_FACE path: no DB person, no face matching, no bad encoding.
    face_crop_for_check = None
    if face_snap_url is not None:
        try:
            face_crop_for_check = cv2.imread(
                os.path.join(config.UPLOAD_DIR, os.path.basename(face_snap_url)))
        except Exception:
            face_crop_for_check = None
    face_is_valid = _face_snap_is_valid(face_snap_url, face_crop_for_check)
    # ────────────────────────────────────────────────────────────────────────

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

    if face_is_valid:
        # ── NORMAL PATH: face detected → identify + match ────────────────────
        tolerance  = float(settings.get("cvRecognitionTolerance", 0.50))
        person, similarity = face_engine.identify(encoding, tolerance=tolerance)
        person_id  = person["id"] if person else None

        if person is None:
            threat_level = "high"
        elif person.get("isBlacklisted"):
            threat_level = "critical"
        else:
            threat_level = "low"

        was_unknown = (person_id is None)
        if person_id is None:
            dedup_win = float(settings.get("cvCameraDedupWindowSec", config.CAMERA_DEDUP_WINDOW_SEC))
            # Hold the lock for the entire find-or-create so parallel workers
            # never both see "no match" and both insert a duplicate person.
            with _unknown_person_lock:
                # Re-check via face_engine first (reloads happen inside force_reload)
                person2, _ = face_engine.identify(encoding, tolerance=config.DEDUP_TOLERANCE)
                if person2 is not None:
                    person_id = person2["id"]
                    logger.info("[cam-%d] tracker=%s reused person_id=%d (post-lock identify)",
                                camera_id, tracker.tracker_id, person_id)
                else:
                    # Use DEDUP_TOLERANCE (0.65) — same person at different angles can score
                    # up to 0.65 distance; IDENTITY_MERGE_TOLERANCE (0.50) was too strict.
                    existing_pid = db.find_similar_unknown_person(
                        encoding.tolist(),
                        max_distance=config.DEDUP_TOLERANCE,
                        window_sec=dedup_win,
                    )
                    if existing_pid is not None:
                        person_id = existing_pid
                        logger.info("[cam-%d] tracker=%s reused person_id=%d",
                                    camera_id, tracker.tracker_id, person_id)
                    else:
                        person_id = db.insert_unknown_person(encoding.tolist(), photo_url=face_snap_url)
                        logger.info("[cam-%d] tracker=%s new unknown person_id=%d",
                                    camera_id, tracker.tracker_id, person_id)
                        face_engine.force_reload()
            threat_level = "high"

        detection_type  = "FACE"
        face_quality    = "UNCLEAR" if (not result.valid or tracker.best.sharpness < 30) else "CLEAR"
        confidence_val  = round(similarity * 100, 2)

    else:
        # ── NO-FACE PATH: body/cloth detected but no valid face ───────────────
        logger.info(
            "[cam-%d] tracker=%s NO VALID FACE — body-only alert "
            "(no person inserted, no face matching)",
            camera_id, tracker.tracker_id,
        )
        person_id      = None
        was_unknown    = True
        threat_level   = "medium"
        similarity     = 0.0
        detection_type = "NO_FACE"
        face_quality   = "NO_FACE"
        confidence_val = None
        face_snap_url  = frame_snap_url  # annotated frame as body snapshot

    is_blacklisted = (face_is_valid and person is not None
                      and bool(person.get("isBlacklisted"))) if face_is_valid else False

    # Cooldown / dedup — only for FACE alerts (NO_FACE has no encoding to dedup on)
    #
    # Strategy: presence-based dedup instead of fixed time window.
    #   1. In-memory passage dedup (_person_last_seen): if the last tracker for
    #      this (person_id, camera_id) finished < SAME_PASSAGE_GAP_SEC ago, it
    #      is the same physical pass → suppress. If the gap is larger the person
    #      left and came back → new passage → allow alert.
    #   2. Encoding dedup (short DB window): guards against re-alerting on the
    #      same encoding right after a worker restart when _person_last_seen is empty.
    #   3. Inside _alert_create_locks (below): ultra-short DB check (3 s) to
    #      prevent two parallel workers from double-inserting the same alert.
    if face_is_valid and not is_blacklisted:
        # ── 1. Presence-based (in-memory) ────────────────────────────────────
        with _person_last_seen_lock:
            key = (person_id, camera_id)
            last_seen = _person_last_seen.get(key, 0.0)
            now_mono  = time.monotonic()
            elapsed   = now_mono - last_seen
            _person_last_seen[key] = now_mono   # update even when suppressing

        if elapsed < config.SAME_PASSAGE_GAP_SEC:
            logger.info(
                "[cam-%d] tracker=%s SAME-PASSAGE DEDUP (%.1fs < %.1fs) — movement #%d logged",
                camera_id, tracker.tracker_id, elapsed, config.SAME_PASSAGE_GAP_SEC, movement_id,
            )
            return

        # ── 2. Encoding dedup — short window, restart-safety ─────────────────
        enc_window = config.ENCODING_DEDUP_WINDOW_SEC
        recent_encs = db.get_recent_alert_encodings(camera_id, enc_window)
        if recent_encs:
            sim_threshold = 1.0 - config.RECOGNITION_TOLERANCE
            for recent_enc_list in recent_encs:
                recent_enc = np.array(recent_enc_list, dtype=np.float64)
                sim = face_engine.compare_encodings(encoding, recent_enc)
                if sim >= sim_threshold:
                    logger.info(
                        "[cam-%d] tracker=%s ENCODING DEDUP — sim=%.3f — movement #%d logged",
                        camera_id, tracker.tracker_id, sim, movement_id,
                    )
                    return
    elif face_is_valid and is_blacklisted:
        logger.info(
            "[cam-%d] tracker=%s BLACKLISTED — bypassing cooldown/dedup, forcing critical alert",
            camera_id, tracker.tracker_id,
        )

    # Serialise alert creation per (person_id, camera_id) for FACE alerts
    alert_lock = _get_alert_lock(person_id, camera_id) if person_id is not None else threading.Lock()
    with alert_lock:
        if face_is_valid and not is_blacklisted and person_id is not None:
            # Ultra-short window (3s): guards against two parallel workers both
            # passing the presence-based check above and double-inserting an alert.
            if db.was_person_alerted_recently(person_id, camera_id, 3):
                logger.info(
                    "[cam-%d] tracker=%s DEDUP (inside lock) — person=%d already alerted — suppressed",
                    camera_id, tracker.tracker_id, person_id,
                )
                return

        alert_id = db.create_alert(
            camera_id=camera_id,
            zone_id=zone_id,
            person_id=person_id,
            threat_level=threat_level,
            confidence=confidence_val,
            face_snapshot_url=face_snap_url,
            best_frame_url=frame_snap_url,
            detection_type=detection_type,
            face_quality=face_quality,
            metadata={
                "multiPersonFrame":  multi_person,
                "faceCount":         validated_face_count,
                "detectedFaceUrls":  detected_face_urls,
                "sharpness":         round(tracker.best.sharpness, 2),
                "deepCheckPassed":   result.valid,
                "deepCheckReason":   result.reason,
                "faceQuality":       face_quality,
                "bodyOnlyDetection": (detection_type == "NO_FACE"),
            },
        )

    # Link alert back to movement record
    db.link_movement_to_alert(movement_id, alert_id)

    # Create secondary alerts for any additional persons Haar detected in this frame
    # Only when a valid face was detected (NO_FACE path skips secondary alerts)
    if face_is_valid and multi_person and validated_face_count > 1:
        _create_secondary_alerts(
            tracker=tracker,
            camera_id=camera_id,
            zone_id=zone_id,
            haar_faces=haar_faces,
            primary_encoding=encoding,
            primary_location=tracker.best.location,
            tolerance=float(settings.get("cvRecognitionTolerance", 0.50)),
            settings=settings,
            primary_movement_id=movement_id,
            frame_snap_url=frame_snap_url,
        )

    event_type = "no_face" if detection_type == "NO_FACE" else (
        "unknown" if was_unknown else "recognition"
    )
    db.create_event(
        camera_id=camera_id, zone_id=zone_id, person_id=person_id,
        alert_id=alert_id, confidence=confidence_val,
        event_type=event_type,
        payload={
            "trackerID":       tracker.tracker_id,
            "frameCount":      tracker.frame_count,
            "sharpness":       round(tracker.best.sharpness, 2),
            "similarity":      round(similarity, 4),
            "deepCheckConf":   round(result.confidence, 4),
            "deepCheckPassed": result.valid,
            "deepCheckReason": result.reason,
            "faceCount":       validated_face_count,
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
        locations, encodings = face_engine.detect_faces(small_rgb, model=_FACE_MODEL, upsample=1)

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
    if crop is None or crop.size == 0:
        return
    if not _is_bgr_sane(crop):
        return

    # ── 1. Brightness check — reject overexposed glass/windows ──
    gray_c          = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    mean_brightness = float(gray_c.mean())
    if mean_brightness > 190:
        # Overexposed — glass, window, bright light
        if tracker.best.crop_bgr is not None:
            return
        # No best yet — accept as placeholder with heavy penalty

    # ── 2. Saturation check — reject neutral glass/reflections ──
    hsv      = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    sat_mean = float(hsv[:, :, 1].mean()) / 255.0
    if sat_mean < 0.12:
        if tracker.best.crop_bgr is not None:
            return

    # ── 3. YuNet validation — most reliable face check ──────────
    # YuNet does NOT detect glass, badges, or reflections.
    # Only real faces with score >= 0.55 pass.
    is_artifact = (mean_brightness > 190 or sat_mean < 0.12)
    if not is_artifact:
        if _YUNET_AVAILABLE:
            if not _yunet_has_face(crop, min_score=0.55):
                # YuNet sees no face in this crop
                if tracker.best.crop_bgr is not None:
                    return  # keep existing best
                # No best yet — accept placeholder (better than nothing)
        elif _mp_available:
            # YuNet unavailable — fallback to MediaPipe
            if not _detect_faces_mp(crop, min_confidence=0.4):
                if tracker.best.crop_bgr is not None:
                    return

    # ── 4. Score computation — artifacts get heavy penalty ──────
    top, right, bottom, left = location
    area  = float((bottom - top) * (right - left))
    sharp = sharpness_score(gray_c)

    # Penalize artifacts: they must be far better than existing best
    # to replace it (effectively they won't win over a real face)
    penalty = 0.10 if is_artifact else 1.0
    score   = (area * 0.6 + sharp * 0.4) * penalty
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
        haar_loc = (hy, hx + hw, hy + hh, hx)

        if primary_location and _iou(haar_loc, primary_location) > 0.4:
            continue

        try:
            extra_encs = face_engine.get_encodings_at_locations(rgb_full, [haar_loc])
        except Exception as exc:
            logger.warning("[cam-%d] secondary encode failed: %s", camera_id, exc)
            continue

        if not extra_encs:
            continue

        extra_enc = extra_encs[0]

        if face_engine.compare_encodings(primary_encoding, extra_enc) > 0.70:
            continue

        # Validate secondary location contains a real face (not reflection/artifact)
        # YuNet is used as fallback when MediaPipe is unavailable (e.g. GPU server).
        pad_c = int(max(hw, hh) * 0.10)
        x1c = max(0, hx - pad_c); y1c = max(0, hy - pad_c)
        x2c = min(w_full, hx + hw + pad_c); y2c = min(h_full, hy + hh + pad_c)
        chk = tracker.best.full_frame[y1c:y2c, x1c:x2c]
        if chk.size > 0:
            if _mp_available and not _detect_faces_mp(chk, min_confidence=0.50):
                logger.info("[cam-%d] secondary location rejected by MediaPipe (reflection/artifact)", camera_id)
                continue
            elif not _mp_available and _YUNET_AVAILABLE and not _yunet_has_face(chk, min_score=0.50):
                logger.info("[cam-%d] secondary location rejected by YuNet (reflection/artifact)", camera_id)
                continue

        extra_person, extra_sim = face_engine.identify(extra_enc, tolerance=tolerance)
        extra_person_id = extra_person["id"] if extra_person else None
        is_blacklisted  = extra_person is not None and bool(extra_person.get("isBlacklisted"))

        if extra_person is None:
            extra_threat = "high"
        elif is_blacklisted:
            extra_threat = "critical"
        else:
            extra_threat = "low"

        if not is_blacklisted:
            # was_person_alerted_recently (below) handles per-camera cooldown.
            # No global bio_memory check — see primary path comment for rationale.
            pass

        # FIX 1 — annotated frame with green box on the SECONDARY person's position
        sec_full_frame = tracker.best.full_frame.copy()
        h_sf, w_sf = sec_full_frame.shape[:2]
        sx1, sy1 = max(0, hx),      max(0, hy)
        sx2, sy2 = min(w_sf, hx + hw), min(h_sf, hy + hh)
        cv2.rectangle(sec_full_frame, (sx1, sy1), (sx2, sy2), (0, 200, 50), 2)
        sec_frame_url = _save_image(sec_full_frame, prefix="frame_secondary")

        # FIX 2 — validate sec_crop before saving (reject de-dos/shoulder crops)
        pad = int(max(hw, hh) * 0.20)
        x1, y1 = max(0, hx - pad), max(0, hy - pad)
        x2, y2 = min(w_full, hx + hw + pad), min(h_full, hy + hh + pad)
        sec_crop = tracker.best.full_frame[y1:y2, x1:x2]

        # Step 1 — validate Haar crop with MediaPipe/YuNet before saving
        sec_face_url = None
        if (sec_crop.size > 0 and _is_bgr_sane(sec_crop)
                and sec_crop.shape[0] >= 20 and sec_crop.shape[1] >= 20):
            if _mp_available:
                if _detect_faces_mp(sec_crop, min_confidence=0.3):
                    sec_face_url = _save_image(sec_crop, prefix="face_secondary")
                else:
                    logger.info(
                        "[cam-%d] secondary crop rejected by MediaPipe "
                        "(de dos/pantalon) — head-zone fallback",
                        camera_id,
                    )
            elif _YUNET_AVAILABLE:
                if _yunet_has_face(sec_crop, min_score=0.55):
                    sec_face_url = _save_image(sec_crop, prefix="face_secondary")
                else:
                    logger.info("[cam-%d] secondary crop rejected by YuNet (glass/artifact) — head-zone fallback", camera_id)
            else:
                sec_face_url = _save_image(sec_crop, prefix="face_secondary")

        # Step 2 — head-zone fallback: top 45% of Haar bbox when MP rejected sec_crop
        if sec_face_url is None:
            head_h    = max(20, int(hh * 0.45))
            hx1       = max(0, hx - pad)
            hy1       = max(0, hy - pad)
            hx2       = min(w_full, hx + hw + pad)
            hy2       = min(h_full, hy + head_h + pad)
            head_crop = tracker.best.full_frame[hy1:hy2, hx1:hx2]
            if (head_crop.size > 0 and _is_bgr_sane(head_crop)
                    and head_crop.shape[0] >= 20 and head_crop.shape[1] >= 20):
                if _mp_available:
                    if _detect_faces_mp(head_crop, min_confidence=0.3):
                        sec_face_url = _save_image(head_crop, prefix="face_secondary_head")
                        logger.info("[cam-%d] secondary head-zone crop validated by MP", camera_id)
                if sec_face_url is None:
                    sec_face_url = sec_frame_url  # annotated frame — operator sees context
            else:
                sec_face_url = sec_frame_url

        # Auto-register unknown secondary person (same dedup logic as primary path)
        if extra_person_id is None:
            dedup_win2 = config.SCENE_BUFFER_SEC * 40   # ~120s look-back for secondary person creation
            with _unknown_person_lock:
                person2, _ = face_engine.identify(extra_enc, tolerance=config.DEDUP_TOLERANCE)
                if person2 is not None:
                    extra_person_id = person2["id"]
                    logger.info("[cam-%d] secondary reused person_id=%d (post-lock identify)",
                                camera_id, extra_person_id)
                else:
                    existing_pid = db.find_similar_unknown_person(
                        extra_enc.tolist(),
                        max_distance=config.DEDUP_TOLERANCE,
                        window_sec=dedup_win2,
                    )
                    if existing_pid is not None:
                        extra_person_id = existing_pid
                        logger.info("[cam-%d] secondary reused person_id=%d", camera_id, extra_person_id)
                    else:
                        extra_person_id = db.insert_unknown_person(extra_enc.tolist(), photo_url=sec_face_url)
                        logger.info("[cam-%d] secondary new unknown person_id=%d", camera_id, extra_person_id)
                        face_engine.force_reload()
            extra_threat = "high"

        # Presence-based dedup for secondary alerts (same logic as primary path)
        if not is_blacklisted:
            with _person_last_seen_lock:
                key2 = (extra_person_id, camera_id)
                last_seen2 = _person_last_seen.get(key2, 0.0)
                now_mono2  = time.monotonic()
                elapsed2   = now_mono2 - last_seen2
                _person_last_seen[key2] = now_mono2

            if elapsed2 < config.SAME_PASSAGE_GAP_SEC:
                logger.info(
                    "[cam-%d] secondary person=%d SAME-PASSAGE DEDUP (%.1fs) — skipping",
                    camera_id, extra_person_id, elapsed2,
                )
                continue

        sec_movement_id = db.create_movement(
            camera_id=camera_id,
            zone_id=zone_id,
            tracker_id=tracker.tracker_id + "_sec",
            frame_urls=tracker.clip_frame_urls,
            best_frame_url=sec_frame_url,    # FIX 1: green box on secondary
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
            best_frame_url=sec_frame_url,    # FIX 1: green box on secondary
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


def _detect_faces_mp(frame_bgr: np.ndarray, min_confidence: float = 0.5) -> list:
    """
    Detect faces using MediaPipe Face Detection.
    Returns list of (x, y, w, h) in pixel coords — same format as Haar output.
    Thread-safe via _mp_lock. Falls back to [] on any error.
    """
    h, w = frame_bgr.shape[:2]
    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    try:
        with _mp_lock:
            results = _mp_detector.process(frame_rgb)
    except Exception as exc:
        logger.warning("MediaPipe detection error: %s", exc)
        return []

    if not results.detections:
        return []

    faces = []
    for detection in results.detections:
        score = detection.score[0] if detection.score else 0.0
        if score < min_confidence:
            continue
        bbox = detection.location_data.relative_bounding_box
        x  = int(max(0, bbox.xmin * w))
        y  = int(max(0, bbox.ymin * h))
        bw = int(min(w - x, bbox.width  * w))
        bh = int(min(h - y, bbox.height * h))
        if bw >= 20 and bh >= 20:
            faces.append((x, y, bw, bh))
    return faces


def _is_bgr_sane(img: np.ndarray) -> bool:
    """Return False when blue channel dominates red by >1.5× — likely an RGB/BGR swap."""
    if img.ndim < 3 or img.shape[2] < 3:
        return True
    b_mean = float(np.mean(img[:, :, 0]))
    r_mean = float(np.mean(img[:, :, 2]))
    return not (r_mean > 0 and b_mean > r_mean * 1.5)


def _face_snap_is_valid(face_snap_url: "str | None",
                        crop_bgr: "np.ndarray | None") -> bool:
    """Returns True if the snapshot contains a real detectable face."""
    if face_snap_url is None:
        return False
    if crop_bgr is None or crop_bgr.size == 0:
        return False
    # YuNet is most reliable — use it first
    if _YUNET_AVAILABLE:
        return _yunet_has_face(crop_bgr, min_score=0.55)
    # MediaPipe fallback
    if _mp_available:
        return bool(_detect_faces_mp(crop_bgr, min_confidence=0.3))
    # No model available — basic sanity check
    return (_is_bgr_sane(crop_bgr)
            and crop_bgr.shape[0] >= 30
            and crop_bgr.shape[1] >= 30)


def _save_image(image: np.ndarray, prefix: str = "img") -> str:
    filename = f"{prefix}_{uuid.uuid4().hex}.jpg"
    path     = os.path.join(config.UPLOAD_DIR, filename)
    cv2.imwrite(path, image, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return f"/uploads/{filename}"
