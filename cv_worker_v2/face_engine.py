"""
BlueEye CV Worker v2 — face_engine.py
face_recognition (dlib) engine with periodic identity reloading.
"""

import logging
import threading
import time
from typing import List, Tuple, Optional, Dict, Any

import face_recognition
import numpy as np

from . import config
from . import db_manager as db

logger = logging.getLogger(__name__)

# ─── Type aliases ─────────────────────────────────────────────────────────────
Encoding = np.ndarray          # shape (128,)
FaceLocation = Tuple[int, int, int, int]   # top, right, bottom, left


class FaceEngine:
    """
    Wraps face_recognition with:
    - Periodic reload of known identities from MySQL every IDENTITY_RELOAD_SEC.
    - Thread-safe access via a RLock.
    - A helper to detect + encode faces from a frame.
    - A helper to identify an encoding against the loaded identities.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()       # guards identity list
        self._dlib_lock = threading.Lock()   # serialises all dlib/face_recognition calls (not thread-safe)
        self._known_persons: List[Dict[str, Any]] = []   # [{id, name, encoding, threatLevel}]
        self._known_encodings: List[Encoding] = []
        self._last_reload: float = 0.0
        self._reload_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the background identity-reload thread."""
        self._load_identities()
        self._reload_thread = threading.Thread(
            target=self._reload_loop, daemon=True, name="face-engine-reload"
        )
        self._reload_thread.start()
        logger.info("FaceEngine started — %d known identities loaded", len(self._known_persons))

    def stop(self) -> None:
        self._stop_event.set()
        if self._reload_thread:
            self._reload_thread.join(timeout=5)
        logger.info("FaceEngine stopped")

    # ── Internal reload ───────────────────────────────────────────────────────

    def _reload_loop(self) -> None:
        while not self._stop_event.wait(timeout=config.IDENTITY_RELOAD_SEC):
            self._load_identities()

    def _load_identities(self) -> None:
        try:
            persons = db.fetch_all_persons()
            # Skip persons with no face encoding (body-only detections have encoding=[])
            valid = [(p, np.array(p["faceEncoding"], dtype=np.float64))
                     for p in persons if p.get("faceEncoding")]
            valid_persons   = [pair[0] for pair in valid]
            valid_encodings = [pair[1] for pair in valid]
            with self._lock:
                self._known_persons   = valid_persons
                self._known_encodings = valid_encodings
                self._last_reload = time.time()
            skipped = len(persons) - len(valid_persons)
            logger.debug(
                "Identities reloaded — %d persons (%d skipped — no encoding)",
                len(valid_persons), skipped,
            )
        except Exception as exc:
            logger.error("Identity reload failed: %s", exc)

    # ── Detection ─────────────────────────────────────────────────────────────

    def detect_faces(
        self,
        rgb_frame: np.ndarray,
        model: str = "hog",
        upsample: int = 0
    ) -> Tuple[List[FaceLocation], List[Encoding]]:
        """
        Detect faces in *rgb_frame* and compute their 128-d encodings.

        Returns (locations, encodings) — both lists, same order.
        Uses the 'hog' model by default for speed; switch to 'cnn' for accuracy.
        *upsample* = number of times to upscale image before searching (finds smaller faces).
        """
        with self._dlib_lock:
            locations = face_recognition.face_locations(rgb_frame, number_of_times_to_upsample=upsample, model=model)
            if not locations:
                return [], []
            encodings = face_recognition.face_encodings(rgb_frame, locations)
        return locations, encodings

    def count_landmarks(self, rgb_frame: np.ndarray, location: FaceLocation) -> int:
        """
        Return the total number of landmark points detected for a single face.
        face_recognition returns a dict with keys like 'left_eye', etc., each a list of (x,y).
        """
        with self._dlib_lock:
            landmarks_list = face_recognition.face_landmarks(rgb_frame, [location])
        if not landmarks_list:
            return 0
        total = sum(len(pts) for pts in landmarks_list[0].values())
        return total

    def has_critical_organs(self, rgb_frame: np.ndarray, location: FaceLocation) -> bool:
        """Return True only if eyes AND nose landmarks are present."""
        with self._dlib_lock:
            landmarks_list = face_recognition.face_landmarks(rgb_frame, [location])
        if not landmarks_list:
            return False
        lm = landmarks_list[0]
        return bool(lm.get("left_eye") and lm.get("right_eye") and lm.get("nose_bridge"))

    # ── Identification ────────────────────────────────────────────────────────

    def identify(
        self,
        encoding: Encoding,
        tolerance: Optional[float] = None
    ) -> Tuple[Optional[Dict[str, Any]], float]:
        """
        Compare *encoding* against all known persons.
        Returns (best_person_dict_or_None, similarity_0_to_1).

        similarity = 1 - face_distance (so 1.0 = perfect match).
        """
        if tolerance is None:
            tolerance = config.RECOGNITION_TOLERANCE

        with self._lock:
            if not self._known_encodings:
                return None, 0.0
            known_encodings = list(self._known_encodings)
            known_persons   = list(self._known_persons)

        with self._dlib_lock:
            distances = face_recognition.face_distance(known_encodings, encoding)
        best_idx  = int(np.argmin(distances))
        best_dist = float(distances[best_idx])

        similarity = 1.0 - best_dist
        if best_dist <= tolerance:
            return known_persons[best_idx], similarity
        return None, similarity

    def compare_encodings(self, enc_a: Encoding, enc_b: Encoding) -> float:
        """Return similarity (0–1) between two encodings."""
        with self._dlib_lock:
            dist = float(face_recognition.face_distance([enc_a], enc_b)[0])
        return 1.0 - dist

    def get_encodings_at_locations(
        self,
        rgb_frame: np.ndarray,
        locations: List[FaceLocation],
    ) -> List[Encoding]:
        """Compute dlib encodings for pre-known face locations (no detection step)."""
        with self._dlib_lock:
            raw = face_recognition.face_encodings(rgb_frame, locations)
        return [np.array(e, dtype=np.float64) for e in raw]

    def force_reload(self) -> None:
        """Force an immediate identity reload, bypassing the cache timer."""
        self._load_identities()


# ── Module-level singleton ────────────────────────────────────────────────────
engine = FaceEngine()
