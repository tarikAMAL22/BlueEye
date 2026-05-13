import { trpc } from "@/lib/trpc";
import { Camera, Wrench, WifiOff } from "lucide-react";

const STATUS_COLOR: Record<string, string> = {
  online: "#22C55E",
  offline: "#EF4444",
  maintenance: "#F59E0B",
};

export function CameraGrid() {
  const { data: cameras } = trpc.cameras.list.useQuery(undefined, {
    refetchInterval: 20000,
  });
  const { data: activeAlerts } = trpc.alerts.list.useQuery(
    { limit: 200, status: "active" },
    { refetchInterval: 10000 }
  );

  const alertCountByCamera = (activeAlerts ?? []).reduce<Record<number, number>>(
    (acc, alert) => {
      if (alert.cameraId) acc[alert.cameraId] = (acc[alert.cameraId] ?? 0) + 1;
      return acc;
    },
    {}
  );

  if (!cameras || cameras.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-[#64748B] text-[10px] font-mono border-b border-[#1E293B]">
        NO CAMERAS
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 border-b border-[#1E293B]">
      <div className="px-3 py-2 text-[9px] font-mono font-bold text-[#64748B] tracking-widest border-b border-[#1E293B]">
        CAMERAS — {cameras.filter((c) => c.status === "online").length}/{cameras.length} ONLINE
      </div>
      <div className="grid grid-cols-2 gap-1.5 p-2">
        {cameras.map((cam) => {
          const color = STATUS_COLOR[cam.status ?? "offline"] ?? "#EF4444";
          const alertCount = alertCountByCamera[cam.id] ?? 0;
          const StatusIcon =
            cam.status === "maintenance"
              ? Wrench
              : cam.status === "offline"
              ? WifiOff
              : Camera;

          return (
            <div
              key={cam.id}
              className="rounded border border-[#1E293B] bg-[#0D1117] overflow-hidden relative"
            >
              {/* Preview placeholder */}
              <div className="h-16 bg-[#0A0F1A] flex items-center justify-center">
                <StatusIcon className="w-5 h-5" style={{ color }} />
              </div>

              {/* Alert badge */}
              {alertCount > 0 && (
                <div className="absolute top-1 right-1 bg-red-500 text-white text-[8px] font-bold font-mono rounded px-1 leading-4 animate-pulse">
                  {alertCount}
                </div>
              )}

              {/* Status dot */}
              <div className="absolute top-1 left-1">
                <div
                  className={`w-2 h-2 rounded-full ${cam.status === "online" ? "animate-pulse" : ""}`}
                  style={{ background: color }}
                />
              </div>

              {/* Label */}
              <div className="px-1.5 py-1 border-t border-[#1E293B]">
                <div className="text-[9px] font-mono text-[#E2E8F0] truncate leading-none">
                  {cam.name}
                </div>
                {cam.location && (
                  <div className="text-[8px] font-mono text-[#64748B] truncate leading-none mt-0.5">
                    {cam.location}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
