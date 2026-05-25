import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { AlertTriangle, Eye, UserX, Camera } from "lucide-react";

export function KpiCards() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const isAdmin = user?.role === "admin";

  const { data: stats } = trpc.dashboard.stats.useQuery(undefined, { refetchInterval: 10000 });
  const { data: breakdown } = trpc.dashboard.todayBreakdown.useQuery(undefined, { refetchInterval: 30000 });
  const { data: systemStatus } = trpc.dashboard.systemStatus.useQuery(undefined, { refetchInterval: 10000 });

  const cards = [
    {
      label: "ACTIVE ALERTS",
      value: stats?.activeAlerts ?? "–",
      icon: AlertTriangle,
      color: "#EF4444",
      warn: (stats?.activeAlerts ?? 0) > 0,
      action: () => navigate("/alerts"),
      actionLabel: isAdmin ? "MANAGE →" : "VIEW →",
    },
    {
      label: "DETECTIONS TODAY",
      value: breakdown?.totalToday ?? "–",
      icon: Eye,
      color: "#00F5FF",
      warn: false,
      action: () => navigate("/events"),
      actionLabel: isAdmin ? "MANAGE →" : "VIEW →",
    },
    {
      label: "UNKNOWNS TODAY",
      value: breakdown?.unknownToday ?? "–",
      icon: UserX,
      color: "#F97316",
      warn: (breakdown?.unknownPercent ?? 0) > 20,
      sub: breakdown ? `${breakdown.unknownPercent}% of total` : undefined,
      action: () => navigate("/registry"),
      actionLabel: isAdmin ? "MANAGE →" : "VIEW →",
    },
    {
      label: "CAMERAS",
      value:
        systemStatus
          ? `${systemStatus.camerasOnline}/${systemStatus.camerasTotal}`
          : "–",
      icon: Camera,
      color: "#22C55E",
      warn: systemStatus
        ? systemStatus.camerasOnline < systemStatus.camerasTotal
        : false,
      action: () => navigate("/cameras"),
      actionLabel: isAdmin ? "MANAGE →" : "VIEW →",
    },
  ];

  return (
    <div className="flex flex-col border-b border-[#1E293B] flex-shrink-0">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.label}
            className="flex items-center gap-3 px-4 h-[72px] border-b border-[#1E293B] last:border-b-0 hover:bg-[#0F172A] transition-colors cursor-pointer group"
            onClick={card.action}
          >
            <div
              className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
              style={{ background: `${card.color}18` }}
            >
              <Icon className="w-4 h-4" style={{ color: card.color }} />
            </div>

            <div className="flex-1 min-w-0">
              <div className="text-[#64748B] text-[9px] font-mono font-bold tracking-widest truncate">
                {card.label}
              </div>
              <div
                className="text-xl font-bold font-mono tabular-nums leading-none mt-0.5"
                style={{ color: card.warn ? card.color : "#E2E8F0" }}
              >
                {card.value}
              </div>
              {card.sub && (
                <div
                  className="text-[9px] font-mono mt-0.5"
                  style={{ color: card.warn ? card.color : "#64748B" }}
                >
                  {card.sub}
                </div>
              )}
            </div>

            <span
              className="text-[9px] font-mono font-bold opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
              style={{ color: card.color }}
            >
              {card.actionLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}
