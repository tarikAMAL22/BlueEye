import { motion } from "framer-motion";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle, ArrowUpCircle, XCircle, User } from "lucide-react";

const THREAT_BORDER: Record<string, string> = {
  low: "#10B981",
  medium: "#F59E0B",
  high: "#EF4444",
  critical: "#DC2626",
};

const THREAT_BG: Record<string, string> = {
  low: "#10B98110",
  medium: "#F59E0B10",
  high: "#EF444410",
  critical: "#DC262610",
};

type AlertShape = {
  id: number;
  threatLevel?: string | null;
  status?: string | null;
  confidence?: string | number | null;
  faceSnapshotUrl?: string | null;
  bestFrameSnapshotUrl?: string | null;
  zoneId?: number | null;
  personId?: number | null;
  timestamp?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  person?: { name?: string | null; role?: string | null } | null;
};

interface Props {
  alert: AlertShape;
}

function ago(ts: Date | string | null | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function AlertCard({ alert }: Props) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const updateStatus = trpc.alerts.updateStatus.useMutation({
    onSuccess: () => utils.alerts.list.invalidate(),
  });

  const threat = alert.threatLevel ?? "low";
  const borderColor = THREAT_BORDER[threat] ?? THREAT_BORDER.low;
  const bgColor = THREAT_BG[threat] ?? THREAT_BG.low;
  const confidence = Math.round(parseFloat(String(alert.confidence ?? "0")) * 100);
  const isNoFace = (alert.metadata as any)?.bodyOnlyDetection === true;

  function act(e: React.MouseEvent, status: "acknowledged" | "escalated" | "dismissed") {
    e.stopPropagation();
    updateStatus.mutate(
      { id: alert.id, status },
      {
        onError: () =>
          toast({ title: "Error", description: "Failed to update alert", variant: "destructive" }),
      }
    );
  }

  return (
    <motion.div
      layout
      initial={{ y: -30, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0, overflow: "hidden" }}
      transition={{ duration: 0.2 }}
      className="rounded border cursor-pointer hover:brightness-110 transition-all mb-2"
      style={{ borderLeft: `3px solid ${borderColor}`, background: bgColor, borderColor: `${borderColor}30` }}
      onClick={() => navigate(`/alerts/${alert.id}`)}
    >
      <div className="flex gap-2 p-2.5">
        {/* Photo */}
        <div className="w-14 h-14 rounded bg-[#1E293B] overflow-hidden flex-shrink-0 flex items-center justify-center">
          {alert.faceSnapshotUrl || alert.bestFrameSnapshotUrl ? (
            <img
              src={(alert.faceSnapshotUrl ?? alert.bestFrameSnapshotUrl)!}
              alt="snapshot"
              className="w-full h-full object-cover"
            />
          ) : (
            <User className="w-6 h-6 text-[#64748B]" />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className="text-[9px] font-mono font-bold px-1 py-0.5 rounded"
                style={{ background: `${borderColor}30`, color: borderColor }}
              >
                {threat.toUpperCase()}
              </span>
              {isNoFace && (
                <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-[#1E293B] text-[#94A3B8]">
                  NO FACE
                </span>
              )}
            </div>
            <span className="text-[9px] font-mono text-[#64748B] flex-shrink-0">
              {ago(alert.timestamp)}
            </span>
          </div>

          <div className="text-[11px] font-mono font-bold text-[#E2E8F0] truncate mt-0.5">
            {alert.person?.name ?? "INCONNU"}
          </div>

          {alert.zoneId && (
            <div className="text-[9px] font-mono text-[#64748B] truncate">
              ZONE #{alert.zoneId}
            </div>
          )}

          {/* Confidence bar */}
          <div className="flex items-center gap-1.5 mt-1">
            <div className="flex-1 h-0.5 bg-[#1E293B] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${confidence}%`,
                  background: confidence > 70 ? "#22C55E" : confidence > 40 ? "#F59E0B" : "#EF4444",
                }}
              />
            </div>
            <span className="text-[9px] font-mono text-[#64748B]">{confidence}%</span>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex border-t border-[#1E293B30] px-2 py-1 gap-1">
        <button
          onClick={(e) => act(e, "acknowledged")}
          className="flex-1 flex items-center justify-center gap-1 py-0.5 rounded hover:bg-green-500/20 text-green-400 transition-colors"
        >
          <CheckCircle className="w-3 h-3" />
          <span className="text-[9px] font-mono">ACK</span>
        </button>
        <button
          onClick={(e) => act(e, "escalated")}
          className="flex-1 flex items-center justify-center gap-1 py-0.5 rounded hover:bg-orange-500/20 text-orange-400 transition-colors"
        >
          <ArrowUpCircle className="w-3 h-3" />
          <span className="text-[9px] font-mono">ESC</span>
        </button>
        <button
          onClick={(e) => act(e, "dismissed")}
          className="flex-1 flex items-center justify-center gap-1 py-0.5 rounded hover:bg-red-500/20 text-red-400 transition-colors"
        >
          <XCircle className="w-3 h-3" />
          <span className="text-[9px] font-mono">DIS</span>
        </button>
      </div>
    </motion.div>
  );
}
