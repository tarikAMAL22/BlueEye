import { trpc } from "@/lib/trpc";

interface Props {
  selectedZoneId: number | null;
  onZoneSelect: (id: number) => void;
}

const THREAT_COLORS: Record<string, string> = {
  critical: "#DC2626",
  high: "#EF4444",
  medium: "#F59E0B",
  low: "#10B981",
};

export function ZoneStatus({ selectedZoneId, onZoneSelect }: Props) {
  const { data: zones } = trpc.dashboard.zoneStatus.useQuery(undefined, {
    refetchInterval: 15000,
  });

  if (!zones || zones.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#64748B] text-[10px] font-mono">
        NO ZONES CONFIGURED
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto min-h-0">
      <div className="px-4 py-2 text-[9px] font-mono font-bold text-[#64748B] tracking-widest border-b border-[#1E293B] flex-shrink-0">
        ZONES — {zones.length} TOTAL
      </div>
      {zones.map((zone) => {
        const color = THREAT_COLORS[zone.threatLevel ?? "low"] ?? "#10B981";
        const isCritical = zone.threatLevel === "critical";
        const isSelected = selectedZoneId === zone.id;
        const maxAlerts = Math.max(...zones.map((z) => z.activeAlerts ?? 0), 1);
        const barWidth = Math.round(((zone.activeAlerts ?? 0) / maxAlerts) * 100);

        return (
          <button
            key={zone.id}
            onClick={() => onZoneSelect(zone.id)}
            className={`w-full text-left px-4 py-2.5 border-b border-[#1E293B] hover:bg-[#0F172A] transition-colors ${
              isSelected ? "bg-[#0F172A] border-l-2" : ""
            }`}
            style={isSelected ? { borderLeftColor: color } : undefined}
          >
            <div className="flex items-center gap-2 mb-1">
              <div
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  isCritical ? "animate-pulse" : ""
                }`}
                style={{ background: color }}
              />
              <span className="text-[11px] font-mono text-[#E2E8F0] truncate flex-1">
                {zone.name}
              </span>
              <span
                className="text-[9px] font-mono font-bold flex-shrink-0"
                style={{ color }}
              >
                {zone.activeAlerts ?? 0}▲
              </span>
            </div>

            {/* Alert bar */}
            {(zone.activeAlerts ?? 0) > 0 && (
              <div className="w-full h-0.5 bg-[#1E293B] rounded-full overflow-hidden mb-1">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${barWidth}%`, background: color }}
                />
              </div>
            )}

            <div className="text-[9px] font-mono text-[#64748B]">
              {zone.cameraCount ?? 0} cam
              {(zone.cameraCount ?? 0) !== 1 ? "s" : ""} ·{" "}
              {(zone.threatLevel ?? "low").toUpperCase()}
            </div>
          </button>
        );
      })}
    </div>
  );
}
