#!/bin/bash
pkill -f cv_worker.py
sleep 1
cd /workspace/BlueEye
export DB_HOST=127.0.0.1
export DB_PASSWORD=blueeye-secret-pw
export DB_USER=root
export DB_NAME=blueeye
nohup python3 cv_worker.py > /tmp/cv_worker.log 2>&1 &
echo "cv_worker started (PID $!)"
