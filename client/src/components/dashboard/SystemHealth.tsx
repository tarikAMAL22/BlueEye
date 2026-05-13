import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Database, Users, AlertTriangle, Activity, Settings } from "lucide-react";

function ago(ts: Date | string | null | undefined): string {
  if (!ts) return "never";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function SystemHealth() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const { data: health } = trpc.dashboard.systemHealth.useQuery(undefined, {
    refetchInterval: 30000,
  });
  const { data: status } = trpc.dashboard.systemStatus.useQuery(undefined, {
    refetchInterval: 10000,
  });

  const stats = [
    {
      icon: Users,
      label: "Persons",
      value: health?.personsTotal ?? "–",
      sub: health ? `${health.personsWithValidEncoding} encoded` : undefined,
      color: "#00F5FF",
    },
    {
      icon: AlertTriangle,
      label: "Alerts total",
      value: health?.alertsTotal ?? "–",
      sub: undefined,
      color: "#EF4444",
    },
    {
      icon: Activity,
      label: "Events total",
      value: health?.eventsTotal ?? "–",
      sub: health?.lastEventAt ? `Last ${ago(health.lastEventAt)}` : undefined,
      color: "#22C55E",
    },
    {
      icon: Database,
      label: "Avg confidence",
      value: health?.avgConfidence != null ? `${health.avgConfidence}%` : "–",
      sub: undefined,
      color: "#F97316",
    },
  ];

  return (
    <div className="flex flex-col flex-1">
      <div className="px-3 py-2 text-[9px] font-mono font-bold text-[#64748B] tracking-widest border-b border-[#1E293B] flex-shrink-0">
        SYSTEM HEALTH
      </div>

      {/* CV Worker status */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-[#1E293B] flex-shrink-0">
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            status?.cvWorkerAlive ? "bg-green-400 animate-pulse" : "bg-red-500"
          }`}
        />
        <span
          className={`text-[10px] font-mono font-bold ${
            status?.cvWorkerAlive ? "text-green-400" : "text-red-400"
          }`}
        >
          CV WORKER {status?.cvWorkerAlive ? "ACTIVE" : "DOWN"}
        </span>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-px bg-[#1E293B] flex-shrink-0">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="bg-[#0D1117] px-3 py-2">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Icon className="w-3 h-3 flex-shrink-0" style={{ color: s.color }} />
                <span className="text-[8px] font-mono text-[#64748B] truncate">{s.label}</span>
              </div>
              <div className="text-base font-bold font-mono tabular-nums" style={{ color: s.color }}>
                {s.value}
              </div>
              {s.sub && (
                <div className="text-[8px] font-mono text-[#64748B]">{s.sub}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Recent events */}
      {(health?.recentEvents ?? []).length > 0 && (
        <div className="flex-shrink-0 border-t border-[#1E293B]">
          <div className="px-3 py-1.5 text-[8px] font-mono text-[#64748B] tracking-widest">
            RECENT EVENTS
          </div>
          {health!.recentEvents.map((ev) => (
            <div key={ev.id} className="px-3 py-1 flex justify-between items-center">
              <span className="text-[9px] font-mono text-[#E2E8F0] truncate flex-1">
                {ev.personName ?? "Unknown"} — {ev.eventType ?? "event"}
              </span>
              <span className="text-[8px] font-mono text-[#64748B] flex-shrink-0 ml-2">
                {ago(ev.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Admin actions */}
      {isAdmin && (
        <div className="border-t border-[#1E293B] p-2 mt-auto flex-shrink-0">
          <div className="text-[8px] font-mono text-[#64748B] tracking-widest mb-1.5">
            QUICK ACTIONS
          </div>
          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={() => {
                toast({ title: "Clean DB", description: "Go to Settings → Maintenance to clean the database." });
                navigate("/settings");
              }}
              className="flex items-center justify-center gap-1 py-1.5 rounded border border-[#1E293B] hover:bg-[#1E293B] text-[#64748B] hover:text-[#E2E8F0] transition-colors"
            >
              <Database className="w-3 h-3" />
              <span className="text-[9px] font-mono">Clean DB</span>
            </button>
            <button
              onClick={() => navigate("/settings")}
              className="flex items-center justify-center gap-1 py-1.5 rounded border border-[#1E293B] hover:bg-[#1E293B] text-[#64748B] hover:text-[#E2E8F0] transition-colors"
            >
              <Settings className="w-3 h-3" />
              <span className="text-[9px] font-mono">Settings</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
