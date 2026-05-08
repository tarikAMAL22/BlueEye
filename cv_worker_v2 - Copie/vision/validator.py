import face_recognition
import logging
import cv2
from ..config import MIN_LANDMARK_POINTS

logger = logging.getLogger("CV-Worker.Validator")

def is_real_face(face_image):
    """
    Performs a high-resolution secondary check on a cropped face image.
    Returns True if a clear face is confirmed, False otherwise.
    """
    if face_image is None or face_image.size == 0:
        return False

    # Convert to RGB for face_recognition
    rgb_face = cv2.cvtColor(face_image, cv2.COLOR_BGR2RGB)
    
    # 1. Detection Check: Can we find a face in this crop?
    face_locations = face_recognition.face_locations(rgb_face, model="hog")
    if not face_locations:
        logger.info("Deep Check Failed: No face detected in the cropped image.")
        return False
        
    # 2. Landmark Check: Does it have enough points in the crop?
    landmarks = face_recognition.face_landmarks(rgb_face, face_locations)
    if not landmarks:
        return False
        
    all_points = sum(len(p) for p in landmarks[0].values())
    if all_points < MIN_LANDMARK_POINTS:
        logger.info(f"Deep Check Failed: Crop has only {all_points} points.")
        return False

    # 3. Geometry Check: Must have eyes and nose
    required = ['left_eye', 'right_eye', 'nose_bridge']
    if not all(k in landmarks[0] for k in required):
        logger.info("Deep Check Failed: Missing critical facial organs in crop.")
        return False

    return True
