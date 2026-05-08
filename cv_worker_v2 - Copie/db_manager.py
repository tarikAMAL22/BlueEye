import mysql.connector
import time
import logging
from .config import DB_HOST, DB_USER, DB_PASSWORD, DB_NAME

logger = logging.getLogger("CV-Worker.DB")

def get_db_connection():
    while True:
        try:
            return mysql.connector.connect(
                host=DB_HOST,
                user=DB_USER,
                password=DB_PASSWORD,
                database=DB_NAME
            )
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            time.sleep(5)

def update_camera_status(cursor, conn, cam_id, status):
    try:
        if status == 'online':
            cursor.execute("UPDATE cameras SET status = 'online', lastSeen = NOW() WHERE id = %s", (cam_id,))
        else:
            cursor.execute("UPDATE cameras SET status = 'offline' WHERE id = %s", (cam_id,))
        conn.commit()
    except Exception as e:
        logger.error(f"Failed to update camera status: {e}")
