import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCard } from "@/components/dashboard/AlertCard";
import { CameraCard } from "@/components/CameraCard";
import { LiveStreamModal } from "@/components/LiveStreamModal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { RefreshCw, AlertCircle, Filter, X } from "lucide-react";

export default function LiveAlertsFeed() {
  const [filterStatus,      setFilterStatus]      = useState<string>("all");
  const [filterZoneId,      setFilterZoneId]      = useState<string>("all");
  const [filterThreat,      setFilterThreat]      = useState<string>("all");
  const [selectedCameraId,  setSelectedCameraId]  = useState<number | null>(null);
  const [liveCamera,        setLiveCamera]        = useState<{ id: number; name: string } | null>(null);
  const [autoRefresh,       setAutoRefresh]       = useState(true);

  const { data: alerts, isLoading, error, refetch } = trpc.alerts.list.useQuery(
    {
      limit:       100,
      status:      filterStatus !== "all" ? filterStatus     : undefined,
      zoneId:      filterZoneId !== "all" ? parseInt(filterZoneId) : undefined,
      threatLevel: filterThreat !== "all" ? filterThreat     : undefined,
      cameraId:    selectedCameraId ?? undefined,
    },
    { refetchInterval: autoRefresh ? 5000 : false }
  );

  const { data: zonesList }    = trpc.zones.list.useQuery();
  const { data: camerasList }  = trpc.cameras.list.useQuery();
  const { data: cameraSummary, isLoading: camsLoading } = trpc.cameras.alertsSummary.useQuery(
    undefined,
    { refetchInterval: autoRefresh ? 10000 : false }
  );

  const getCameraName = (id: number) => camerasList?.find((c: any) => c.id === id)?.name ?? `CAM #${id}`;
  const getZoneName   = (id: number) => zonesList?.find((z: any) => z.id === id)?.name ?? `ZONE #${id}`;

  const hasFilters = filterStatus !== "all" || filterZoneId !== "all" || filterThreat !== "all" || selectedCameraId !== null;

  function resetFilters() {
    setFilterStatus("all");
    setFilterZoneId("all");
    setFilterThreat("all");
    setSelectedCameraId(null);
  }

  function toggleCamera(camId: number) {
    setSelectedCameraId(prev => prev === camId ? null : camId);
  }

  return (
    <div className="space-y-5 p-6 bg-[#0D1117] min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#E2E8F0] font-mono tracking-tight">LIVE ALERTS</h1>
          <p className="text-[11px] font-mono text-[#64748B] mt-0.5">
            {isLoading ? "loading…" : error ? "query error" : `${alerts?.length ?? 0} alerts${selectedCameraId ? ` · cam filter active` : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className={`px-3 py-1.5 rounded text-[10px] font-mono font-bold transition-colors border ${
              autoRefresh
                ? "bg-[#00F5FF] text-[#0D1117] border-[#00F5FF]"
                : "bg-transparent text-[#64748B] border-[#1E293B] hover:border-[#64748B]"
            }`}
          >
            <RefreshCw className={`inline w-3 h-3 mr-1.5 ${autoRefresh ? "animate-spin" : ""}`} />
            AUTO
          </button>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="h-8 gap-1.5 border-[#1E293B] bg-transparent text-[#64748B] hover:text-[#E2E8F0] text-[10px] font-mono">
            <RefreshCw className="w-3 h-3" /> REFRESH
          </Button>
        </div>
      </div>

      {/* Camera cards grid */}
      <div>
        <p className="text-[9px] font-mono uppercase tracking-widest text-[#64748B] mb-2">
          Cameras — click to filter · hover for LIVE
        </p>
        {camsLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="aspect-video w-full rounded-xl bg-[#1E293B]" />
                <Skeleton className="h-3 w-3/4 bg-[#1E293B]" />
              </div>
            ))}
          </div>
        ) : cameraSummary && cameraSummary.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {cameraSummary.map((cam: any) => (
              <CameraCard
                key={cam.id}
                camera={cam}
                zoneName={getZoneName(cam.zoneId)}
                isSelected={selectedCameraId === cam.id}
                onClick={() => toggleCamera(cam.id)}
                onLive={() => setLiveCamera({ id: cam.id, name: cam.name })}
              />
            ))}
          </div>
        ) : null}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-4 p-4 rounded-xl border border-[#1E293B] bg-[#080D14]">
        <div className="flex items-center gap-2 text-[#64748B] mr-1">
          <Filter className="w-3.5 h-3.5" />
          <span className="text-[10px] font-mono font-bold uppercase tracking-widest">Filters</span>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[9px] uppercase font-bold text-[#64748B] font-mono">Status</Label>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[140px] h-8 bg-[#1E293B] border-[#2D3748] text-[11px] font-mono text-[#E2E8F0]">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="acknowledged">Acknowledged</SelectItem>
              <SelectItem value="escalated">Escalated</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[9px] uppercase font-bold text-[#64748B] font-mono">Threat</Label>
          <Select value={filterThreat} onValueChange={setFilterThreat}>
            <SelectTrigger className="w-[130px] h-8 bg-[#1E293B] border-[#2D3748] text-[11px] font-mono text-[#E2E8F0]">
              <SelectValue placeholder="All Threats" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Threats</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[9px] uppercase font-bold text-[#64748B] font-mono">Zone</Label>
          <Select value={filterZoneId} onValueChange={setFilterZoneId}>
            <SelectTrigger className="w-[150px] h-8 bg-[#1E293B] border-[#2D3748] text-[11px] font-mono text-[#E2E8F0]">
              <SelectValue placeholder="All Zones" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Zones</SelectItem>
              {zonesList?.map((z: any) => (
                <SelectItem key={z.id} value={String(z.id)}>{z.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedCameraId && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#06b6d4]/40 bg-[#06b6d4]/10 text-[10px] font-mono text-[#06b6d4]">
            {getCameraName(selectedCameraId)}
            <button onClick={() => setSelectedCameraId(null)} className="hover:text-white">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={resetFilters}
            className="h-8 px-3 text-[#64748B] hover:text-[#E2E8F0] text-[10px] font-mono gap-1.5">
            <X className="w-3 h-3" /> Reset all
          </Button>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-[11px] font-mono">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          Query error: {error.message}
        </div>
      )}

      {/* Alerts grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-video w-full rounded-xl bg-[#1E293B]" />
              <Skeleton className="h-3 w-3/4 bg-[#1E293B]" />
              <Skeleton className="h-3 w-1/2 bg-[#1E293B]" />
            </div>
          ))}
        </div>
      ) : !error && alerts && alerts.length > 0 ? (
        <AnimatePresence>
          <motion.div
            className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            {alerts.map((alert: any) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                cameraName={getCameraName(alert.cameraId)}
                zoneName={getZoneName(alert.zoneId)}
              />
            ))}
          </motion.div>
        </AnimatePresence>
      ) : !error ? (
        <div className="flex flex-col items-center justify-center py-20 text-[#475569]">
          <AlertCircle className="w-12 h-12 mb-4 opacity-20" />
          <p className="text-[12px] font-mono uppercase tracking-widest">No alerts found</p>
          <p className="text-[10px] font-mono mt-1 opacity-60">System is monitoring…</p>
        </div>
      ) : null}

      {/* Live stream modal */}
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
