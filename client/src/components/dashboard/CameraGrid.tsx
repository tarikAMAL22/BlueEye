import { useRef, useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Video } from "lucide-react";
import { LiveStreamModal } from "@/components/LiveStreamModal";

export function CameraGrid() {
  const [liveCamera, setLiveCamera] = useState<{ id: number; name: string } | null>(null);
  const [flashingCams, setFlashingCams] = useState<Set<number>>(new Set());
  const prevCounts = useRef<Record<number, number>>({});
  const isFirstLoad = useRef(true);

  const { data: cameras } = trpc.cameras.alertsSummary.useQuery(undefined, {
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (!cameras) return;
    if (isFirstLoad.current) {
      for (const cam of cameras) prevCounts.current[cam.id] = cam.openAlerts;
      isFirstLoad.current = false;
      return;
    }
    const newFlashing = new Set<number>();
    for (const cam of cameras) {
      const prev = prevCounts.current[cam.id] ?? 0;
      if (cam.openAlerts > prev) newFlashing.add(cam.id);
      prevCounts.current[cam.id] = cam.openAlerts;
    }
    if (newFlashing.size > 0) {
      setFlashingCams(prev => new Set([...prev, ...newFlashing]));
      setTimeout(() => {
        setFlashingCams(prev => {
          const next = new Set(prev);
          newFlashing.forEach(id => next.delete(id));
          return next;
        });
      }, 2000);
    }
  }, [cameras]);

  if (!cameras || cameras.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-[#64748B] text-[10px] font-mono border-b border-[#1E293B]">
        NO CAMERAS
      </div>
    );
  }

  const onlineCount = cameras.filter(c => c.status === "online").length;

  return (
    <div className="flex-shrink-0 border-b border-[#1E293B]">
      <div className="px-3 py-2 text-[9px] font-mono font-bold text-[#64748B] tracking-widest border-b border-[#1E293B]">
        CAMERAS — {onlineCount}/{cameras.length} ONLINE
      </div>
      <div className="grid grid-cols-3 gap-1.5 p-2">
        {cameras.map((cam) => {
          const isFlashing = flashingCams.has(cam.id);
          const openAlerts = cam.openAlerts ?? 0;
          return (
            <div
              key={cam.id}
              className={`rounded border overflow-hidden relative transition-all duration-200 ${
                isFlashing
                  ? "border-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] scale-[1.03]"
                  : "border-[#1E293B]"
              }`}
            >
              <div className="aspect-video bg-[#0A0F1A] relative overflow-hidden">
                {cam.lastSnapshot ? (
                  <img
                    src={cam.lastSnapshot}
                    alt={cam.name}
                    className="w-full h-full object-cover opacity-80"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Video className="w-4 h-4 text-[#2D3748]" />
                  </div>
                )}

                {/* Status dot */}
                <div className="absolute top-1 left-1">
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    cam.status === "online" ? "bg-emerald-400 animate-pulse" :
                    cam.status === "maintenance" ? "bg-amber-400" : "bg-red-400"
                  }`} />
                </div>

                {/* Open alerts badge */}
                <div className={`absolute top-1 right-1 px-1 py-0.5 rounded text-[7px] font-mono font-bold text-white ${
                  openAlerts > 0 ? "bg-red-500/90 animate-pulse" : "bg-emerald-600/80"
                }`}>
                  {openAlerts}
                </div>

                {/* LIVE button — always visible */}
                <button
                  onClick={() => setLiveCamera({ id: cam.id, name: cam.name })}
                  className="absolute bottom-1 right-1 flex items-center gap-0.5 px-1.5 py-0.5 rounded
                    bg-[#ec4899]/80 hover:bg-[#ec4899] text-white text-[7px] font-mono font-bold"
                >
                  <span className="w-1 h-1 rounded-full bg-white animate-pulse inline-block" />
                  LIVE
                </button>
              </div>

              <div className="px-1.5 py-1 border-t border-[#1E293B] bg-[#0D1117]">
                <div className="text-[8px] font-mono text-[#E2E8F0] truncate leading-none">{cam.name}</div>
                {cam.location && (
                  <div className="text-[7px] font-mono text-[#64748B] truncate leading-none mt-0.5">{cam.location}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {liveCamera && (
        <LiveStreamModal
          cameraId={liveCamera.id}
          cameraName={liveCamera.name}
          onClose={() => setLiveCamera(null)}
        />
      )}
    </div>
  );
}
