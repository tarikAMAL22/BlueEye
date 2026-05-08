import { useEffect, useRef, useState } from "react";

interface HlsPlayerProps {
  streamUrl: string; // Full HLS URL e.g. http://localhost:8888/stream1/index.m3u8
  className?: string;
  autoPlay?: boolean;
  muted?: boolean;
}

declare global {
  interface Window {
    Hls: any;
  }
}

let hlsScriptLoaded = false;
let hlsScriptLoading = false;
const hlsCallbacks: Array<() => void> = [];

function loadHlsScript(callback: () => void) {
  if (hlsScriptLoaded) {
    callback();
    return;
  }
  hlsCallbacks.push(callback);
  if (hlsScriptLoading) return;
  hlsScriptLoading = true;
  const script = document.createElement("script");
  script.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js";
  script.onload = () => {
    hlsScriptLoaded = true;
    hlsCallbacks.forEach((cb) => cb());
    hlsCallbacks.length = 0;
  };
  document.head.appendChild(script);
}

export function HlsPlayer({ streamUrl, className = "", autoPlay = true, muted = true }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let destroyed = false;

    const initPlayer = () => {
      if (destroyed || !videoRef.current) return;
      const video = videoRef.current;
      setError(null);
      setLoading(true);

      // Destroy previous hls instance
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      const Hls = window.Hls;

      if (Hls && Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 90,
        });
        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!destroyed) {
            setLoading(false);
            if (autoPlay) video.play().catch(() => {});
          }
        });
        hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
          if (!destroyed && data.fatal) {
            setLoading(false);
            setError("Stream unavailable");
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari native HLS
        video.src = streamUrl;
        video.addEventListener("loadedmetadata", () => {
          if (!destroyed) {
            setLoading(false);
            if (autoPlay) video.play().catch(() => {});
          }
        });
        video.addEventListener("error", () => {
          if (!destroyed) {
            setLoading(false);
            setError("Stream unavailable");
          }
        });
      } else {
        setLoading(false);
        setError("HLS not supported in this browser");
      }
    };

    loadHlsScript(initPlayer);

    return () => {
      destroyed = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [streamUrl, autoPlay]);

  return (
    <div className={`relative w-full h-full bg-black ${className}`}>
      <video
        ref={videoRef}
        className="w-full h-full object-cover"
        muted={muted}
        playsInline
        controls={false}
      />
      {loading && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-2" />
          <span className="text-xs text-muted-foreground font-mono">Connecting to stream...</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 gap-2">
          <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
            <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19H19a2 2 0 001.75-2.96L13.75 4a2 2 0 00-3.5 0L3.25 16.04A2 2 0 005.07 19z" />
            </svg>
          </div>
          <span className="text-xs text-red-400 font-mono">{error}</span>
        </div>
      )}
    </div>
  );
}
