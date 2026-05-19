"""
BlueEye CV Worker v2 — db_manager.py
MySQL connection pool management with async-style helpers.
"""

import json
import logging
import datetime
import uuid
from contextlib import contextmanager
from typing import Optional, List, Dict, Any

import numpy as np
import face_recognition
import pymysql                           # sync fallback / pool init
from dbutils.pooled_db import PooledDB  # connection pooling (DBUtils)

from . import config

logger = logging.getLogger(__name__)

# ─── Synchronous pool (used by threaded processor) ───────────────────────────

_pool: Optional[PooledDB] = None


def get_pool() -> PooledDB:
    """Return (or lazily create) the global synchronous DB pool."""
    global _pool
    if _pool is None:
        _pool = PooledDB(
            creator=pymysql,
            mincached=config.DB_POOL_MIN,
            maxcached=config.DB_POOL_MAX,
            maxconnections=config.DB_POOL_MAX,
            blocking=True,
            **config.DB_CONFIG,
        )
        logger.info("DB pool initialised (min=%d, max=%d)", config.DB_POOL_MIN, config.DB_POOL_MAX)
    return _pool


@contextmanager
def get_connection():
    """Context manager that yields a DB connection from the pool."""
    pool = get_pool()
    conn = pool.connection()
    try:
        yield conn
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()  # returns to pool


def ensure_movements_table() -> None:
    """Create the movements table if it does not exist (idempotent migration)."""
    sql = """
        CREATE TABLE IF NOT EXISTS `movements` (
            `id`           INT           NOT NULL AUTO_INCREMENT,
            `cameraId`     INT           NOT NULL,
            `zoneId`       INT           NOT NULL DEFAULT 1,
            `trackerId`    VARCHAR(64)   NOT NULL,
            `frameUrls`    JSON          NULL,
            `bestFrameUrl` VARCHAR(512)  NULL,
            `faceCount`    INT           NOT NULL DEFAULT 0,
            `frameCount`   INT           NOT NULL DEFAULT 0,
            `alertId`      INT           NULL,
            `timestamp`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `createdAt`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            INDEX `idx_movements_camera`    (`cameraId`),
            INDEX `idx_movements_timestamp` (`timestamp`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
    logger.info("movements table ready")


def get_settings() -> Dict[str, Any]:
    """Fetch the first row of the settings table."""
    sql = "SELECT * FROM settings LIMIT 1"
    with get_connection() as conn:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(sql)
            row = cur.fetchone()
    return row or {}


# ─── Helper queries ──────────────────────────────────────────────────────────

def fetch_all_persons() -> List[Dict[str, Any]]:
    """
    Load all persons with a stored faceEncoding from the `persons` table.
    Returns a list of dicts: {id, name, faceEncoding (list[float]), ...}
    """
    sql = "SELECT id, name, faceEncoding, isBlacklisted FROM persons WHERE faceEncoding IS NOT NULL"
    with get_connection() as conn:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(sql)
            rows = cur.fetchall()

    persons = []
    for row in rows:
        try:
            row["faceEncoding"] = json.loads(row["faceEncoding"])
            persons.append(row)
        except (json.JSONDecodeError, TypeError):
            logger.warning("Invalid faceEncoding for person id=%s — skipping", row.get("id"))
    return persons


def get_default_group_id() -> Optional[int]:
    """Return the id of the group marked isDefault=1, or None."""
    with get_connection() as conn:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute("SELECT id FROM access_groups WHERE isDefault = 1 LIMIT 1")
            row = cur.fetchone()
    return row["id"] if row else None


def add_person_to_group(person_id: int, group_id: int) -> None:
    """Add a person to an access group (ignore duplicate)."""
    sql = """
        INSERT IGNORE INTO person_group_membership (personId, groupId, addedAt)
        VALUES (%s, %s, %s)
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (person_id, group_id, datetime.datetime.utcnow()))
        conn.commit()


def check_zone_access(person_id: int, zone_id: int) -> bool:
    """
    Return True if the person belongs to at least one group that has access to zone_id.
    Returns True for unknown persons (no groups) so the caller can handle that separately.
    """
    sql = """
        SELECT COUNT(*) AS cnt
        FROM person_group_membership pgm
        JOIN group_zone_access gza ON gza.groupId = pgm.groupId
        WHERE pgm.personId = %s AND gza.zoneId = %s
    """
    with get_connection() as conn:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(sql, (person_id, zone_id))
            row = cur.fetchone()
    return (row["cnt"] > 0) if row else False


def insert_unknown_person(face_encoding: List[float], photo_url: Optional[str] = None) -> int:
    """
    Auto-register an unknown person, assign to default group, and return the new person id.
    """
    sql = """
        INSERT INTO persons (name, role, faceEncoding, photoUrl, createdAt, updatedAt)
        VALUES (%s, %s, %s, %s, %s, %s)
    """
    now = datetime.datetime.utcnow()
    unique_id = str(uuid.uuid4())[:8]
    payload = (
        f"unknown-{unique_id}",
        "UNKNOWN",
        json.dumps(face_encoding),
        photo_url,
        now,
        now
    )
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, payload)
            person_id = cur.lastrowid
        conn.commit()
    logger.info("Auto-registered unknown person id=%d", person_id)

    # Assign to default group (e.g. "Inconnus") if one exists
    default_group_id = get_default_group_id()
    if default_group_id:
        add_person_to_group(person_id, default_group_id)

    return person_id


