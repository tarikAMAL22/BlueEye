import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { trpc } from "@/lib/trpc";
import { Switch } from "@/components/ui/switch";
import { X, RefreshCw } from "lucide-react";
import { AlertCard } from "./AlertCard";
import { HourlyChart } from "./HourlyChart";


interface Props {
  selectedZoneId: number | null;
  onClearZone: () => void;
}

type Filter = "all" | "high" | "unknown" | "noface";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "ALL" },
  { key: "high", label: "HIGH+" },
  { key: "unknown", label: "UNKNOWN" },
  { key: "noface", label: "NO FACE" },
];

export function LiveAlertsFeed({ selectedZoneId, onClearZone }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [sortDesc, setSortDesc] = useState(true);

  const queryInput: Record<string, unknown> = {
    limit: 60,
  };
  // "all" shows every status; other filters stay scoped to active alerts
  if (filter !== "all") queryInput.status = "active";
  if (selectedZoneId) queryInput.zoneId = selectedZoneId;
  if (filter === "high") queryInput.threatLevel = "high";
  if (filter === "noface") queryInput.detectionType = "NO_FACE";

  const { data: alerts, isLoading } = trpc.alerts.list.useQuery(queryInput as any, {
    refetchInterval: autoRefresh ? 5000 : false,
  });
  const { data: camerasList } = trpc.cameras.list.useQuery();
  const { data: zonesList }   = trpc.zones.list.useQuery();

  const getCameraName = (id: number) => camerasList?.find((c: any) => c.id === id)?.name ?? `CAM #${id}`;
  const getZoneName   = (id: number) => zonesList?.find((z: any) => z.id === id)?.name ?? `ZONE #${id}`;

  let displayed = alerts ?? [];

  if (filter === "unknown") {
    displayed = displayed.filter((a) => !a.personId || (a as any).person?.role === "UNKNOWN");
  }

  if (!sortDesc) {
    displayed = [...displayed].reverse();
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1E293B] flex-shrink-0 flex-wrap">
        {/* Filter pills */}
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold transition-colors ${
                filter === f.key
                  ? "bg-[#00F5FF] text-[#0D1117]"
                  : "bg-[#1E293B] text-[#64748B] hover:text-[#E2E8F0]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Zone breadcrumb */}
        {selectedZoneId && (
          <button
            onClick={onClearZone}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#1E293B] text-[#00F5FF] text-[9px] font-mono hover:bg-[#263548] transition-colors"
          >
            <span>ZONE #{selectedZoneId}</span>
            <X className="w-2.5 h-2.5" />
          </button>
        )}

        {/* Sort toggle */}
        <button
          onClick={() => setSortDesc(!sortDesc)}
          className="p-1 rounded hover:bg-[#1E293B] text-[#64748B] hover:text-[#E2E8F0] transition-colors"
          title={sortDesc ? "Newest first" : "Oldest first"}
        >
          <RefreshCw className="w-3 h-3" />
        </button>

        {/* Auto-refresh toggle */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono text-[#64748B]">AUTO</span>
          <Switch
            checked={autoRefresh}
            onCheckedChange={setAutoRefresh}
            className="h-4 w-7 data-[state=checked]:bg-[#00F5FF]"
          />
        </div>

        <span className="text-[9px] font-mono text-[#64748B] tabular-nums">
          {isLoading ? "…" : `${displayed.length}`}
        </span>
      </div>

      {/* Alert grid */}
      <div className="flex-1 overflow-y-auto px-3 pt-2 pb-2 min-h-0">
        {isLoading && displayed.length === 0 && (
          <div className="flex items-center justify-center h-24 text-[#64748B] text-[10px] font-mono">
            LOADING…
          </div>
        )}
        {!isLoading && displayed.length === 0 && (
          <div className="flex items-center justify-center h-24 text-[#64748B] text-[10px] font-mono">
            NO ALERTS
          </div>
        )}
        <AnimatePresence initial={false}>
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
            {displayed.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert as any}
                cameraName={getCameraName((alert as any).cameraId)}
                zoneName={getZoneName((alert as any).zoneId)}
              />
            ))}
          </div>
        </AnimatePresence>
      </div>

      {/* Hourly chart pinned at bottom */}
      <div className="border-t border-[#1E293B] flex-shrink-0">
        <HourlyChart />
      </div>
    </div>
  );
}
