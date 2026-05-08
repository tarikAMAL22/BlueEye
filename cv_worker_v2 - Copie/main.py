import threading
import time
import logging
from .config import *
from .db_manager import get_db_connection
from .face_engine import FaceMatcher, BiometricMemory
from .processor import process_camera, stop_signals
from .api_server import create_app

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("CV-Worker.Main")

def main():
    logger.info("Starting BlueEye CV Worker v2 (Modular)...")
    
    # Initialize Core Engines
    matcher = FaceMatcher()
    biometric_memory = BiometricMemory()
    
    # State shared across camera threads
    last_alert_times = {}
    pending_alerts = {}
    active_threads = {}
    
    # Start API Server in background
    app = create_app(matcher)
    api_thread = threading.Thread(target=lambda: app.run(host='0.0.0.0', port=5000), daemon=True)
    api_thread.start()
    logger.info("API Server started on port 5000.")

    while True:
        try:
            # Sync identities
            matcher.load()
            
            # Fetch active cameras
            conn = get_db_connection()
            cursor = conn.cursor(dictionary=True)
            cursor.execute("SELECT * FROM cameras WHERE status != 'deleted'")
            cams = cursor.fetchall()
            cursor.close()
            conn.close()
            
            current_cam_ids = set()
            for cam in cams:
                cid = cam['id']
                current_cam_ids.add(cid)
                
                # Start new threads for new/crashed cameras
                if cid not in active_threads or not active_threads[cid].is_alive():
                    logger.info(f"Starting thread for camera: {cam.get('name')}")
                    t = threading.Thread(
                        target=process_camera, 
                        args=(cam, matcher, biometric_memory, last_alert_times, pending_alerts), 
                        daemon=True
                    )
                    t.start()
                    active_threads[cid] = t
            
            # Cleanup inactive cameras
            for cid in list(active_threads.keys()):
                if cid not in current_cam_ids:
                    logger.info(f"Camera {cid} removed. Stopping thread...")
                    stop_signals[cid] = True
                    if not active_threads[cid].is_alive():
                        del active_threads[cid]
                        if cid in stop_signals: del stop_signals[cid]
                        
        except Exception as e:
            logger.error(f"Main Loop Error: {e}")
            
        time.sleep(10)

if __name__ == "__main__":
    main()
