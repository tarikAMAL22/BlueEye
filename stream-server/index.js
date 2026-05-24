const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

const PORT       = parseInt(process.env.PORT || '4253');
const HLS_DIR    = process.env.HLS_DIR || '/tmp/hls';
const IDLE_MS    = parseInt(process.env.IDLE_TIMEOUT_MS || '60000');
const DB_HOST    = process.env.DB_HOST     || 'localhost';
const DB_USER    = process.env.DB_USER     || 'root';
const DB_PASS    = process.env.DB_PASSWORD || 'my-secret-pw';
const DB_NAME    = process.env.DB_NAME     || 'blueeye';

fs.mkdirSync(HLS_DIR, { recursive: true });

// activeStreams: cameraId -> { proc, timer, hlsUrl }
const activeStreams = new Map();

async function getRtspUrl(cameraId) {
  const conn = await mysql.createConnection({
    host: DB_HOST, user: DB_USER, password: DB_PASS, database: DB_NAME,
  });
  const [rows] = await conn.execute('SELECT rtspUrl FROM cameras WHERE id = ?', [cameraId]);
  await conn.end();
  if (!rows.length) throw new Error(`Camera ${cameraId} not found`);
  return rows[0].rtspUrl;
}

function hlsPath(cameraId) {
  return path.join(HLS_DIR, `cam_${cameraId}`);
}

function startFfmpeg(cameraId, rtspUrl) {
  const dir = hlsPath(cameraId);
  fs.mkdirSync(dir, { recursive: true });

  const isFile = !rtspUrl.startsWith('rtsp://') && !rtspUrl.startsWith('rtmp://');
  const inputArgs = isFile
    ? ['-re', '-stream_loop', '-1', '-i', rtspUrl]
    : ['-rtsp_transport', 'tcp', '-i', rtspUrl];

  const args = [
    ...inputArgs,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-g', '25',
    '-sc_threshold', '0',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+append_list',
    path.join(dir, 'stream.m3u8'),
  ];

  const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
  proc.on('error', (err) => console.error(`[stream-server] ffmpeg cam ${cameraId} error:`, err.message));
  proc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.warn(`[stream-server] ffmpeg cam ${cameraId} exited code=${code}`);
    }
    activeStreams.delete(cameraId);
  });
  return proc;
}

function resetIdleTimer(cameraId) {
  const s = activeStreams.get(cameraId);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    console.log(`[stream-server] idle timeout cam ${cameraId}`);
    stopStream(cameraId);
  }, IDLE_MS);
}

function stopStream(cameraId) {
  const s = activeStreams.get(cameraId);
  if (!s) return;
  clearTimeout(s.timer);
  s.proc.kill('SIGTERM');
  activeStreams.delete(cameraId);
  // clean up hls files
  const dir = hlsPath(cameraId);
  fs.rmSync(dir, { recursive: true, force: true });
}

// POST /stream/start/:cameraId
app.post('/stream/start/:cameraId', async (req, res) => {
  const cameraId = parseInt(req.params.cameraId);
  if (isNaN(cameraId)) return res.status(400).json({ error: 'invalid cameraId' });

  if (activeStreams.has(cameraId)) {
    resetIdleTimer(cameraId);
    const s = activeStreams.get(cameraId);
    return res.json({ status: 'already_running', hlsUrl: s.hlsUrl });
  }

  try {
    const rtspUrl = await getRtspUrl(cameraId);
    const proc = startFfmpeg(cameraId, rtspUrl);
    const hlsUrl = `/hls/cam_${cameraId}/stream.m3u8`;
    const timer = setTimeout(() => stopStream(cameraId), IDLE_MS);
    activeStreams.set(cameraId, { proc, timer, hlsUrl });
    console.log(`[stream-server] started cam ${cameraId} → ${rtspUrl}`);
    res.json({ status: 'started', hlsUrl });
  } catch (err) {
    console.error(`[stream-server] start error cam ${cameraId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /stream/status/:cameraId
app.get('/stream/status/:cameraId', (req, res) => {
  const cameraId = parseInt(req.params.cameraId);
  const s = activeStreams.get(cameraId);
  if (s) {
    resetIdleTimer(cameraId);
    res.json({ active: true, hlsUrl: s.hlsUrl });
  } else {
    res.json({ active: false, hlsUrl: null });
  }
});

// DELETE /stream/stop/:cameraId
app.delete('/stream/stop/:cameraId', (req, res) => {
  const cameraId = parseInt(req.params.cameraId);
  stopStream(cameraId);
  res.json({ stopped: true });
});

// Serve HLS segments
app.use('/hls', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}, express.static(HLS_DIR));

app.get('/health', (_, res) => res.json({ ok: true, streams: activeStreams.size }));

app.listen(PORT, () => console.log(`[stream-server] listening on :${PORT}`));
