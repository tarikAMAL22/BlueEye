"""
End-to-end test for body-only detection secondary alerts.

Run inside the cv-worker container:
    docker exec blueeye-cv-worker python /app/test_body_only_e2e.py

What it does:
1. Creates a synthetic 640x480 BGR frame with two "body" rectangles drawn on it.
2. Inserts a test movement + alert row pointing to that frame.
3. Patches detect_bodies / detect_faces_raw so the analyzer sees:
     - Body A at (50,100)-(150,400)  with a face inside it (1 RetinaFace hit)
     - Body B at (300,80)-(430,420)  with NO face  → should become body-only alert
4. Calls DeepAnalyzer._analyze_alert() directly (no thread needed).
5. Queries the DB and asserts a body-only secondary alert was created.
"""

import json
import os
import sys
import time
import uuid
from unittest.mock import patch

import cv2
import numpy as np
import pymysql
import pymysql.cursors

# ── Path setup ───────────────────────────────────────────────────────────────
sys.path.insert(0, "/app")

from cv_worker_v2 import config
from cv_worker_v2 import db_manager as db

# ── 1. Build synthetic frame and save it ─────────────────────────────────────
H, W = 480, 640
frame = np.zeros((H, W, 3), dtype=np.uint8)
frame[:] = (40, 40, 40)

# Body A (left) — will have a face inside
cv2.rectangle(frame, (50, 100), (150, 400), (0, 200, 80), -1)
# Face region inside body A (centred at ~(100, 130))
cv2.ellipse(frame, (100, 130), (30, 35), 0, 0, 360, (220, 180, 130), -1)

# Body B (right) — NO face → should become body-only alert
cv2.rectangle(frame, (300, 80), (430, 420), (0, 100, 200), -1)
# No face drawn

fname = f"test_body_frame_{uuid.uuid4().hex[:8]}.jpg"
fpath = os.path.join(config.UPLOAD_DIR, fname)
cv2.imwrite(fpath, frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
frame_url = f"/uploads/{fname}"
print(f"[1] Saved synthetic frame → {fpath}")

# ── 2. Insert test movement + alert ──────────────────────────────────────────
movement_id = db.create_movement(
    camera_id=6, zone_id=5,
    tracker_id=f"test_body_{uuid.uuid4().hex[:8]}",
    frame_urls=[], best_frame_url=frame_url,
    face_crop_url=frame_url, face_count=1, frame_count=1,
    alert_id=None,
)
alert_id = db.create_alert(
    camera_id=6, zone_id=5,
    person_id=None, threat_level="high",
    confidence=0.0, face_snapshot_url=frame_url,
    best_frame_url=frame_url, metadata=None,
)
db.link_movement_to_alert(movement_id, alert_id)
print(f"[2] Test alert #{alert_id}, movement #{movement_id}")

# ── 3. Define mock detectors ──────────────────────────────────────────────────
# Body A: (50,100,150,400)  Body B: (300,80,430,420)
MOCK_BODIES = [
    {"bbox": (50, 100, 150, 400), "confidence": 0.92},
    {"bbox": (300, 80, 430, 420), "confidence": 0.88},
]
# RetinaFace sees 1 face, centred inside Body A at (100, 130)
MOCK_FACES = [
    {"bbox": (70, 95, 130, 165), "confidence": 0.97},  # x1,y1,x2,y2 inside body A
]

def mock_detect_bodies(_frame):
    return MOCK_BODIES

def mock_detect_faces_raw(_frame):
    return MOCK_FACES

# ── 4. Run the analyzer ───────────────────────────────────────────────────────
print("[3] Running DeepAnalyzer._analyze_alert() with mocked detectors …")

import cv_worker_v2.deep_analyzer as da_module
from cv_worker_v2.deep_analyzer import DeepAnalyzer

# Fetch the alert row the same way the real code does
with db.get_connection() as conn:
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(
            "SELECT a.id, a.bestFrameSnapshotUrl, a.metadata, "
            "       a.personId, a.cameraId, a.zoneId, "
            "       m.id AS movementId "
            "FROM alerts a "
            "LEFT JOIN movements m ON m.alertId = a.id "
            "WHERE a.id = %s",
            (alert_id,)
        )
        alert_row = cur.fetchone()

assert alert_row, "Alert not found in DB!"

analyzer = DeepAnalyzer()

with (
    patch.object(da_module, "detect_bodies", mock_detect_bodies),
    patch.object(da_module, "detect_faces_raw", mock_detect_faces_raw),
):
    analyzer._analyze_alert(alert_row)

print("[3] Analysis complete.")

# ── 5. Verify secondary body-only alert in DB ─────────────────────────────────
time.sleep(0.5)  # small flush pause

with db.get_connection() as conn:
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(
            "SELECT id, personId, confidence, "
            "JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.bodyOnlyDetection'))  AS bodyOnly, "
            "JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.secondaryDetection')) AS secondary, "
            "JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.primaryAlertId'))     AS primaryAlertId "
            "FROM alerts "
            "WHERE JSON_EXTRACT(metadata,'$.primaryAlertId') = %s",
            (alert_id,)
        )
        secondaries = cur.fetchall()

print(f"\n[4] Secondary alerts created for primary #{alert_id}:")
if not secondaries:
    print("    NONE — body-only secondary was NOT created. Test FAILED.")
    sys.exit(1)

body_only_found = False
for row in secondaries:
    tag = "BODY-ONLY" if row["bodyOnly"] == "true" else "face-secondary"
    print(f"    Alert #{row['id']}: {tag}  personId={row['personId']}  confidence={row['confidence']}")
    if row["bodyOnly"] == "true":
        body_only_found = True

if body_only_found:
    print("\n[PASS] Body-only secondary alert created correctly.")
else:
    print("\n[FAIL] No body-only alert found — check logs above.")
    sys.exit(1)

# ── 6. Verify primary alert metadata updated ──────────────────────────────────
with db.get_connection() as conn:
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(
            "SELECT JSON_EXTRACT(metadata,'$.deepAnalyzed') as da, "
            "JSON_EXTRACT(metadata,'$.bodyCount') as bc, "
            "JSON_EXTRACT(metadata,'$.faceCount') as fc "
            "FROM alerts WHERE id=%s",
            (alert_id,)
        )
        primary = cur.fetchone()

print(f"\n[5] Primary alert #{alert_id} metadata: "
      f"deepAnalyzed={primary['da']} bodyCount={primary['bc']} faceCount={primary['fc']}")

print("\nAll checks passed. Body-only E2E test OK.")
