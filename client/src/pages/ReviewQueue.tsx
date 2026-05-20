import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { CheckCircle2, HelpCircle, UserCheck, Loader2, Eye } from "lucide-react";

const ACCENT = "#00F5FF";
const BORDER  = "#1E2D40";
const BG_CARD = "#0D1421";

function ConfidenceBadge({ conf }: { conf: string | null }) {
  const v = Number(conf ?? 0);
  const color = v >= 70 ? "#22c55e" : v >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <span className="font-mono text-xs font-bold" style={{ color }}>
      {v.toFixed(1)}%
    </span>
  );
}

function AlertRow({ alert, persons, onConfirm, onMarkUnknown }: {
  alert: any;
  persons: any[];
  onConfirm: (alertId: number, personId: number) => void;
  onMarkUnknown: (alertId: number) => void;
}) {
  const [selectedPersonId, setSelectedPersonId] = useState<string>("");
  const [expanded, setExpanded] = useState(false);

  return (
    <tr style={{ borderBottom: `1px solid ${BORDER}` }} className="hover:bg-white/5">
      {/* Face thumbnail */}
      <td className="px-4 py-3">
        <div
          className="w-12 h-12 rounded border overflow-hidden bg-[#0A0E1A] cursor-pointer"
          style={{ borderColor: BORDER }}
          onClick={() => setExpanded(!expanded)}
        >
          {alert.faceSnapshotUrl ? (
            <img
              src={alert.faceSnapshotUrl}
              alt="face"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Eye className="w-4 h-4 text-muted-foreground" />
            </div>
          )}
        </div>
      </td>

      {/* Info */}
      <td className="px-4 py-3">
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground font-mono">#{alert.id}</p>
          <p className="text-xs">{alert.cameraName} — {alert.zoneName}</p>
          <p className="text-xs text-muted-foreground">
            {new Date(alert.timestamp).toLocaleString()}
          </p>
        </div>
      </td>

      {/* Confidence */}
      <td className="px-4 py-3">
        <ConfidenceBadge conf={alert.confidence} />
      </td>

      {/* Current assignment */}
      <td className="px-4 py-3">
        {alert.personName
          ? <span className="text-xs font-medium">{alert.personName}</span>
          : <span className="text-xs text-muted-foreground">Unidentified</span>
        }
      </td>

      {/* Actions */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Select value={selectedPersonId} onValueChange={setSelectedPersonId}>
            <SelectTrigger
              className="h-7 text-xs w-40"
              style={{ background: "#0A0E1A", borderColor: BORDER }}
            >
              <SelectValue placeholder="Assign person…" />
            </SelectTrigger>
            <SelectContent style={{ background: "#0D1421" }}>
              {persons.filter(p => p.role !== 'UNKNOWN').map(p => (
                <SelectItem key={p.id} value={String(p.id)} className="text-xs">
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-7 text-xs px-2"
            disabled={!selectedPersonId}
            onClick={() => selectedPersonId && onConfirm(alert.id, Number(selectedPersonId))}
            style={{ background: "#00F5FF22", color: ACCENT, borderColor: ACCENT + "55" }}
            variant="outline"
          >
            <UserCheck className="w-3 h-3 mr-1" /> Confirm
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs px-2"
            variant="outline"
            onClick={() => onMarkUnknown(alert.id)}
            style={{ borderColor: BORDER }}
          >
            <HelpCircle className="w-3 h-3 mr-1" /> Unknown
          </Button>
        </div>
      </td>
    </tr>
  );
}

export default function ReviewQueue() {
  const [, setLocation] = useLocation();
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const { data: queueData, isLoading, refetch } = trpc.reviewQueue.list.useQuery(
    { limit, offset },
    { refetchInterval: 30_000 },
  );
  const { data: persons } = trpc.persons.list.useQuery();
  const confirmMutation   = trpc.reviewQueue.confirmIdentity.useMutation();

  const alerts = queueData ?? [];

  const handleConfirm = async (alertId: number, personId: number) => {
    try {
      await confirmMutation.mutateAsync({ alertId, confirmedPersonId: personId });
      toast.success("Identity confirmed");
      refetch();
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    }
  };

  const handleMarkUnknown = async (alertId: number) => {
    try {
      await confirmMutation.mutateAsync({ alertId, markUnknown: true });
      toast.success("Marked as unknown — moved to active alerts");
      refetch();
    } catch (e: any) {
      toast.error(`Failed: ${e.message}`);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6" style={{ background: "#0A0E1A" }}>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: ACCENT }}>
              Review Queue
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Medium-confidence alerts awaiting identity confirmation
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge
              className="font-mono text-lg px-3 py-1"
              style={{ background: "#00F5FF22", color: ACCENT, borderColor: ACCENT + "55" }}
            >
              {alerts.length} pending
            </Badge>
            <Button size="sm" variant="outline" onClick={() => refetch()} style={{ borderColor: BORDER }}>
              Refresh
            </Button>
          </div>
        </div>

        {/* Table */}
        <Card style={{ background: BG_CARD, borderColor: BORDER }}>
          {isLoading ? (
            <CardContent className="p-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </CardContent>
          ) : alerts.length === 0 ? (
            <CardContent className="p-10 text-center text-muted-foreground text-sm">
              <CheckCircle2 className="w-8 h-8 mx-auto mb-3 text-green-500 opacity-60" />
              No pending reviews — all clear!
            </CardContent>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                    {["Face", "Alert Info", "Confidence", "Current ID", "Actions"].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs text-muted-foreground uppercase tracking-widest">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((alert: any) => (
                    <AlertRow
                      key={alert.id}
                      alert={alert}
                      persons={persons ?? []}
                      onConfirm={handleConfirm}
                      onMarkUnknown={handleMarkUnknown}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Pagination */}
        {alerts.length === limit && (
          <div className="flex justify-center gap-3">
            <Button
              size="sm" variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
              style={{ borderColor: BORDER }}
            >
              Previous
            </Button>
            <Button
              size="sm" variant="outline"
              onClick={() => setOffset(offset + limit)}
              style={{ borderColor: BORDER }}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