def create_alert(
    camera_id: int,
    zone_id: int,
    person_id: Optional[int],
    threat_level: str,
    confidence: Optional[float],
    face_snapshot_url: str,
    best_frame_url: str,
    metadata: Optional[Dict[str, Any]] = None,
    detection_type: str = 'FACE',
    face_quality: str = 'CLEAR',
) -> int:
    """Insert a row into `alerts` and return the alert id."""
    sql = """
        INSERT INTO alerts
            (cameraId, zoneId, personId, threatLevel, confidence,
             faceSnapshotUrl, bestFrameSnapshotUrl, status, metadata,
             detectionType, faceQuality, createdAt)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    now = datetime.datetime.utcnow()
    payload = (
        camera_id, zone_id, person_id, threat_level, confidence,
        face_snapshot_url, best_frame_url, "active",
        json.dumps(metadata) if metadata else None,
        detection_type, face_quality,
        now,
    )
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, payload)
            alert_id = cur.lastrowid
        conn.commit()
    logger.info("Alert created id=%d person=%s threat=%s confidence=%.2f", alert_id, person_id, threat_level, confidence)
    return alert_id


def create_movement(
    camera_id: int,
    zone_id: int,
    tracker_id: str,
    frame_urls: List[str],
    best_frame_url: Optional[str],
    face_crop_url: Optional[str],
    face_count: int,
    frame_count: int,
    alert_id: Optional[int] = None,
    detection_type: str = "MOTION",
) -> int:
    """Insert a row into `movements` and return its id."""
    sql = """
        INSERT INTO movements
            (cameraId, zoneId, trackerId, frameUrls, bestFrameUrl, faceCropUrl,
             faceCount, frameCount, alertId, detectionType, createdAt)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    now = datetime.datetime.utcnow()
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (
                camera_id, zone_id, tracker_id,
                json.dumps(frame_urls), best_frame_url, face_crop_url,
                face_count, frame_count, alert_id, detection_type, now,
            ))
            movement_id = cur.lastrowid
        conn.commit()
    logger.info("Movement created id=%d tracker=%s frames=%d", movement_id, tracker_id, frame_count)
    return movement_id


def link_movement_to_alert(movement_id: int, alert_id: int) -> None:
    """Update a movement record to link it to its generated alert."""
    sql = "UPDATE movements SET alertId = %s WHERE id = %s"
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (alert_id, movement_id))
        conn.commit()


def create_event(camera_id: int, zone_id: int, person_id: Optional[int], alert_id: Optional[int], confidence: float, event_type: str, payload: Dict[str, Any]) -> int:
    """Insert a supplementary row into `events`."""
    sql = """
        INSERT INTO events (cameraId, zoneId, personId, alertId, confidence, eventType, payload, createdAt)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
    """
    now = datetime.datetime.utcnow()
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (
                camera_id, zone_id, person_id, alert_id,
                confidence, event_type,
                json.dumps(payload),
                now
            ))
            event_id = cur.lastrowid
        conn.commit()
    return event_id


def process_not_him(alert_id: int) -> Dict[str, Any]:
    """
    User flagged identification as wrong.
    We'll create a NEW unknown person and re-assign the alert to them.
    This effectively "un-identifies" the detection.
    """
    with get_connection() as conn:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            # 1. Get alert details to find the current person
            cur.execute("SELECT personId, faceSnapshotUrl FROM alerts WHERE id = %s", (alert_id,))
            alert = cur.fetchone()
            if not alert:
                raise Exception(f"Alert {alert_id} not found")

            old_person_id = alert["personId"]
            face_url      = alert["faceSnapshotUrl"]

            # 2. Create a new unknown person
            # We don't have the original encoding here easily, so we use an empty list or null
            # In a better version, we'd store encoding in the alerts table
            sql_new_p = """
                INSERT INTO persons (name, role, photoUrl, createdAt, updatedAt)
                VALUES (%s, %s, %s, %s, %s)
            """
            now = datetime.datetime.utcnow()
            unique_id = str(uuid.uuid4())[:8]
            new_name = f"unknown-{unique_id}"
            cur.execute(sql_new_p, (new_name, "UNKNOWN", face_url, now, now))
            new_person_id = cur.lastrowid

            # 3. Update the alert
            cur.execute("UPDATE alerts SET personId = %s, threatLevel = 'high' WHERE id = %s", (new_person_id, alert_id))
            
            # 4. Log the correction
            cur.execute("""
                INSERT INTO events (cameraId, zoneId, personId, alertId, confidence, eventType, payload, createdAt)
                SELECT cameraId, zoneId, %s, %s, confidence, 'identity_correction', %s, %s
                FROM alerts WHERE id = %s
            """, (new_person_id, alert_id, json.dumps({"action": "not_him", "old_person": old_person_id}), now, alert_id))

        conn.commit()

    logger.info("Alert %d re-assigned from %s to new unknown %d", alert_id, old_person_id, new_person_id)
    return {"newPersonId": new_person_id, "newPersonName": new_name}


