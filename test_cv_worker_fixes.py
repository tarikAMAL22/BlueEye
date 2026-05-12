"""
Unit tests for cv_worker.py Bug #1–#5 fixes.
Run locally: python test_cv_worker_fixes.py

Covers:
  - is_valid_face_crop()        Bug #5 — invalid crop gate
  - FaceMatcher._parse_rows()   Bug #5 — encoding validation
  - _nms_haar()                 Haar NMS (cv_worker_v2/processor.py)
"""
import sys, types, json
import numpy as np
import cv2

# ── Stub heavy deps so we don't need face_recognition / flask installed ───────
for mod in ("face_recognition", "flask", "mysql", "mysql.connector", "requests"):
    sys.modules.setdefault(mod, types.ModuleType(mod))
sys.modules["flask"].Flask   = lambda *a, **k: None
sys.modules["flask"].request = None
sys.modules["flask"].jsonify = lambda x: x
mc = sys.modules["mysql.connector"]
mc.connect = lambda **k: None

# ── Import after stubs ────────────────────────────────────────────────────────
sys.path.insert(0, ".")
from cv_worker import is_valid_face_crop, FaceMatcher

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
results = []

def check(name, cond):
    tag = PASS if cond else FAIL
    print(f"  [{tag}] {name}")
    results.append(cond)

# ═══════════════════════════════════════════════════════════════
# is_valid_face_crop
# ═══════════════════════════════════════════════════════════════
print("\n── is_valid_face_crop ──────────────────────────────────────")

check("None input rejected",
      not is_valid_face_crop(None))

check("Empty array rejected",
      not is_valid_face_crop(np.zeros((0, 0, 3), np.uint8)))

check("Below 80 px rejected",
      not is_valid_face_crop(np.random.randint(0, 255, (50, 50, 3), dtype=np.uint8)))

check("Solid-colour (shirt) rejected — std < 20",
      not is_valid_face_crop(np.full((200, 160, 3), 120, dtype=np.uint8)))

blurry = cv2.GaussianBlur(
    np.random.randint(0, 40, (200, 160, 3), dtype=np.uint8).astype(np.float32),
    (31, 31), 0).astype(np.uint8)
check("Blurry image rejected — Laplacian < 50",
      not is_valid_face_crop(blurry))

check("Wide torso crop rejected — aspect < 0.8",
      not is_valid_face_crop(np.random.randint(30, 200, (80, 400, 3), dtype=np.uint8)))

check("Too-tall crop rejected — aspect > 2.5",
      not is_valid_face_crop(np.random.randint(30, 200, (600, 80, 3), dtype=np.uint8)))

sharp_face = np.random.randint(50, 200, (200, 160, 3), dtype=np.uint8)
check("Valid sharp face crop accepted",
      is_valid_face_crop(sharp_face))

# ═══════════════════════════════════════════════════════════════
# FaceMatcher._parse_rows  (encoding validation)
# ═══════════════════════════════════════════════════════════════
print("\n── FaceMatcher._parse_rows ─────────────────────────────────")

rows = [
    {"id": 1, "role": "staff",   "faceEncoding": json.dumps([0.1] * 128)},  # good
    {"id": 2, "role": "UNKNOWN", "faceEncoding": json.dumps([0.1] * 64)},   # wrong length
    {"id": 3, "role": "UNKNOWN", "faceEncoding": json.dumps([])},           # empty
    {"id": 4, "role": "UNKNOWN", "faceEncoding": "not-json"},               # corrupt
    {"id": 5, "role": "staff",   "faceEncoding": json.dumps([0.2] * 128)},  # good
]
matcher = FaceMatcher()
enc, ids, roles, skipped = matcher._parse_rows(rows)

check("2 valid encodings loaded (IDs 1 and 5)",  ids == [1, 5])
check("3 bad rows skipped",                       skipped == 3)
check("Encodings are 128-d arrays",               all(e.shape == (128,) for e in enc))

# ═══════════════════════════════════════════════════════════════
# _nms_haar  (cv_worker_v2/processor.py)
# ═══════════════════════════════════════════════════════════════
print("\n── _nms_haar (cv_worker_v2) ────────────────────────────────")
try:
    # processor.py has no heavy import-time side-effects for _nms_haar
    sys.path.insert(0, "cv_worker_v2")

    # Stub cv_worker_v2 sub-imports
    for mod in ("cv_worker_v2.config", "cv_worker_v2.db_manager",
                 "cv_worker_v2.face_engine", "cv_worker_v2.biometric_memory",
                 "dbutils", "dbutils.pooled_db", "pymysql", "ultralytics",
                 "retinaface"):
        sys.modules.setdefault(mod, types.ModuleType(mod.split(".")[-1]))

    import importlib, cv_worker_v2.processor as proc_mod
    nms = proc_mod._nms_haar

    check("Single box kept unchanged",
          nms([(10, 10, 80, 80)]) == [(10, 10, 80, 80)])

    check("Identical boxes deduped to 1",
          len(nms([(10, 10, 80, 80), (10, 10, 80, 80)])) == 1)

    check("High-IOU overlap deduped (same face twice)",
          len(nms([(10, 10, 80, 80), (15, 15, 70, 70)])) == 1)

    # Center of small box (95,95) falls inside large box (10,10,200,200)
    check("Contained center suppressed",
          len(nms([(10, 10, 200, 200), (80, 80, 30, 30)])) == 1)

    check("Two well-separated faces both kept",
          len(nms([(10, 10, 80, 80), (400, 10, 80, 80)])) == 2)

except Exception as exc:
    print(f"  [SKIP] _nms_haar import failed: {exc}")
    print("         (run inside Docker container for full coverage)")

# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════
total  = len(results)
passed = sum(results)
print(f"\n{'='*50}")
print(f"  {passed}/{total} tests passed {'✓' if passed == total else '✗'}")
if passed < total:
    sys.exit(1)
