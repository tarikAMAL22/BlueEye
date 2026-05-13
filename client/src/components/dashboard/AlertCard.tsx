import { motion } from "framer-motion";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle, ArrowUpCircle, XCircle, User, Users } from "lucide-react";

const THREAT_BORDER: Record<string, string> = {
  low: "#10B981",
  medium: "#F59E0B",
  high: "#EF4444",
  critical: "#DC2626",
};

const THREAT_BG: Record<string, string> = {
  low: "#10B98115",
  medium: "#F59E0B15",
  high: "#EF444415",
  critical: "#DC262615",
};

type AlertShape = {
  id: number;
  threatLevel?: string | null;
  status?: string | null;
  confidence?: string | number | null;
  faceSnapshotUrl?: string | null;
  bestFrameSnapshotUrl?: string | null;
  zoneId?: number | null;
  cameraId?: number | null;
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
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const STATUS_COLOR: Record<string, string> = {
  active: "#EF4444",
  acknowledged: "#10B981",
  escalated: "#F59E0B",
  dismissed: "#64748B",
};

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
  const faceCount = (alert.metadata as any)?.faceCount as number | undefined;
  const isMulti = faceCount != null && faceCount > 1;
  const status = alert.status ?? "active";

  const previewUrl = alert.bestFrameSnapshotUrl ?? null;
  const faceUrl = alert.faceSnapshotUrl ?? null;

  function act(e: React.MouseEvent, newStatus: "acknowledged" | "escalated" | "dismissed") {
    e.stopPropagation();
    updateStatus.mutate(
      { id: alert.id, status: newStatus },
      {
        onError: () =>
          toast({ title: "Error", description: "Failed to update alert", variant: "destructive" }),
      }
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94, height: 0, marginBottom: 0, overflow: "hidden" }}
      transition={{ duration: 0.2 }}
      className="rounded-xl overflow-hidden cursor-pointer hover:scale-[1.02] transition-all"
      style={{
        border: `1px solid ${borderColor}40`,
        borderTop: `3px solid ${borderColor}`,
        background: bgColor,
      }}
      onClick={() => navigate(`/alerts/${alert.id}`)}
    >
      {/* ── Image preview (aspect-video) ─────────────────────────── */}
      <div className="relative aspect-video bg-[#080D14] overflow-hidden">
        {previewUrl ? (
          <img src={previewUrl} alt="best frame" className="w-full h-full object-cover" />
        ) : faceUrl ? (
          <img src={faceUrl} alt="face" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <User className="w-8 h-8 text-[#1E293B]" />
          </div>
        )}

        {/* Threat badge — top-left */}
        <div
          className="absolute top-1.5 left-1.5 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
          style={{ background: `${borderColor}cc`, color: "#fff" }}
        >
          {threat.toUpperCase()}
        </div>

        {/* Multi-person badge — top-right */}
        {isMulti && (
          <div className="absolute top-1.5 right-1.5 bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1">
            <Users className="w-2.5 h-2.5" /> {faceCount}
          </div>
        )}

        {/* NO FACE badge — top-right (when not multi) */}
        {isNoFace && !isMulti && (
          <div className="absolute top-1.5 right-1.5 bg-purple-700/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
            NO FACE
          </div>
        )}

        {/* Face crop — bottom-left */}
        {faceUrl && previewUrl && (
          <div className="absolute bottom-1.5 left-1.5 w-10 h-10 rounded border-2 border-white/40 overflow-hidden bg-black shadow-lg">
            <img src={faceUrl} alt="face crop" className="w-full h-full object-cover" />
          </div>
        )}

        {/* Status badge — bottom-right */}
        <div
          className="absolute bottom-1.5 right-1.5 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
          style={{ background: `${STATUS_COLOR[status] ?? "#64748B"}cc`, color: "#fff" }}
        >
          {status.toUpperCase()}
        </div>
      </div>

      {/* ── Info section ─────────────────────────────────────────── */}
      <div className="px-2.5 pt-2 pb-1.5 space-y-1">
        <div className="text-[11px] font-mono font-bold text-[#E2E8F0] truncate">
          {alert.person?.name ?? "INCONNU"}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-[#64748B]">
            {alert.zoneId ? `ZONE #${alert.zoneId}` : "—"}
          </span>
          <span className="text-[9px] font-mono text-[#475569]">{ago(alert.timestamp)}</span>
        </div>

        {/* Confidence bar */}
        <div className="flex items-center gap-1.5 pt-0.5">
          <div className="flex-1 h-0.5 bg-[#1E293B] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${confidence}%`,
                background: confidence > 70 ? "#22C55E" : confidence > 40 ? "#F59E0B" : "#EF4444",
              }}
            />
          </div>
          <span className="text-[9px] font-mono text-[#64748B] tabular-nums w-7 text-right">
            {confidence}%
          </span>
        </div>
      </div>

      {/* ── Action buttons ───────────────────────────────────────── */}
      <div className="flex border-t border-[#1E293B60] px-2 py-1 gap-1">
        <button
          onClick={(e) => act(e, "acknowledged")}
          className="flex-1 flex items-center justify-center gap-1 py-1 rounded hover:bg-green-500/20 text-green-400 transition-colors"
        >
          <CheckCircle className="w-3 h-3" />
          <span className="text-[9px] font-mono">ACK</span>
        </button>
        <button
          onClick={(e) => act(e, "escalated")}
          className="flex-1 flex items-center justify-center gap-1 py-1 rounded hover:bg-orange-500/20 text-orange-400 transition-colors"
        >
          <ArrowUpCircle className="w-3 h-3" />
          <span className="text-[9px] font-mono">ESC</span>
        </button>
        <button
          onClick={(e) => act(e, "dismissed")}
          className="flex-1 flex items-center justify-center gap-1 py-1 rounded hover:bg-red-500/20 text-red-400 transition-colors"
        >
          <XCircle className="w-3 h-3" />
          <span className="text-[9px] font-mono">DIS</span>
        </button>
      </div>
    </motion.div>
  );
}