def update_person_identity(alert_id: int, correct_person_id: int) -> None:
    """Rematching: update the personId of an existing alert."""
    sql = "UPDATE alerts SET personId = %s WHERE id = %s"
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (correct_person_id, alert_id))
        conn.commit()
    logger.info("Alert %d reassigned to person %d", alert_id, correct_person_id)


def get_recent_alert_encoding(camera_id: int, window_sec: float) -> Optional[List[float]]:
    """
    Return the faceEncoding of the person from the most recent alert on this
    camera created within the last window_sec seconds, or None if there is none.
    Used for camera-level dedup before creating a new alert.
    """
    sql = """
        SELECT p.faceEncoding
        FROM alerts a
        JOIN persons p ON p.id = a.personId
        WHERE a.cameraId = %s
          AND a.createdAt >= NOW() - INTERVAL %s SECOND
          AND p.faceEncoding IS NOT NULL
        ORDER BY a.createdAt DESC
        LIMIT 1
    """
    with get_connection() as conn:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(sql, (camera_id, window_sec))
            row = cur.fetchone()
    if row is None:
        return None
    try:
        enc = json.loads(row["faceEncoding"])
        return enc if enc else None  # treat [] (body-only) as no encoding
    except (json.JSONDecodeError, TypeError):
        return None


def find_similar_unknown_person(
    encoding: list,
    max_distance: float = 0.65,
    window_sec: float = 120,
) -> Optional[int]:
    """
    Search for an existing unknown person inserted within window_sec whose
    faceEncoding is within max_distance of the given encoding.
    Prevents race-condition duplicates when parallel detection workers both
    see person_id=None and attempt to insert the same unknown person.
    """
    sql = """
        SELECT id, faceEncoding
        FROM persons
        WHERE role = 'UNKNOWN'
          AND createdAt >= NOW() - INTERVAL %s SECOND
          AND faceEncoding IS NOT NULL
          AND faceEncoding != '[]'
        ORDER BY createdAt DESC
        LIMIT 20
    """
    with get_connection() as conn:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(sql, (window_sec,))
            rows = cur.fetchall()
    if not rows:
        return None

    enc_np = np.array(encoding, dtype=np.float64)
    for row in rows:
        try:
            db_enc_list = json.loads(row["faceEncoding"])
            if not db_enc_list or len(db_enc_list) != 128:
                continue
            db_enc = np.array(db_enc_list, dtype=np.float64)
            dist = float(face_recognition.face_distance([db_enc], enc_np)[0])
            if dist <= max_distance:
                logger.debug(
                    "find_similar_unknown: matched person_id=%d dist=%.3f <= %.3f",
                    row["id"], dist, max_distance,
                )
                return int(row["id"])
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return None


def was_person_alerted_recently(person_id: int, camera_id: int, window_sec: float) -> bool:
    """
    Return True if person_id already has a non-dismissed alert on this camera
    within the last window_sec seconds.
    Primary dedup gate — person_id based, permanent in DB, works after bio_memory expires.
    """
    sql = """
        SELECT COUNT(*) AS cnt
        FROM alerts
        WHERE personId  = %s
          AND cameraId  = %s
          AND createdAt >= NOW() - INTERVAL %s SECOND
          AND status != 'dismissed'
    """
    with get_connection() as conn:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(sql, (person_id, camera_id, window_sec))
            row = cur.fetchone()
    return bool(row["cnt"] > 0) if row else False


def get_recent_alert_encodings(camera_id: int, window_sec: float) -> List[List[float]]:
    """
    Return ALL face encodings from recent alerts on this camera within window_sec.
    Encoding-based dedup fallback (covers race conditions where person_id not yet set).
    Replaces the LIMIT 1 version — now checks up to 20 recent alerts.
    """
    sql = """
        SELECT p.faceEncoding
        FROM alerts a
        JOIN persons p ON p.id = a.personId
        WHERE a.cameraId = %s
          AND a.createdAt >= NOW() - INTERVAL %s SECOND
          AND p.faceEncoding IS NOT NULL
        ORDER BY a.createdAt DESC
        LIMIT 20
    """
    with get_connection() as conn:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(sql, (camera_id, window_sec))
            rows = cur.fetchall()
    result = []
    for row in rows:
        try:
            enc = json.loads(row["faceEncoding"])
            if enc:
                result.append(enc)
        except (json.JSONDecodeError, TypeError):
            pass
    return result


def log_false_positive(camera_id: int, reason: str) -> None:
    """Record a deep-check rejection in the events table."""
    sql = """
        INSERT INTO events (cameraId, zoneId, alertId, confidence, eventType, payload, createdAt)
        VALUES (%s, 0, NULL, 0, 'false_positive', %s, %s)
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (
                camera_id,
                json.dumps({"type": "false_positive", "reason": reason}),
                datetime.datetime.utcnow(),
            ))
        conn.commit()
