import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { trpc } from "@/lib/trpc";
import { X, Loader2, WifiOff } from "lucide-react";

interface Props {
  cameraId: number;
  cameraName: string;
  onClose: () => void;
}

export function LiveStreamModal({ cameraId, cameraName, onClose }: Props) {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const hlsRef      = useRef<Hls | null>(null);
  const [status, setStatus] = useState<"loading" | "playing" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");

  const startMutation  = trpc.stream.start.useMutation();
  const stopMutation   = trpc.stream.stop.useMutation();

  useEffect(() => {
    let hlsUrl: string | null = null;
    let destroyed = false;

    async function init() {
      try {
        const res = await startMutation.mutateAsync({ cameraId });
        hlsUrl = res.hlsUrl;
        if (destroyed) return;

        // Wait a moment for FFmpeg to write the first segment
        await new Promise(r => setTimeout(r, 2000));
        if (destroyed) return;

        const video = videoRef.current;
        if (!video) return;

        if (Hls.isSupported()) {
          const hls = new Hls({ lowLatencyMode: true });
          hlsRef.current = hls;
          hls.loadSource(hlsUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => {});
            setStatus("playing");
          });
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) {
              setStatus("error");
              setErrMsg(data.type);
            }
          });
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = hlsUrl;
          video.play().catch(() => {});
          setStatus("playing");
        } else {
          setStatus("error");
          setErrMsg("HLS not supported in this browser");
        }
      } catch (e: any) {
        if (!destroyed) {
          setStatus("error");
          setErrMsg(e.message ?? "Failed to start stream");
        }
      }
    }

    init();

    return () => {
      destroyed = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      stopMutation.mutate({ cameraId });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl mx-4 rounded-2xl border border-[#1E293B] bg-[#080D14] overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1E293B]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#ec4899] animate-pulse" />
            <span className="text-[11px] font-mono font-bold text-[#E2E8F0] uppercase tracking-wider">
              LIVE · {cameraName}
            </span>
          </div>
          <button onClick={onClose} className="text-[#64748B] hover:text-[#E2E8F0] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Video area */}
        <div className="relative aspect-video bg-[#0D1117]">
          <video
            ref={videoRef}
            className="w-full h-full object-contain"
            muted
            playsInline
            autoPlay
          />

          {status === "loading" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[#64748B]">
              <Loader2 className="w-8 h-8 animate-spin text-[#06b6d4]" />
              <span className="text-[10px] font-mono uppercase">Starting stream…</span>
            </div>
          )}

          {status === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-red-400">
              <WifiOff className="w-8 h-8" />
              <span className="text-[10px] font-mono uppercase">Stream error</span>
              <span className="text-[9px] font-mono text-[#64748B]">{errMsg}</span>
            </div>
          )}

          {/* Overlay badge */}
          {status === "playing" && (
            <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-[#ec4899]/80 px-2 py-0.5 rounded text-[9px] font-mono font-bold text-white">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              LIVE
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
