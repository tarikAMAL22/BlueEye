def process_camera(cam, matcher):
    cam_id = cam['id']
    backend_url = cam['backendUrl']
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Initialize state
    last_alert_times = {} # (cam_id, person_id/tracking_id): timestamp
    pending_alerts = {} # (cam_id, tracking_id): {data}
    frame_count = 0
    process_every_n_frames = 2 
    
    cap = None
    retry_count = 0
    max_retries = 5
    
    try:
        while True:
            # Reconnect logic
            if cap is None or not cap.isOpened():
                logger.info(f"Connecting to camera {cam['name']} at {backend_url}...")
                cap = cv2.VideoCapture(backend_url)
                if not cap.isOpened():
                    retry_count += 1
                    logger.warning(f"Failed to open camera {cam['name']} (Attempt {retry_count}/{max_retries})")
                    if retry_count >= max_retries:
                        break
                    time.sleep(5)
                    continue
                else:
                    retry_count = 0
                    try:
                        cursor.execute("UPDATE cameras SET status = 'online', lastSeen = NOW() WHERE id = %s", (cam_id,))
                        conn.commit()
                    except: pass

            ret, frame = cap.read()
            if not ret:
                retry_count += 1
                logger.warning(f"Camera {cam['name']} read failed (Attempt {retry_count}/{max_retries}). Retrying...")
                cap.release()
                cap = None
                if retry_count >= max_retries:
                    break
                time.sleep(2)
                continue
                
            retry_count = 0 
                
            if stop_signals.get(cam_id):
                logger.info(f"Stop signal received for camera {cam['name']}. Exiting...")
                break

            frame_count += 1
            if frame_count % 100 == 0:
                logger.info(f"Camera {cam['name']}: Processed {frame_count} frames...")
            if frame_count % process_every_n_frames != 0:
                continue
                
            # Resize frame for stable detection
            small_frame = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
            rgb_small_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
            
            start_time = time.time()
            with cv_lock:
                face_locations = face_recognition.face_locations(rgb_small_frame)
            
            if face_locations:
                if len(face_locations) > 10:
                    logger.warning(f"Camera {cam['name']}: Too many faces detected ({len(face_locations)}). Likely noise, skipping frame.")
                    continue
                process_time = time.time() - start_time
                logger.info(f"Camera {cam['name']}: Detected {len(face_locations)} faces in {process_time:.3f}s")
            else:
                # Still check pending alerts even if no faces detected in this frame
                pass
                
            if face_locations:
                with face_lock:
                    face_encodings = face_recognition.face_encodings(rgb_small_frame, face_locations)
                    all_landmarks = face_recognition.face_landmarks(rgb_small_frame, face_locations)

                for (top, right, bottom, left), face_encoding, landmarks in zip(face_locations, face_encodings, all_landmarks):
                    # Validation: Core facial features
                    required_features = ['left_eye', 'right_eye', 'nose_bridge']
                    if not landmarks or not all(feat in landmarks for feat in required_features):
                        continue
                    
                    face_height = bottom - top
                    if face_height < 20: 
                        continue
                        
                    # Scale back up
                    top, right, bottom, left = top * 2, right * 2, bottom * 2, left * 2
                    
                    h, w = frame.shape[:2]
                    pad_h = int((bottom - top) * 0.3)
                    pad_w = int((right - left) * 0.3)
                    
                    s_top = max(0, top - pad_h)
                    s_bottom = min(h, bottom + int(pad_h * 1.2))
                    s_left = max(0, left - pad_w)
                    s_right = min(w, right + pad_w)
                    
                    face_image = frame[s_top:s_bottom, s_left:s_right]
                    
                    if face_image.size == 0:
                        continue
                    
                    std_dev = np.std(face_image)
                    avg_brightness = np.mean(face_image)
                    if std_dev < 15 or avg_brightness > 240 or avg_brightness < 10:
                        continue

                    if face_image.shape[0] < 512 or face_image.shape[1] < 512:
                        face_image = cv2.resize(face_image, (512, 512), interpolation=cv2.INTER_LANCZOS4)
                    
                    person_id, confidence, role = matcher.match(face_encoding)
                    
                    pos_bucket = f"{top//150}_{left//150}" 
                    tracking_id = person_id if person_id else f"unknown_{pos_bucket}"
                    pending_key = (cam_id, tracking_id)
                    
                    now = time.time()
                    if pending_key in last_alert_times and (now - last_alert_times[pending_key]) < ALERT_COOLDOWN_SECONDS:
                        continue
                        
                    face_size = (bottom - top) * (right - left)
                    
                    if pending_key not in pending_alerts:
                        pending_alerts[pending_key] = {
                            'start_time': now,
                            'best_size': face_size,
                            'face_image': face_image,
                            'full_frame': frame.copy(),
                            'face_encoding': face_encoding,
                            'person_id': person_id,
                            'confidence': confidence,
                            'role': role
                        }
                    else:
                        if face_size > pending_alerts[pending_key]['best_size']:
                            pending_alerts[pending_key].update({
                                'best_size': face_size,
                                'face_image': face_image,
                                'full_frame': frame.copy(),
                                'face_encoding': face_encoding,
                                'confidence': confidence
                            })

            # Process pending alerts that finished window
            now = time.time()
            for p_key in list(pending_alerts.keys()):
                if now - pending_alerts[p_key]['start_time'] >= 1.5:
                    try:
                        process_final_alert(cam, pending_alerts[p_key], cursor, conn)
                        last_alert_times[p_key] = now
                    except Exception as e:
                        logger.error(f"Error finalized: {e}")
                    finally:
                        del pending_alerts[p_key]
                    
    except Exception as e:
        logger.error(f"Error processing camera {cam['name']}: {e}")
    finally:
        if cap: cap.release()
        try:
            cursor.execute("UPDATE cameras SET status = 'offline' WHERE id = %s", (cam_id,))
            conn.commit()
        except: pass
        cursor.close()
        conn.close()
