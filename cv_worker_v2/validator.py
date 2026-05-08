"""
BlueEye CV Worker v2 — validator.py
"Deep Check" secondary validation on face crops to eliminate false positives
(T-shirts with printed faces, shadows, blurry artifacts, etc.).
"""

import logging
from dataclasses import dataclass
from typing import Tuple

import cv2
import numpy as np
import face_recognition

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
    Performs multi-layer secondary validation on a face crop (BGR numpy array).

    Checks (in order of cheapness):
    1. Minimum size guard                → rejects tiny crops
    2. Blur / Laplacian variance         → rejects out-of-focus patches
    3. Skin-tone heuristic               → rejects monochrome / low-saturation regions
    4. Re-detection of landmarks         → ensures a *real* face is present
    5. Eyes-open heuristic (EAR proxy)   → rejects closed-eye / non-face artefacts
    """

    # ── Tunable thresholds ────────────────────────────────────────────────────
    BLUR_THRESHOLD        = 80.0    # Laplacian variance; lower = blurrier
    SKIN_SAT_MIN          = 0.08    # Min average HSV saturation (0–1) for skin
    EAR_THRESHOLD         = 0.15    # Eye Aspect Ratio proxy (approx.)
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

        # 4. Re-detect landmarks in the crop
        rgb_crop = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
        locations = face_recognition.face_locations(rgb_crop, model="hog")
        if not locations:
            return ValidationResult(False, "no face detected in crop by re-check", 0.2)

        landmarks_list = face_recognition.face_landmarks(rgb_crop, locations)
        if not landmarks_list:
            return ValidationResult(False, "no landmarks detected in crop", 0.3)

        lm = landmarks_list[0]
        if not (lm.get("left_eye") and lm.get("right_eye")):
            return ValidationResult(False, "eyes missing in crop landmark check", 0.4)

        # 5. EAR proxy — eyes should be at least partially open
        ear = self._eye_aspect_ratio(lm)
        if ear < self.EAR_THRESHOLD:
            return ValidationResult(
                False,
                f"eyes appear closed (EAR={ear:.3f} < {self.EAR_THRESHOLD})",
                ear / self.EAR_THRESHOLD,
            )

        confidence = min(1.0, (blur_score / 300.0 + sat_mean * 2 + ear * 2) / 3.0)
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

    @staticmethod
    def _eye_aspect_ratio(landmarks: dict) -> float:
        """
        Approximate EAR using the vertical spread of eye landmark points
        divided by horizontal spread.  Works with face_recognition landmarks.
        """
        def _ear(eye_pts):
            if len(eye_pts) < 4:
                return 0.0
            pts = np.array(eye_pts)
            h = float(pts[:, 1].max() - pts[:, 1].min())  # vertical
            w = float(pts[:, 0].max() - pts[:, 0].min())  # horizontal
            return h / (w + 1e-6)

        left  = _ear(landmarks.get("left_eye",  []))
        right = _ear(landmarks.get("right_eye", []))
        return (left + right) / 2.0


def sharpness_score(gray_crop: np.ndarray) -> float:
    """Utility: return Laplacian variance of a grayscale crop (higher = sharper)."""
    return float(cv2.Laplacian(gray_crop, cv2.CV_64F).var())


# ── Module-level singleton ────────────────────────────────────────────────────
validator = Validator()
