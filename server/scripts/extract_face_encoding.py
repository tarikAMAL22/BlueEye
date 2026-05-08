import sys
import json
import face_recognition
import cv2
import os

def extract(image_path):
    if not os.path.exists(image_path):
        return {"error": "File not found"}
        
    try:
        image = cv2.imread(image_path)
        if image is None:
            return {"error": "Could not read image"}
            
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        encodings = face_recognition.face_encodings(rgb_image)
        
        if not encodings:
            return {"error": "No face detected"}
            
        return {"encoding": encodings[0].tolist()}
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No path provided"}))
        sys.exit(1)
        
    result = extract(sys.argv[1])
    print(json.dumps(result))
