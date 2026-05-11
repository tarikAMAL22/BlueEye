import { useState, useEffect } from "react";
import { useParams, useLocation, Link as WouterLink } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  ArrowLeft, AlertCircle, CheckCircle, AlertTriangle, User, History,
  Video, UserPlus, Link as LinkIcon, Scan, Sparkles, Users, Clapperboard,
  RefreshCw, Search,
} from "lucide-react";
import { toast } from "sonner";

function threatLevelColor(level: string) {
  switch (level) {
    case "low":      return "threat-low";
    case "medium":   return "threat-medium";
    case "high":     return "threat-high";
    case "critical": return "threat-critical";
    default:         return "threat-medium";
  }
}

function statusIcon(status: string) {
  switch (status) {
    case "active":       return <AlertCircle className="w-4 h-4 text-red-500" />;
    case "acknowledged": return <CheckCircle  className="w-4 h-4 text-yellow-400" />;
    case "escalated":    return <AlertTriangle className="w-4 h-4 text-orange-500" />;
    case "dismissed":    return <CheckCircle  className="w-4 h-4 text-green-400" />;
    default:             return <AlertCircle className="w-4 h-4" />;
  }
}

function AlertLogs({ logs }: { logs: any[] }) {
  if (!logs || logs.length === 0)
    return <div className="text-xs text-muted-foreground italic p-4 text-center border border-dashed border-border/50 rounded-lg">No activity logs recorded.</div>;
  return (
    <div className="space-y-3 p-2">
      {logs.slice().reverse().map((log, i) => (
        <div key={i} className="flex gap-3 text-[10px] leading-tight p-2 rounded bg-muted/30 border border-border/10">
          <div className="text-muted-foreground whitespace-nowrap font-mono">
            {new Date(log.timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
          </div>
          <div>
            <span className="font-bold text-primary mr-1">{log.action}:</span>
            <span className="text-muted-foreground">{log.details}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function HistoryTable({ personId, getZoneName, getCameraName }: {
  personId: number;
  getZoneName: (id: number) => string;
  getCameraName: (id: number) => string;
}) {
  const { data: history, isLoading } = trpc.alerts.getByPerson.useQuery({ personId });
  if (isLoading) return <div className="p-4 text-center text-xs text-muted-foreground animate-pulse">Loading history...</div>;
  if (!history || history.length === 0) return <div className="p-4 text-center text-xs text-muted-foreground">No recent history found.</div>;
  return (
    <div className="text-[11px]">
      <table className="w-full">
        <thead className="bg-muted/50 text-muted-foreground uppercase text-[9px] font-bold">
          <tr>
            <th className="px-4 py-2 text-left">Zone</th>
            <th className="px-4 py-2 text-left">Camera</th>
            <th className="px-4 py-2 text-left">Timestamp</th>
            <th className="px-4 py-2 text-left">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {history.map((h: any) => (
            <tr key={h.id} className="hover:bg-primary/5 transition-colors cursor-pointer"
              onClick={() => window.location.href = `/alerts/${h.id}`}>
              <td className="px-4 py-2 font-medium">{getZoneName(h.zoneId)}</td>
              <td className="px-4 py-2 text-muted-foreground">{getCameraName(h.cameraId)}</td>
              <td className="px-4 py-2 text-muted-foreground font-mono">
                {new Date(h.timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
              </td>
              <td className="px-4 py-2">
                <Badge variant="outline" className="text-[9px] h-4 px-1.5 leading-none uppercase font-bold">{h.status}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PotentialMatches({ personId, onSelect, searchScore, currentPersonType }: {
  personId: number;
  onSelect: (id: number) => void;
  searchScore: number;
  currentPersonType: { name: string; role: string };
}) {
  const threshold = 1.0 - searchScore / 100;
  const { data: matches, isLoading } = trpc.persons.getPotentialMatches.useQuery({ personId, threshold });

  if (isLoading) return <div className="p-4 text-center text-xs text-muted-foreground animate-pulse">Scanning biometric registry...</div>;

  const filtered = matches?.filter((m: any) => {
    if (m.id === personId) return false;
    const isCurUnknown = currentPersonType.role.toLowerCase() === "unknown" || currentPersonType.name.toLowerCase().startsWith("unknown-");
    const isMatchUnknown = m.role.toLowerCase() === "unknown" || m.name.toLowerCase().startsWith("unknown-");
    return isCurUnknown ? !isMatchUnknown : isMatchUnknown;
  }) || [];

  if (filtered.length === 0)
    return <div className="p-4 text-center text-[10px] text-muted-foreground italic border border-dashed border-border/40 rounded-lg">No biometric matches found.</div>;

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase font-bold text-blue-400 flex items-center gap-2">
        <Scan className="w-3 h-3" /> AI Biometric Suggestions
      </h4>
      <div className="grid grid-cols-1 gap-2">
        {filtered.slice(0, 3).map((match: any) => (
          <div key={match.id} className="flex items-center justify-between p-2 rounded-lg bg-blue-500/5 border border-blue-500/20 hover:bg-blue-500/10 transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded overflow-hidden border border-blue-500/30">
                <img src={match.photoUrl} alt={match.name} className="w-full h-full object-cover" />
              </div>
              <div>
                <div className="text-xs font-bold text-blue-400">{match.name}</div>
                <div className="text-[10px] text-muted-foreground">{match.matchScore}% Match</div>
              </div>
            </div>
            <Button size="sm" variant="ghost"
              className="h-7 px-2 text-[10px] text-blue-400 hover:text-blue-300 hover:bg-blue-400/10"
              onClick={() => onSelect(match.id)}>
              C'est lui
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AlertDetails() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const alertId = parseInt(id || "0");

  const [searchScore, setSearchScore] = useState(() => {
    const saved = localStorage.getItem("blueeye_search_score");
    return saved ? parseInt(saved) : 50;
  });
  useEffect(() => {
    localStorage.setItem("blueeye_search_score", searchScore.toString());
  }, [searchScore]);

  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [personSearchQuery, setPersonSearchQuery] = useState("");
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonRole, setNewPersonRole] = useState("staff");

  const { data: alert, isLoading, refetch } = trpc.alerts.getById.useQuery({ id: alertId }, { enabled: !!alertId });
  const { data: personsList } = trpc.persons.list.useQuery();
  const { data: camerasList } = trpc.cameras.list.useQuery();
  const { data: zonesList }   = trpc.zones.list.useQuery();
  const { data: relatedMovement } = trpc.movements.getByAlertId.useQuery({ alertId }, { enabled: !!alertId });

  const updateStatusMutation  = trpc.alerts.updateStatus.useMutation();
  const assignPersonMutation  = trpc.alerts.assignPerson.useMutation();
  const unassignPersonMutation = trpc.alerts.unassignPerson.useMutation();
  const createPersonMutation  = trpc.persons.create.useMutation();

  const getCameraName     = (id: number) => camerasList?.find((c: any) => c.id === id)?.name     ?? `Camera #${id}`;
  const getCameraLocation = (id: number) => camerasList?.find((c: any) => c.id === id)?.location ?? "Unknown";
  const getZoneName       = (id: number) => zonesList?.find((z: any) => z.id === id)?.name       ?? `Zone #${id}`;
  const getZoneDescription= (id: number) => zonesList?.find((z: any) => z.id === id)?.description ?? "";
  const getPersonName     = (id: number | null) => id ? (personsList?.find((p: any) => p.id === id)?.name   ?? `Person #${id}`) : "Unknown";
  const getPersonPhoto    = (id: number | null) => id ? (personsList?.find((p: any) => p.id === id)?.photoUrl ?? null) : null;
  const getPersonRole     = (id: number | null) => id ? (personsList?.find((p: any) => p.id === id)?.role   ?? "staff") : null;

  const handleUpdateStatus = async (status: string) => {
    try {
      await updateStatusMutation.mutateAsync({ id: alertId, status: status as any });
      toast.success(`Alert marked as ${status}.`);
      refetch();
    } catch (e: any) { toast.error(e.message); }
  };

  const handleAssignExisting = async (directId?: number) => {
    const idToAssign = directId || (selectedPersonId ? parseInt(selectedPersonId) : null);
    if (!idToAssign) return;
    try {
      await assignPersonMutation.mutateAsync({ alertId, personId: idToAssign });
      toast.success("Identity assigned.");
      refetch();
    } catch (e: any) { toast.error(e.message); }
  };

  const handleCreateNewPerson = async () => {
    if (!newPersonName || !alert) return;
    try {
      const newPerson = await createPersonMutation.mutateAsync({
        name: newPersonName, role: newPersonRole, photoUrl: alert.faceSnapshotUrl,
      });
      const newPersonId = (newPerson as any)?.insertId;
      if (!newPersonId) throw new Error("Could not retrieve new person ID");
      await assignPersonMutation.mutateAsync({ alertId, personId: newPersonId });
      toast.success(`${newPersonName} registered and assigned.`);
      setNewPersonName("");
      refetch();
    } catch (e: any) { toast.error(e.message); }
  };

  const handleUnassign = async () => {
    try {
      await unassignPersonMutation.mutateAsync({ alertId });
      toast.success("Identity removed.");
      refetch();
    } catch (e: any) { toast.error(e.message); }
  };

  if (isLoading) {
    return (
      <div className="space-y-6 p-8">
        <Skeleton className="h-8 w-32" />
        <div className="grid grid-cols-12 gap-8">
          <Skeleton className="col-span-4 aspect-video rounded-xl" />
          <Skeleton className="col-span-4 h-64 rounded-xl" />
          <Skeleton className="col-span-4 h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!alert) {
    return (
      <div className="p-8 text-center">
        <AlertCircle className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-30" />
        <p className="text-muted-foreground">Alert not found.</p>
        <Button className="mt-4" variant="outline" onClick={() => setLocation("/alerts")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Alerts
        </Button>
      </div>
    );
  }

  const isUnknown = !alert.personId
    || getPersonName(alert.personId).toLowerCase().includes("unknown")
    || getPersonRole(alert.personId) === "UNKNOWN";

  return (
    <div className="space-y-6 p-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/alerts")} className="gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Alerts
        </Button>
        <div className="h-4 w-px bg-border/50" />
        <div className="flex items-center gap-3">
          {statusIcon(alert.status)}
          <h1 className="text-2xl font-bold text-primary">Alert #{alert.id}</h1>
          <Badge className={`${threatLevelColor(alert.threatLevel)} uppercase text-[10px] font-bold px-2 py-0.5`}>
            {alert.threatLevel}
          </Badge>
          <Badge variant="outline" className="uppercase text-[10px] font-bold px-2 py-0.5">{alert.status}</Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => refetch()} className="gap-1.5 text-muted-foreground">
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left: Visuals */}
        <div className="lg:col-span-4 space-y-6">
          <div>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Video className="w-4 h-4 text-primary" /> Best Frame Capture
            </h3>
            {(alert.metadata as any)?.multiPersonFrame && (
              <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-red-600/20 border border-red-500/50 text-red-400 text-xs font-bold uppercase">
                <Users className="w-4 h-4" /> Multiple Persons Detected
              </div>
            )}
            <div className="w-full aspect-video rounded-xl border border-border/50 bg-black flex items-center justify-center overflow-hidden shadow-2xl">
              {alert.bestFrameSnapshotUrl
                ? <img src={alert.bestFrameSnapshotUrl} alt="Best Frame" className="w-full h-full object-contain" />
                : <div className="flex flex-col items-center gap-2">
                    <AlertCircle className="w-12 h-12 text-muted-foreground opacity-20" />
                    <span className="text-xs text-muted-foreground">No frame available</span>
                  </div>
              }
            </div>

            {/* Multi-person face crops */}
            {(() => {
              const meta = alert.metadata as any;
              const urls: string[] = meta?.detectedFaceUrls ?? [];
              const count: number  = meta?.faceCount ?? 0;
              if (!meta) return null;
              return (
                <div className="mt-2 space-y-2">
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wide ${
                    count > 1  ? "bg-red-600/20 border border-red-600/50 text-red-400"
                    : count === 1 ? "bg-green-600/20 border border-green-500/50 text-green-400"
                    : "bg-yellow-600/20 border border-yellow-500/50 text-yellow-400"
                  }`}>
                    <Users className="w-4 h-4 flex-shrink-0" />
                    {count === 0 ? "No face detected" : count === 1 ? "1 person in frame" : `${count} persons in frame`}
                  </div>
                  {urls.length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase font-bold text-muted-foreground mb-1.5">Detected Faces</p>
                      <div className="flex flex-wrap gap-2">
                        {urls.map((url, i) => (
                          <div key={i} className="w-16 h-16 rounded border border-red-500/40 overflow-hidden bg-muted">
                            <img src={url} alt={`Face ${i + 1}`} className="w-full h-full object-cover" />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <h3 className="text-sm font-medium mb-3">Face Snapshot</h3>
              <div className="aspect-square rounded-xl border border-border/50 bg-muted flex items-center justify-center overflow-hidden">
                {alert.faceSnapshotUrl
                  ? <img src={alert.faceSnapshotUrl} alt="Face" className="w-full h-full object-cover" />
                  : <AlertCircle className="w-8 h-8 text-muted-foreground" />}
              </div>
            </div>
            <div className="flex flex-col justify-end">
              <div className="p-4 rounded-xl border border-border/50 bg-card/50">
                <h3 className="text-sm font-medium mb-2">Confidence</h3>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="w-full h-3 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-primary to-secondary" style={{ width: `${alert.confidence}%` }} />
                    </div>
                  </div>
                  <span className="text-xl font-bold text-primary">{alert.confidence}%</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Middle: Event Data */}
        <div className="lg:col-span-3 space-y-6">
          <div className="p-6 rounded-xl border border-border/50 bg-card/50 space-y-6">
            {/* Person */}
            <div className="flex items-center justify-between gap-4">
              {alert.personId ? (
                <WouterLink href={`/persons/${alert.personId}`} className="flex items-center gap-4 hover:opacity-80 transition-opacity group">
                  <div className="w-16 h-16 rounded-full bg-primary/10 border-2 border-primary/20 overflow-hidden flex items-center justify-center group-hover:border-primary/50 transition-colors">
                    {getPersonPhoto(alert.personId)
                      ? <img src={getPersonPhoto(alert.personId)!} alt="Registry" className="w-full h-full object-cover" />
                      : <User className="w-8 h-8 text-primary" />}
                  </div>
                  <div>
                    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Identified As</h3>
                    <p className="text-2xl font-bold text-primary group-hover:underline decoration-primary/30">
                      {getPersonName(alert.personId)}
                    </p>
                    <Badge variant="secondary" className="mt-1">{getPersonRole(alert.personId)}</Badge>
                  </div>
                </WouterLink>
              ) : (
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-primary/10 border-2 border-primary/20 flex items-center justify-center">
                    <User className="w-8 h-8 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Identified As</h3>
                    <p className="text-2xl font-bold text-primary">Unknown</p>
                  </div>
                </div>
              )}
              {alert.personId && (
                <Button variant="destructive" size="sm" onClick={handleUnassign}
                  className="h-8 px-2 text-[10px] uppercase font-bold">
                  Not Him
                </Button>
              )}
            </div>

            <hr className="border-border/50" />

            <div className="grid grid-cols-2 gap-y-6 gap-x-4">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Camera Source</label>
                <p className="text-sm font-bold">{getCameraName(alert.cameraId)}</p>
                <p className="text-[10px] text-muted-foreground italic">{getCameraLocation(alert.cameraId)}</p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Security Zone</label>
                <p className="text-sm font-bold text-secondary">{getZoneName(alert.zoneId)}</p>
                <p className="text-[10px] text-muted-foreground italic">{getZoneDescription(alert.zoneId)}</p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Timestamp</label>
                <p className="text-sm font-bold font-mono">{new Date(alert.createdAt ?? alert.timestamp).toLocaleString()}</p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Alert ID</label>
                <p className="text-sm font-bold font-mono">#{alert.id}</p>
              </div>
            </div>

            <hr className="border-border/50" />

            {/* Activity Logs */}
            <div className="space-y-4">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Activity Logs</h3>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-border/30 bg-black/20">
                <AlertLogs logs={(alert as any).logs ?? []} />
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 pt-2 border-t border-border/50">
              {alert.status === "active" && (
                <>
                  <Button onClick={() => handleUpdateStatus("acknowledged")}
                    className="bg-yellow-600 hover:bg-yellow-700 text-white flex-1">
                    Acknowledge
                  </Button>
                  <Button onClick={() => handleUpdateStatus("escalated")}
                    className="bg-red-600 hover:bg-red-700 text-white flex-1">
                    Escalate
                  </Button>
                </>
              )}
              <Button onClick={() => handleUpdateStatus("dismissed")} variant="outline" className="flex-1">
                Dismiss
              </Button>
              {relatedMovement && (
                <WouterLink href={`/movements/${relatedMovement.id}`} className="flex-1">
                  <Button variant="outline"
                    className="w-full gap-2 border-orange-500/50 text-orange-400 hover:bg-orange-500/10 hover:border-orange-500">
                    <Clapperboard className="w-4 h-4" />
                    Motion #{relatedMovement.id}
                  </Button>
                </WouterLink>
              )}
            </div>
          </div>
        </div>

        {/* Right: History */}
        <div className="lg:col-span-5 border border-border/50 rounded-xl bg-card/30 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-border/50 bg-muted/30 flex items-center">
            <h3 className="text-sm font-bold flex items-center gap-2 uppercase tracking-tight">
              <History className="w-4 h-4 text-muted-foreground" /> Detection History
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            {alert.personId ? (
              <HistoryTable personId={alert.personId} getZoneName={getZoneName} getCameraName={getCameraName} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full p-8 text-center gap-3">
                <UserPlus className="w-8 h-8 text-muted-foreground opacity-20" />
                <p className="text-xs text-muted-foreground italic">Resolve identity to see history.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Identity Resolution */}
      {isUnknown && (
        <div className="p-6 rounded-xl border border-blue-500/30 bg-blue-500/5 shadow-lg shadow-blue-500/5">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-sm font-bold text-blue-400 flex items-center gap-2 uppercase tracking-tight">
              <Sparkles className="w-4 h-4" /> Resolve Identity
            </h3>
            <div className="flex flex-col items-end gap-1.5 min-w-[140px]">
              <div className="flex justify-between w-full px-1">
                <span className="text-[10px] uppercase text-muted-foreground font-bold">Sensitivity</span>
                <span className="text-[10px] font-mono text-blue-400 font-bold">{searchScore}%</span>
              </div>
              <Slider value={[searchScore]} onValueChange={v => setSearchScore(v[0])} max={100} step={5} className="w-32" />
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
            {/* AI Suggestions */}
            <div className="xl:col-span-1 border-r border-border/50 pr-8">
              {alert.personId ? (
                <PotentialMatches
                  personId={alert.personId}
                  onSelect={id => handleAssignExisting(id)}
                  searchScore={searchScore}
                  currentPersonType={{ name: getPersonName(alert.personId), role: getPersonRole(alert.personId) || "UNKNOWN" }}
                />
              ) : (
                <div className="text-center py-8 text-xs text-muted-foreground italic">Biometric analysis pending...</div>
              )}
            </div>

            {/* Link to Registry */}
            <div className="space-y-4 xl:col-span-1">
              <h4 className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-2">
                <LinkIcon className="w-3 h-3" /> Link to Registry
              </h4>
              <div className="space-y-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60" />
                  <Input placeholder="Search names..." className="h-8 pl-8 text-xs bg-background/50"
                    value={personSearchQuery} onChange={e => setPersonSearchQuery(e.target.value)} />
                </div>
                <div className="max-h-[180px] overflow-y-auto border border-border/40 rounded-lg bg-background/30 p-1 space-y-1">
                  {personsList?.filter(p => {
                    if (p.id === alert.personId) return false;
                    const curRole = (getPersonRole(alert.personId) || "UNKNOWN").toLowerCase();
                    const curName = getPersonName(alert.personId).toLowerCase();
                    const isCurUnknown = curRole === "unknown" || curName.startsWith("unknown-");
                    const isTargetUnknown = p.role.toLowerCase() === "unknown" || p.name.toLowerCase().startsWith("unknown-");
                    return (isCurUnknown ? !isTargetUnknown : isTargetUnknown)
                      && p.name.toLowerCase().includes(personSearchQuery.toLowerCase());
                  }).slice(0, 10).map(p => (
                    <div key={p.id}
                      className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${selectedPersonId === String(p.id) ? "bg-primary/20 border border-primary/30" : "hover:bg-muted/50 border border-transparent"}`}
                      onClick={() => setSelectedPersonId(String(p.id))}>
                      <div className="flex items-center gap-2 overflow-hidden">
                        <div className="w-7 h-7 rounded overflow-hidden bg-muted flex-shrink-0 border border-border/50">
                          {p.photoUrl ? <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover" /> : <User className="w-full h-full p-1.5 text-muted-foreground/50" />}
                        </div>
                        <div className="min-w-0">
                          <div className="text-[11px] font-bold truncate">{p.name}</div>
                          <div className="text-[9px] text-muted-foreground uppercase">{p.role}</div>
                        </div>
                      </div>
                      {selectedPersonId === String(p.id) && <CheckCircle className="w-3.5 h-3.5 text-primary" />}
                    </div>
                  ))}
                </div>
                <Button onClick={() => handleAssignExisting()} disabled={!selectedPersonId}
                  className="w-full h-9 bg-primary text-primary-foreground hover:bg-primary/90">
                  <LinkIcon className="w-4 h-4 mr-2" /> Assign Identity
                </Button>
              </div>
            </div>

            {/* Register New */}
            <div className="space-y-4 border-l border-border/50 pl-8">
              <h4 className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-2">
                <UserPlus className="w-3 h-3" /> Register as New Person
              </h4>
              <div className="space-y-3 pt-1">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Full Name</Label>
                  <Input value={newPersonName} onChange={e => setNewPersonName(e.target.value)}
                    placeholder="e.g. John Doe" className="h-9 bg-background/50" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Role</Label>
                  <Input value={newPersonRole} onChange={e => setNewPersonRole(e.target.value)}
                    placeholder="e.g. staff, visitor" className="h-9 bg-background/50" />
                </div>
                <Button onClick={handleCreateNewPerson} disabled={!newPersonName} variant="secondary" className="w-full h-9 mt-2">
                  <UserPlus className="w-4 h-4 mr-2" /> Register & Assign
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
