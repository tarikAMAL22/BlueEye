import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Eye } from "lucide-react";

function formatTime(d: Date) {
  return d.toLocaleTimeString("fr-FR", { hour12: false });
}

export function TopBar() {
  const [time, setTime] = useState(() => formatTime(new Date()));
  const { user } = useAuth();

  const { data: status } = trpc.dashboard.systemStatus.useQuery(undefined, {
    refetchInterval: 10000,
  });

  useEffect(() => {
    const timer = setInterval(() => setTime(formatTime(new Date())), 1000);
    return () => clearInterval(timer);
  }, []);

  const systemOnline = status
    ? status.cvWorkerAlive || status.camerasOnline > 0
    : false;

  return (
    <div className="flex items-center gap-3 px-4 border-b border-[#1E293B] bg-[#0D1117] h-12 flex-shrink-0 font-mono text-[11px]">
      {/* Logo + clock */}
      <div className="flex items-center gap-2 text-[#00F5FF] shrink-0">
        <Eye className="w-4 h-4" />
        <span className="font-bold tracking-widest">BLUEEYE</span>
        <span className="text-[#64748B] ml-1 tabular-nums">{time}</span>
      </div>

      <Sep />

      {/* System status */}
      <div className="flex items-center gap-1.5 shrink-0">
        <div
          className={`w-2 h-2 rounded-full ${
            systemOnline ? "bg-green-400 animate-pulse" : "bg-orange-400"
          }`}
        />
        <span className={systemOnline ? "text-green-400" : "text-orange-400"}>
          {systemOnline ? "SYSTEM ONLINE" : "DEGRADED"}
        </span>
      </div>

      <Sep />

      {/* CV Worker */}
      <div className="shrink-0">
        {status?.cvWorkerAlive ? (
          <span className="text-[#00F5FF]">CV WORKER ✓ ACTIVE</span>
        ) : (
          <span className="text-red-400">⚠ CV WORKER DOWN</span>
        )}
      </div>

      <Sep />

      {/* Cameras */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[#E2E8F0]">
          {status?.camerasOnline ?? "–"}/{status?.camerasTotal ?? "–"} CAMERAS
        </span>
        {status && status.camerasTotal > 0 && (
          <div className="w-12 h-1 bg-[#1E293B] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#00F5FF] rounded-full transition-all duration-500"
              style={{
                width: `${Math.round(
                  (status.camerasOnline / status.camerasTotal) * 100
                )}%`,
              }}
            />
          </div>
        )}
      </div>

      <Sep />

      {/* Pending alerts */}
      {(status?.pendingAlerts ?? 0) > 0 && (
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-red-400 font-bold animate-pulse">
            {status!.pendingAlerts} PENDING
          </span>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* User */}
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={`text-[9px] font-bold px-1.5 py-0 ${
            user?.role === "admin"
              ? "border-[#FF00AA]/60 text-[#FF00AA]"
              : "border-[#00F5FF]/60 text-[#00F5FF]"
          }`}
        >
          {(user?.role ?? "user").toUpperCase()}
        </Badge>
        <Avatar className="h-7 w-7 border border-primary/30 shrink-0">
          <AvatarFallback className="text-[10px] bg-primary/10 text-primary">
            {user?.name?.charAt(0).toUpperCase() ?? "?"}
          </AvatarFallback>
        </Avatar>
        <span className="text-[#E2E8F0] hidden lg:block max-w-[120px] truncate">
          {user?.name}
        </span>
      </div>
    </div>
  );
}

function Sep() {
  return <div className="w-px h-4 bg-[#1E293B] shrink-0" />;
}
