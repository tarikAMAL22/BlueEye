"""
BlueEye CV Worker v2 — validator.py
"Deep Check" secondary validation on face crops to eliminate false positives
(T-shirts with printed faces, shadows, blurry artifacts, etc.).
"""

import logging
from dataclasses import dataclass

import cv2
import numpy as np

from . import config

logger = logging.getLogger(__name__)

Encoding = np.ndarray


@dataclass
class ValidationResult:
    valid: bool
    reason: str            # Human-readable reason (used for logging)
    confidence: float      # 0–1 quality score


class Validator:
    """
    Performs secondary validation on a face crop (BGR numpy array).

    Checks (in order of cheapness):
    1. Minimum size guard                → rejects tiny crops
    2. Blur / Laplacian variance         → rejects out-of-focus patches
    3. Skin-tone heuristic               → rejects monochrome / low-saturation regions

    Steps 4 (dlib re-detection) and 5 (EAR) were removed: calling
    face_recognition.face_locations() from the PersistenceWorker thread
    concurrently with DetectionWorker threads is not thread-safe in dlib
    and caused repeated `double free or corruption` crashes.
    """

    # ── Tunable thresholds ────────────────────────────────────────────────────
    BLUR_THRESHOLD        = 40.0    # Laplacian variance; lower = blurrier
    SKIN_SAT_MIN          = 0.08    # Min average HSV saturation (0–1) for skin
    MIN_CROP_SIZE         = 48      # Minimum width/height of crop (px)

    def validate(self, crop_bgr: np.ndarray) -> ValidationResult:
        """
        Run all validation layers on *crop_bgr*.
        Returns a ValidationResult with valid=True only if all checks pass.
        """
        h, w = crop_bgr.shape[:2]

        # 1. Size check
        if w < self.MIN_CROP_SIZE or h < self.MIN_CROP_SIZE:
            return ValidationResult(False, f"crop too small ({w}×{h}px)", 0.0)

        # 2. Blur check
        blur_score = self._laplacian_variance(crop_bgr)
        if blur_score < self.BLUR_THRESHOLD:
            return ValidationResult(
                False,
                f"excessive blur (var={blur_score:.1f} < {self.BLUR_THRESHOLD})",
                blur_score / self.BLUR_THRESHOLD,
            )

        # 3. Skin-tone check
        sat_mean = self._mean_saturation(crop_bgr)
        if sat_mean < self.SKIN_SAT_MIN:
            return ValidationResult(
                False,
                f"low saturation (sat={sat_mean:.3f}) — possible shadow/grayscale artefact",
                sat_mean / self.SKIN_SAT_MIN,
            )

        confidence = min(1.0, (blur_score / 300.0 + sat_mean * 2) / 2.0)
        return ValidationResult(True, "all checks passed", confidence)

    # ── Static quality helpers ─────────────────────────────────────────────────

    @staticmethod
    def _laplacian_variance(bgr: np.ndarray) -> float:
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())

    @staticmethod
    def _mean_saturation(bgr: np.ndarray) -> float:
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        return float(hsv[:, :, 1].mean()) / 255.0


def sharpness_score(gray_crop: np.ndarray) -> float:
    """Utility: return Laplacian variance of a grayscale crop (higher = sharper)."""
    return float(cv2.Laplacian(gray_crop, cv2.CV_64F).var())


# ── Module-level singleton ────────────────────────────────────────────────────
validator = Validator()
