"""
BlueEye CV Worker v2 — biometric_memory.py
Global cache of recently-alerted encodings with a configurable cooldown.
Provides 1:1 matching to suppress duplicate alerts across cameras.
"""

import logging
import threading
import time
from typing import List, Optional, Tuple

import numpy as np
import face_recognition

from . import config

logger = logging.getLogger(__name__)

Encoding = np.ndarray


class BiometricMemory:
    """
    Thread-safe in-memory store that tracks recently-alerted face encodings.

    Workflow
    --------
    1. Before firing an alert, call ``check_and_register(encoding)``.
    2. If the encoding matches a recent entry (within cooldown), returns False → skip alert.
    3. Otherwise registers the encoding and returns True → proceed with alert.

    Stale entries (older than ALERT_COOLDOWN_SEC) are purged lazily on every access.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # List of (encoding, timestamp, person_id_or_None)
        self._entries: List[Tuple[Encoding, float, Optional[int]]] = []

    # ── Public API ────────────────────────────────────────────────────────────

    def check_and_register(
        self,
        encoding: Encoding,
        person_id: Optional[int] = None,
        tolerance: float = config.RECOGNITION_TOLERANCE,
        cooldown_sec: Optional[int] = None,
    ) -> bool:
        """
        Return True and register if the encoding is *not* in cooldown.
        Return False if a similar encoding was alerted within cooldown_sec.
        """
        if cooldown_sec is None:
            cooldown_sec = config.ALERT_COOLDOWN_SEC

        with self._lock:
            self._purge_stale(cooldown_sec)
            if self._is_duplicate(encoding, tolerance):
                logger.debug("BiometricMemory: duplicate suppressed (person_id=%s)", person_id)
                return False
            self._entries.append((encoding, time.time(), person_id))
            logger.debug(
                "BiometricMemory: registered person_id=%s — %d entries total",
                person_id, len(self._entries),
            )
            return True

    def is_known(
        self,
        encoding: Encoding,
        tolerance: float = config.RECOGNITION_TOLERANCE,
    ) -> bool:
        """Read-only check without registration."""
        with self._lock:
            self._purge_stale()
            return self._is_duplicate(encoding, tolerance)

    def invalidate(self, person_id: int) -> int:
        """
        Remove all cache entries for *person_id* (e.g. after a "Not Him" correction).
        Returns the number of entries removed.
        """
        with self._lock:
            before = len(self._entries)
            self._entries = [e for e in self._entries if e[2] != person_id]
            removed = before - len(self._entries)
        logger.info("BiometricMemory: invalidated %d entries for person_id=%d", removed, person_id)
        return removed

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
        logger.info("BiometricMemory: cleared")

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _purge_stale(self, cooldown_sec: int) -> None:
        """Remove entries older than cooldown_sec. Call under lock."""
        cutoff = time.time() - cooldown_sec
        before = len(self._entries)
        self._entries = [e for e in self._entries if e[1] >= cutoff]
        removed = before - len(self._entries)
        if removed:
            logger.debug("BiometricMemory: purged %d stale entries", removed)

    def _is_duplicate(self, encoding: Encoding, tolerance: float) -> bool:
        """True if any cached encoding matches within *tolerance*. Call under lock."""
        if not self._entries:
            return False
        cached_encodings = [e[0] for e in self._entries]
        distances = face_recognition.face_distance(cached_encodings, encoding)
        return bool(np.any(distances <= tolerance))


# ── Module-level singleton ────────────────────────────────────────────────────
memory = BiometricMemory()
