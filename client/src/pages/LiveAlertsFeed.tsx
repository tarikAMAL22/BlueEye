import { useState, useEffect } from "react";
import { Link as WouterLink } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle, AlertTriangle, Eye, RefreshCw, UserPlus, Link as LinkIcon, User, History, Video, Filter, X, Scan, Sparkles, Users, Clapperboard } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Search } from "lucide-react";

const REFRESH_INTERVAL = 5000; // 5 seconds

export default function LiveAlertsFeed() {
  const [selectedAlert, setSelectedAlert] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);
  
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterZoneId, setFilterZoneId] = useState<string>("all");
  const [filterPersonId, setFilterPersonId] = useState<string>("all");
  const [filterTimeRange, setFilterTimeRange] = useState<string>("all");
  const [filterDateFrom, setFilterDateFrom] = useState<string>("");
  const [filterDateTo, setFilterDateTo]     = useState<string>("");

  // Person autocomplete filter
  const [personFilterQuery, setPersonFilterQuery] = useState("");
  const [personFilterOpen, setPersonFilterOpen]   = useState(false);

  // Resolve Identity modal states
  const [selectedPersonId, setSelectedPersonId] = useState<string>("");
  const [personSearchQuery, setPersonSearchQuery] = useState("");
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonRole, setNewPersonRole] = useState("staff");

  // Biometric Search Threshold
  const [searchScore, setSearchScore] = useState(() => {
    const saved = localStorage.getItem("blueeye_search_score");
    return saved ? parseInt(saved) : 50;
  });

  useEffect(() => {
    localStorage.setItem("blueeye_search_score", searchScore.toString());
  }, [searchScore]);

  const getStartDate = () => {
    // Custom date takes priority over presets
    if (filterDateFrom) return new Date(filterDateFrom).toISOString();
    if (filterTimeRange === "all") return undefined;
    const now = new Date();
    switch (filterTimeRange) {
      case "1h":  now.setHours(now.getHours() - 1);   break;
      case "24h": now.setHours(now.getHours() - 24);  break;
      case "7d":  now.setDate(now.getDate() - 7);      break;
      case "30d": now.setDate(now.getDate() - 30);     break;
    }
    return now.toISOString();
  };

  const getEndDate = () => filterDateTo ? new Date(filterDateTo).toISOString() : undefined;

  const { toast } = useToast();
  const { data: alerts, isLoading, refetch } = trpc.alerts.list.useQuery({ 
    limit: 50,
    status: filterStatus !== "all" ? filterStatus : undefined,
    zoneId: filterZoneId !== "all" ? parseInt(filterZoneId) : undefined,
    personId: filterPersonId !== "all" ? parseInt(filterPersonId) : undefined,
    startDate: getStartDate(),
  });
  const { data: personsList } = trpc.persons.list.useQuery();
  const { data: camerasList } = trpc.cameras.list.useQuery();
  const { data: zonesList } = trpc.zones.list.useQuery();

  const params = new URLSearchParams(window.location.search);
  const urlAlertId = params.get("alertId");

  const { data: deepAlert } = trpc.alerts.getById.useQuery(
    { id: parseInt(urlAlertId || "0") },
    { enabled: !!urlAlertId }
  );

  useEffect(() => {
    if (urlAlertId && deepAlert) {
      setSelectedAlert(deepAlert);
      setOpen(true);
    } else if (urlAlertId && alerts) {
      const alert = alerts.find((a: any) => a.id === parseInt(urlAlertId));
      if (alert) {
        setSelectedAlert(alert);
        setOpen(true);
      }
    }
  }, [urlAlertId, deepAlert, alerts]);

  const getCameraName = (id: number) => camerasList?.find((c: any) => c.id === id)?.name ?? `Camera #${id}`;
  const getCameraLocation = (id: number) => camerasList?.find((c: any) => c.id === id)?.location ?? "Unknown Location";
  const getZoneName = (id: number) => zonesList?.find((z: any) => z.id === id)?.name ?? `Zone #${id}`;
  const getZoneDescription = (id: number) => zonesList?.find((z: any) => z.id === id)?.description ?? "";
  const getPersonName = (id: number | null) => id ? (personsList?.find((p: any) => p.id === id)?.name ?? `Person #${id}`) : "Unknown";
  const getPersonPhoto = (id: number | null) => id ? (personsList?.find((p: any) => p.id === id)?.photoUrl ?? null) : null;
  const getPersonRole = (id: number | null) => id ? (personsList?.find((p: any) => p.id === id)?.role ?? "staff") : null;
  
  const updateStatusMutation = trpc.alerts.updateStatus.useMutation();
  const assignPersonMutation = trpc.alerts.assignPerson.useMutation();
  const unassignPersonMutation = trpc.alerts.unassignPerson.useMutation();
  const createPersonMutation = trpc.persons.create.useMutation();

  const { data: relatedMovement } = trpc.movements.getByAlertId.useQuery(
    { alertId: selectedAlert?.id ?? 0 },
    { enabled: !!selectedAlert }
  );

  const AlertLogs = ({ logs }: { logs: any[] }) => {
    if (!logs || logs.length === 0) return <div className="text-xs text-muted-foreground italic p-4 text-center border border-dashed border-border/50 rounded-lg">No activity logs recorded.</div>;
    return (
      <div className="space-y-3 p-2">
        {logs.slice().reverse().map((log, i) => (
          <div key={i} className="flex gap-3 text-[10px] leading-tight p-2 rounded bg-muted/30 border border-border/10">
            <div className="text-muted-foreground whitespace-nowrap font-mono">{new Date(log.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
            <div>
              <span className="font-bold text-primary mr-1">{log.action}:</span>
              <span className="text-muted-foreground">{log.details}</span>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const HistoryTable = ({ personId, getZoneName, getCameraName }: { personId: number, getZoneName: (id: number) => string, getCameraName: (id: number) => string }) => {
    const { data: history, isLoading } = trpc.alerts.getByPerson.useQuery({ personId });

    if (isLoading) return <div className="p-4 text-center text-xs text-muted-foreground animate-pulse">Loading history...</div>;
    if (!history || history.length === 0) return <div className="p-4 text-center text-xs text-muted-foreground">No recent history found.</div>;

    return (
      <div className="text-[11px]">
        <table className="w-full">
          <thead className="bg-muted/50 text-muted-foreground uppercase text-[9px] font-bold">
            <tr>
              <th className="px-4 py-2 text-left">Zone</th>
              <th className="px-4 py-2 text-left">Camera Source</th>
              <th className="px-4 py-2 text-left">Timestamp</th>
              <th className="px-4 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {history.map((h: any) => (
              <tr key={h.id} className="hover:bg-primary/5 transition-colors">
                <td className="px-4 py-2 font-medium">{getZoneName(h.zoneId)}</td>
                <td className="px-4 py-2 text-muted-foreground">{getCameraName(h.cameraId)}</td>
                <td className="px-4 py-2 text-muted-foreground font-mono">{new Date(h.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td className="px-4 py-2">
                  <Badge variant="outline" className="text-[9px] h-4 px-1.5 leading-none uppercase font-bold">
                    {h.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const PotentialMatches = ({ personId, onSelect, searchScore, currentPersonType }: { personId: number, onSelect: (id: number) => void, searchScore: number, currentPersonType: { name: string, role: string } }) => {
    const threshold = 1.0 - (searchScore / 100);
    
    const { data: matches, isLoading } = trpc.persons.getPotentialMatches.useQuery({ 
      personId,
      threshold
    });

    if (isLoading) return <div className="p-4 text-center text-xs text-muted-foreground animate-pulse">Scanning biometric registry...</div>;
    
    const filteredMatches = matches?.filter((m: any) => {
      if (m.id === personId) return false;
      const isCurrentUnknown = currentPersonType.role.toLowerCase() === "unknown" || currentPersonType.name.toLowerCase().startsWith("unknown-");
      const isMatchUnknown = m.role.toLowerCase() === "unknown" || m.name.toLowerCase().startsWith("unknown-");
      return isCurrentUnknown ? !isMatchUnknown : isMatchUnknown;
    }) || [];

    if (filteredMatches.length === 0) return <div className="p-4 text-center text-[10px] text-muted-foreground italic border border-dashed border-border/40 rounded-lg">No biometric matches found with current score.</div>;

    return (
      <div className="space-y-3">
        <h4 className="text-[10px] uppercase font-bold text-blue-400 flex items-center gap-2">
          <Scan className="w-3 h-3" /> AI Biometric Suggestions
        </h4>
        <div className="grid grid-cols-1 gap-2">
          {filteredMatches.slice(0, 3).map((match: any) => (
            <div key={match.id} className="flex items-center justify-between p-2 rounded-lg bg-blue-500/5 border border-blue-500/20 hover:bg-blue-500/10 transition-colors group">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded overflow-hidden border border-blue-500/30">
                  <img src={match.photoUrl} alt={match.name} className="w-full h-full object-cover" />
                </div>
                <div>
                  <div className="text-xs font-bold text-blue-400">{match.name}</div>
                  <div className="text-[10px] text-muted-foreground">{match.matchScore}% Match Confidence</div>
                </div>
              </div>
              <Button 
                size="sm" 
                variant="ghost" 
                className="h-7 px-2 text-[10px] text-blue-400 hover:text-blue-300 hover:bg-blue-400/10"
                onClick={() => onSelect(match.id)}
              >
                C'est lui
              </Button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Auto-refresh polling
  useEffect(() => {
    if (!isAutoRefresh) return;

    const interval = setInterval(() => {
      refetch();
    }, REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [isAutoRefresh, refetch]);

  const handleViewDetails = (alert: any) => {
    setSelectedAlert(alert);
    setOpen(true);
  };

  const handleUpdateStatus = async (alertId: number, status: string) => {
    try {
      await updateStatusMutation.mutateAsync({ id: alertId, status: status as any });
      toast({
        title: "Status Updated",
        description: `Alert marked as ${status}.`,
      });
      refetch();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to update alert status.",
        variant: "destructive",
      });
      console.error("Error updating alert status:", error);
    }
  };

  const handleAssignExisting = async (directId?: number) => {
    const idToAssign = directId || (selectedPersonId ? parseInt(selectedPersonId) : null);
    if (!idToAssign || !selectedAlert) return;
    try {
      await assignPersonMutation.mutateAsync({
        alertId: selectedAlert.id,
        personId: idToAssign
      });
      toast({ title: "Success", description: "Identity assigned to alert." });
      setOpen(false);
      refetch();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleCreateNewPerson = async () => {
    if (!newPersonName || !selectedAlert) return;
    try {
      const newPerson = await createPersonMutation.mutateAsync({
        name: newPersonName,
        role: newPersonRole,
        photoUrl: selectedAlert.faceSnapshotUrl
      });
      
      const newPersonId = (newPerson as any)?.insertId;
      if (!newPersonId) throw new Error("Could not retrieve new person ID");
      
      // Auto-assign the newly created person
      await assignPersonMutation.mutateAsync({
        alertId: selectedAlert.id,
        personId: newPersonId
      });
      
      toast({ title: "Succès", description: `${newPersonName} a été créé(e) et assigné(e) à cette alerte.` });
      setNewPersonName("");
      setOpen(false);
      refetch();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleUnassign = async () => {
    if (!selectedAlert) return;
    try {
      await unassignPersonMutation.mutateAsync({ alertId: selectedAlert.id });
      toast({ title: "Corrected", description: "Identity removed from alert." });
      setOpen(false);
      refetch();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const threatLevelColor = (level: string) => {
    switch (level) {
      case "low":
        return "threat-low";
      case "medium":
        return "threat-medium";
      case "high":
        return "threat-high";
      case "critical":
        return "threat-critical";
      default:
        return "threat-medium";
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "active":
        return <AlertCircle className="w-4 h-4 text-red-500" />;
      case "acknowledged":
        return <CheckCircle className="w-4 h-4 text-yellow-400" />;
      case "escalated":
        return <AlertTriangle className="w-4 h-4 text-orange-500" />;
      case "dismissed":
        return <CheckCircle className="w-4 h-4 text-green-400" />;
      default:
        return <AlertCircle className="w-4 h-4" />;
    }
  };

  const activeAlerts = alerts?.filter((a: any) => a.status === "active") || [];

  return (
    <div className="space-y-6 p-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-primary">Live Alerts Feed</h1>
          <p className="text-muted-foreground">Real-time detection events and alerts</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={isAutoRefresh ? "default" : "outline"}
            onClick={() => setIsAutoRefresh(!isAutoRefresh)}
            className={isAutoRefresh ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isAutoRefresh ? "animate-spin" : ""}`} />
            {isAutoRefresh ? "Auto-refresh ON" : "Auto-refresh OFF"}
          </Button>
          <Button
            variant="outline"
            onClick={() => refetch()}
            className="gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh Now
          </Button>
        </div>
      </div>

      {/* Filter Bar */}
      <Card className="bg-card/30 backdrop-blur border-border/40">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-muted-foreground mr-2">
              <Filter className="w-4 h-4" />
              <span className="text-sm font-medium uppercase tracking-wider">Filters</span>
            </div>

            {/* Status Filter */}
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Status</Label>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-[140px] h-9 bg-background/50">
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

            {/* Zone Filter */}
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Zone</Label>
              <Select value={filterZoneId} onValueChange={setFilterZoneId}>
                <SelectTrigger className="w-[160px] h-9 bg-background/50">
                  <SelectValue placeholder="All Zones" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Zones</SelectItem>
                  {zonesList?.map(z => (
                    <SelectItem key={z.id} value={String(z.id)}>{z.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Person Autocomplete Filter */}
            <div className="space-y-1.5 relative">
              <Label className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Person / Name</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60 pointer-events-none" />
                <Input
                  id="filter-person-autocomplete"
                  className="w-[200px] h-9 pl-8 bg-background/50 text-sm"
                  placeholder="Search name..."
                  value={personFilterQuery}
                  onChange={e => {
                    setPersonFilterQuery(e.target.value);
                    setFilterPersonId("all");
                    setPersonFilterOpen(true);
                  }}
                  onFocus={() => setPersonFilterOpen(true)}
                  onBlur={() => setTimeout(() => setPersonFilterOpen(false), 150)}
                  autoComplete="off"
                />
                {filterPersonId !== "all" && (
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                    onClick={() => { setFilterPersonId("all"); setPersonFilterQuery(""); }}
                  ><X className="w-3 h-3" /></button>
                )}
              </div>
              {/* Dropdown */}
              {personFilterOpen && (
                <div className="absolute z-50 top-full left-0 mt-1 w-[250px] max-h-[220px] overflow-y-auto rounded-lg border border-border/60 bg-card shadow-xl backdrop-blur">
                  <div
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 text-xs text-muted-foreground border-b border-border/30"
                    onMouseDown={() => { setFilterPersonId("all"); setPersonFilterQuery(""); setPersonFilterOpen(false); }}
                  >
                    All Identities
                  </div>
                  {personsList
                    ?.filter(p => p.name.toLowerCase().includes(personFilterQuery.toLowerCase()))
                    .slice(0, 12)
                    .map(p => (
                      <div
                        key={p.id}
                        className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-primary/10 transition-colors ${
                          filterPersonId === String(p.id) ? "bg-primary/15" : ""
                        }`}
                        onMouseDown={() => {
                          setFilterPersonId(String(p.id));
                          setPersonFilterQuery(p.name);
                          setPersonFilterOpen(false);
                        }}
                      >
                        <div className="w-7 h-7 rounded overflow-hidden bg-muted flex-shrink-0 border border-border/40">
                          {p.photoUrl
                            ? <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover" />
                            : <User className="w-full h-full p-1.5 text-muted-foreground/50" />}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold truncate">{p.name}</div>
                          <div className="text-[9px] text-muted-foreground uppercase">{p.role}</div>
                        </div>
                        {filterPersonId === String(p.id) && <CheckCircle className="w-3.5 h-3.5 text-primary ml-auto" />}
                      </div>
                    ))
                  }
                  {personsList?.filter(p => p.name.toLowerCase().includes(personFilterQuery.toLowerCase())).length === 0 && (
                    <div className="px-3 py-4 text-center text-xs text-muted-foreground italic">No match found</div>
                  )}
                </div>
              )}
            </div>

            {/* Date / Time Filter */}
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Date Range</Label>
              <div className="flex items-center gap-1.5">
                {/* Quick presets */}
                <div className="flex gap-1">
                  {(["1h","24h","7d","30d"] as const).map(preset => (
                    <button
                      key={preset}
                      onClick={() => {
                        setFilterTimeRange(filterTimeRange === preset ? "all" : preset);
                        setFilterDateFrom("");
                        setFilterDateTo("");
                      }}
                      className={`h-9 px-2.5 rounded text-[10px] font-bold uppercase tracking-wide border transition-colors ${
                        filterTimeRange === preset && !filterDateFrom
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background/50 border-border/50 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                {/* Custom date from */}
                <div className="relative">
                  <input
                    type="datetime-local"
                    value={filterDateFrom}
                    onChange={e => { setFilterDateFrom(e.target.value); setFilterTimeRange("all"); }}
                    className="h-9 px-2 rounded border border-border/50 bg-background/50 text-xs text-foreground focus:outline-none focus:border-primary/60 w-[155px]"
                    title="From date"
                  />
                  {filterDateFrom && (
                    <button onClick={() => setFilterDateFrom("")}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                    ><X className="w-3 h-3" /></button>
                  )}
                </div>
                <span className="text-muted-foreground text-xs">→</span>
                {/* Custom date to */}
                <div className="relative">
                  <input
                    type="datetime-local"
                    value={filterDateTo}
                    onChange={e => { setFilterDateTo(e.target.value); setFilterTimeRange("all"); }}
                    className="h-9 px-2 rounded border border-border/50 bg-background/50 text-xs text-foreground focus:outline-none focus:border-primary/60 w-[155px]"
                    title="To date"
                  />
                  {filterDateTo && (
                    <button onClick={() => setFilterDateTo("")}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                    ><X className="w-3 h-3" /></button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex-1" />

            {(filterStatus !== "all" || filterZoneId !== "all" || filterPersonId !== "all" || filterTimeRange !== "all" || filterDateFrom || filterDateTo) && (
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => {
                  setFilterStatus("all");
                  setFilterZoneId("all");
                  setFilterPersonId("all");
                  setFilterTimeRange("all");
                  setFilterDateFrom("");
                  setFilterDateTo("");
                  setPersonFilterQuery("");
                }}
                className="h-9 px-3 text-muted-foreground hover:text-primary transition-colors"
              >
                <X className="w-4 h-4 mr-2" />
                Reset
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle>Active Detections</CardTitle>
          <CardDescription>
            {activeAlerts.length} active alert{activeAlerts.length !== 1 ? "s" : ""} • Auto-refreshing every {REFRESH_INTERVAL / 1000}s
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center gap-4 p-4 rounded border border-border/50 bg-card/30">
                  <Skeleton className="w-16 h-16 rounded flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                  <div className="w-16 flex flex-col items-end gap-2">
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-8 w-8 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : alerts && alerts.length > 0 ? (
            <div className="space-y-3 max-h-[600px] overflow-y-auto">
              {alerts.map((alert: any) => (
                <div
                  key={alert.id}
                  className={`flex items-center gap-4 p-4 rounded border transition-colors cursor-pointer ${
                    alert.person?.isBlacklisted
                      ? "bg-red-500/10 border-red-500/50 hover:bg-red-500/20 shadow-[0_0_15px_rgba(239,68,68,0.1)]"
                      : (alert.metadata as any)?.multiPersonFrame
                      ? "bg-red-900/20 border-red-700/60 hover:bg-red-900/30 shadow-[0_0_12px_rgba(220,38,38,0.08)]"
                      : "bg-card/50 border-border/50 hover:border-primary/50 hover:bg-card/80"
                  }`}
                  onClick={() => handleViewDetails(alert)}
                >
                  {/* Face Thumbnail */}
                  <div className="w-16 h-16 rounded bg-muted flex items-center justify-center flex-shrink-0">
                    {alert.faceSnapshotUrl ? (
                      <img src={alert.faceSnapshotUrl} alt="Face" className="w-full h-full object-cover rounded" />
                    ) : (
                      <AlertCircle className="w-8 h-8 text-muted-foreground" />
                    )}
                  </div>

                  {/* Alert Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {statusIcon(alert.status)}
                      <span className={`font-medium data-value ${alert.person?.isBlacklisted ? "text-red-500 font-bold" : ""}`}>
                        {getPersonName(alert.personId)}
                      </span>
                      {alert.person?.isBlacklisted && (
                        <Badge variant="destructive" className="text-[10px] h-4 px-1 animate-pulse">
                          BLACKLISTED
                        </Badge>
                      )}
                      <Badge className={`${threatLevelColor(alert.threatLevel)} text-xs`}>
                        {alert.threatLevel}
                      </Badge>
                      {(alert.metadata as any)?.multiPersonFrame && (
                        <Badge className="bg-red-600 text-white text-[10px] font-bold px-1.5 py-0 flex items-center gap-1">
                          <Users className="w-3 h-3" /> Multiple Persons
                        </Badge>
                      )}
                      {alert.status === "active" && (
                        <div className="status-pulse w-2 h-2 rounded-full bg-red-500 ml-auto" />
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {getCameraName(alert.cameraId)} • {getZoneName(alert.zoneId)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(alert.timestamp).toLocaleString()}
                    </p>
                  </div>

                  {/* Confidence & Actions */}
                  <div className="text-right flex-shrink-0">
                    <div className="text-lg font-bold data-value text-primary mb-2">
                      {alert.confidence}%
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleViewDetails(alert);
                      }}
                      className="text-primary hover:text-primary hover:bg-primary/10"
                    >
                      <Eye className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No active alerts. System is monitoring...
            </div>
          )}
        </CardContent>
      </Card>

      {/* Alert Detail Modal - Full Screen Overlay */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-card border-border max-w-[98vw] sm:max-w-[98vw] max-h-[98vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Alert Details</DialogTitle>
            <DialogDescription>Full event information and actions</DialogDescription>
          </DialogHeader>
          {selectedAlert && (
            <div className="space-y-6">
              {/* Content Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                {/* Left Column: Visuals (Snapshots) */}
                <div className="lg:col-span-4 space-y-6">
                  <div>
                    <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                      <Video className="w-4 h-4 text-primary" /> Best Frame Capture
                    </h3>
                    {(selectedAlert.metadata as any)?.multiPersonFrame && (
                      <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-red-600/20 border border-red-500/50 text-red-400 text-xs font-bold uppercase tracking-wide">
                        <Users className="w-4 h-4 flex-shrink-0" />
                        Multiple Persons Detected in Frame
                      </div>
                    )}
                    <div className="w-full aspect-video rounded-xl border border-border/50 bg-black flex items-center justify-center overflow-hidden shadow-2xl group relative">
                      {selectedAlert.bestFrameSnapshotUrl ? (
                        <img src={selectedAlert.bestFrameSnapshotUrl} alt="Best Frame" className="w-full h-full object-contain" />
                      ) : (
                        <div className="flex flex-col items-center gap-2">
                          <AlertCircle className="w-12 h-12 text-muted-foreground opacity-20" />
                          <span className="text-xs text-muted-foreground">No frame capture available</span>
                        </div>
                      )}
                      <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur px-2 py-1 rounded text-[10px] text-white opacity-0 group-hover:opacity-100 transition-opacity">
                        Full Frame Resolution
                      </div>
                    </div>

                    {/* Auto multi-person face crops */}
                    {(() => {
                      const meta = selectedAlert.metadata as any;
                      const urls: string[] = meta?.detectedFaceUrls ?? [];
                      const count: number  = meta?.faceCount ?? 0;
                      if (!meta) return null;
                      return (
                        <div className="mt-2 space-y-2">
                          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wide ${
                            count > 1
                              ? "bg-red-600/20 border border-red-600/50 text-red-400"
                              : count === 1
                              ? "bg-green-600/20 border border-green-500/50 text-green-400"
                              : "bg-yellow-600/20 border border-yellow-500/50 text-yellow-400"
                          }`}>
                            <Users className="w-4 h-4 flex-shrink-0" />
                            {count === 0 ? "No face detected in frame" : count === 1 ? "1 person in frame" : `${count} persons detected in frame`}
                          </div>
                          {urls.length > 0 && (
                            <div>
                              <p className="text-[10px] uppercase font-bold text-muted-foreground mb-1.5">Detected Faces</p>
                              <div className="flex flex-wrap gap-2">
                                {urls.map((url, i) => (
                                  <div key={i} className="w-16 h-16 rounded border border-red-500/40 overflow-hidden bg-muted flex-shrink-0">
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
                        {selectedAlert.faceSnapshotUrl ? (
                          <img src={selectedAlert.faceSnapshotUrl} alt="Face Crop" className="w-full h-full object-cover" />
                        ) : (
                          <AlertCircle className="w-8 h-8 text-muted-foreground" />
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col justify-end">
                      <div className="p-4 rounded-xl border border-border/50 bg-card/50">
                        <h3 className="text-sm font-medium mb-2">Confidence</h3>
                        <div className="flex items-center gap-3">
                          <div className="flex-1">
                            <div className="w-full h-3 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-r from-primary to-secondary"
                                style={{ width: `${selectedAlert.confidence}%` }}
                              />
                            </div>
                          </div>
                          <span className="text-xl font-bold data-value text-primary">{selectedAlert.confidence}%</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Middle Column: Event Data */}
                <div className="lg:col-span-3 space-y-6">
                  <div className="p-6 rounded-xl border border-border/50 bg-card/50 space-y-6">
                    <div className="flex items-center justify-between gap-4">
                      {selectedAlert.personId ? (
                        <WouterLink href={`/persons/${selectedAlert.personId}`} className="flex items-center gap-4 hover:opacity-80 transition-opacity group">
                          <div className="w-16 h-16 rounded-full bg-primary/10 border-2 border-primary/20 overflow-hidden flex-shrink-0 flex items-center justify-center group-hover:border-primary/50 transition-colors">
                            {getPersonPhoto(selectedAlert.personId) ? (
                              <img src={getPersonPhoto(selectedAlert.personId)!} alt="Registry" className="w-full h-full object-cover" />
                            ) : (
                              <User className="w-8 h-8 text-primary" />
                            )}
                          </div>
                          <div>
                            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Identified As</h3>
                            <p className="text-2xl font-bold data-value text-primary group-hover:underline decoration-primary/30">
                              {getPersonName(selectedAlert.personId)}
                            </p>
                            <Badge variant="secondary" className="mt-1">{getPersonRole(selectedAlert.personId)}</Badge>
                          </div>
                        </WouterLink>
                      ) : (
                        <div className="flex items-center gap-4">
                          <div className="w-16 h-16 rounded-full bg-primary/10 border-2 border-primary/20 overflow-hidden flex-shrink-0 flex items-center justify-center">
                            <User className="w-8 h-8 text-primary" />
                          </div>
                          <div>
                            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Identified As</h3>
                            <p className="text-2xl font-bold data-value text-primary">
                              Unknown
                            </p>
                          </div>
                        </div>
                      )}
                      {selectedAlert.personId && (
                        <Button 
                          variant="destructive" 
                          size="sm" 
                          onClick={handleUnassign}
                          className="h-8 px-2 text-[10px] uppercase font-bold"
                        >
                          Not Him
                        </Button>
                      )}
                    </div>

                    <hr className="border-border/50" />

                    <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Camera Source</label>
                        <p className="text-sm font-bold data-value">{getCameraName(selectedAlert.cameraId)}</p>
                        <p className="text-[10px] text-muted-foreground italic">{getCameraLocation(selectedAlert.cameraId)}</p>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Security Zone</label>
                        <p className="text-sm font-bold data-value text-secondary">{getZoneName(selectedAlert.zoneId)}</p>
                        <p className="text-[10px] text-muted-foreground italic">{getZoneDescription(selectedAlert.zoneId)}</p>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Threat Assessment</label>
                        <Badge className={`${threatLevelColor(selectedAlert.threatLevel)} uppercase text-[10px] font-bold px-2 py-0.5`}>
                          {selectedAlert.threatLevel}
                        </Badge>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Workflow Status</label>
                        <Badge variant="outline" className="uppercase text-[10px] font-bold px-2 py-0.5">{selectedAlert.status}</Badge>
                      </div>
                    </div>

                    <hr className="border-border/50" />

                    <div className="space-y-4">
                      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Activity Logs</h3>
                      <div className="max-h-40 overflow-y-auto rounded-lg border border-border/30 bg-black/20">
                        <AlertLogs logs={selectedAlert.logs} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column: History Sidebar */}
                <div className="lg:col-span-5 border border-border/50 rounded-xl bg-card/30 overflow-hidden flex flex-col shadow-inner">
                  <div className="p-4 border-b border-border/50 bg-muted/30 flex items-center justify-between">
                    <h3 className="text-sm font-bold flex items-center gap-2 uppercase tracking-tight">
                      <History className="w-4 h-4 text-muted-foreground" /> Full Detection History
                    </h3>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {selectedAlert.personId ? (
                      <HistoryTable personId={selectedAlert.personId} getZoneName={getZoneName} getCameraName={getCameraName} />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full p-8 text-center gap-3">
                        <UserPlus className="w-8 h-8 text-muted-foreground opacity-20" />
                        <p className="text-xs text-muted-foreground italic leading-relaxed">
                          History is unavailable for anonymous detections.<br />Resolve identity to link records.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Identity Assignment (For Unknowns or manually unassigned) */}
              {(!selectedAlert.personId || 
                getPersonName(selectedAlert.personId).toLowerCase().includes("unknown") || 
                getPersonRole(selectedAlert.personId) === "UNKNOWN") && (
                <div className="p-6 rounded-xl border border-blue-500/30 bg-blue-500/5 shadow-lg shadow-blue-500/5 animate-in fade-in slide-in-from-bottom-4">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-sm font-bold text-blue-400 flex items-center gap-2 uppercase tracking-tight">
                      <Sparkles className="w-4 h-4" /> Resolve Identity Workflow
                    </h3>
                    
                    <div className="flex items-center gap-4">
                      <div className="flex flex-col items-end gap-1.5 min-w-[140px]">
                        <div className="flex justify-between w-full px-1">
                          <span className="text-[10px] uppercase text-muted-foreground font-bold">Sensitivity</span>
                          <span className="text-[10px] font-mono text-blue-400 font-bold">{searchScore}%</span>
                        </div>
                        <Slider 
                          value={[searchScore]} 
                          onValueChange={(vals) => setSearchScore(vals[0])}
                          max={100}
                          step={5}
                          className="w-32"
                        />
                      </div>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
                    {/* Option 0: AI Suggestions */}
                    <div className="xl:col-span-1 border-r border-border/50 pr-8">
                      {selectedAlert.personId ? (
                        <PotentialMatches 
                          personId={selectedAlert.personId} 
                          onSelect={(id) => handleAssignExisting(id)} 
                          searchScore={searchScore}
                          currentPersonType={{
                            name: getPersonName(selectedAlert.personId),
                            role: getPersonRole(selectedAlert.personId) || "UNKNOWN"
                          }}
                        />
                      ) : (
                        <div className="text-center py-8 text-xs text-muted-foreground italic">
                          Biometric analysis is pending...
                        </div>
                      )}
                    </div>

                    {/* Option 1: Assign Existing (Searchable List) */}
                    <div className="space-y-4 xl:col-span-1">
                      <h4 className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-2">
                        <LinkIcon className="w-3 h-3" /> Link to Registry
                      </h4>
                      
                      <div className="space-y-3">
                        <div className="relative">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60" />
                          <Input 
                            placeholder="Search names..." 
                            className="h-8 pl-8 text-xs bg-background/50"
                            value={personSearchQuery}
                            onChange={(e) => setPersonSearchQuery(e.target.value)}
                          />
                        </div>
                        
                        <div className="max-h-[180px] overflow-y-auto border border-border/40 rounded-lg bg-background/30 p-1 space-y-1 scrollbar-thin">
                          {personsList?.filter(p => {
                            if (p.id === selectedAlert.personId) return false;
                            
                            const curRole = (getPersonRole(selectedAlert.personId) || "UNKNOWN").toLowerCase();
                            const curName = getPersonName(selectedAlert.personId).toLowerCase();
                            const isCurrentUnknown = curRole === "unknown" || curName.startsWith("unknown-");
                            
                            const targetRole = p.role.toLowerCase();
                            const targetName = p.name.toLowerCase();
                            const isTargetUnknown = targetRole === "unknown" || targetName.startsWith("unknown-");
                            
                            const matchesLogic = isCurrentUnknown ? !isTargetUnknown : isTargetUnknown;
                            const matchesSearch = targetName.includes(personSearchQuery.toLowerCase());
                            
                            return matchesLogic && matchesSearch;
                          }).slice(0, 10).map(p => (
                            <div 
                              key={p.id} 
                              className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${selectedPersonId === String(p.id) ? 'bg-primary/20 border border-primary/30' : 'hover:bg-muted/50 border border-transparent'}`}
                              onClick={() => setSelectedPersonId(String(p.id))}
                            >
                              <div className="flex items-center gap-2 overflow-hidden">
                                <div className="w-7 h-7 rounded overflow-hidden bg-muted flex-shrink-0 border border-border/50">
                                  {p.photoUrl ? (
                                    <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover" />
                                  ) : (
                                    <User className="w-full h-full p-1.5 text-muted-foreground/50" />
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <div className="text-[11px] font-bold truncate">{p.name}</div>
                                  <div className="text-[9px] text-muted-foreground uppercase">{p.role}</div>
                                </div>
                              </div>
                              {selectedPersonId === String(p.id) && <CheckCircle className="w-3.5 h-3.5 text-primary" />}
                            </div>
                          ))}
                          {(!personsList || personsList.length === 0) && (
                            <div className="py-4 text-center text-[10px] text-muted-foreground italic">No candidates found.</div>
                          )}
                        </div>
                        
                        <Button 
                          onClick={() => handleAssignExisting()} 
                          disabled={!selectedPersonId} 
                          className="w-full h-9 bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          <LinkIcon className="w-4 h-4 mr-2" /> Assign Identity
                        </Button>
                      </div>
                    </div>

                    {/* Option 2: Create New */}
                    <div className="space-y-4 border-l border-border/50 pl-8">
                      <h4 className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-2">
                        <UserPlus className="w-3 h-3" /> Register as New Person
                      </h4>
                      <div className="space-y-3 pt-1">
                        <div className="space-y-1">
                          <Label className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Full Name</Label>
                          <Input 
                            value={newPersonName} 
                            onChange={e => setNewPersonName(e.target.value)} 
                            placeholder="e.g. John Doe" 
                            className="h-9 bg-background/50"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Initial Role</Label>
                          <Input 
                            value={newPersonRole} 
                            onChange={e => setNewPersonRole(e.target.value)} 
                            placeholder="e.g. staff, visitor" 
                            className="h-9 bg-background/50"
                          />
                        </div>
                        <Button onClick={handleCreateNewPerson} disabled={!newPersonName} variant="secondary" className="w-full h-9 mt-2">
                          <UserPlus className="w-4 h-4 mr-2" /> Register & Assign
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}



              {/* Actions */}
              <div className="flex gap-2 pt-4 border-t border-border/50">
                {selectedAlert.status === "active" && (
                  <>
                    <Button
                      onClick={() => handleUpdateStatus(selectedAlert.id, "acknowledged")}
                      className="bg-yellow-600 hover:bg-yellow-700 text-white"
                    >
                      Acknowledge
                    </Button>
                    <Button
                      onClick={() => handleUpdateStatus(selectedAlert.id, "escalated")}
                      className="bg-red-600 hover:bg-red-700 text-white"
                    >
                      Escalate
                    </Button>
                  </>
                )}
                <Button
                  onClick={() => handleUpdateStatus(selectedAlert.id, "dismissed")}
                  variant="outline"
                >
                  Dismiss
                </Button>
                {relatedMovement && (
                  <WouterLink href={`/movements?alertId=${selectedAlert.id}`}>
                    <Button variant="outline" className="gap-2 border-orange-500/50 text-orange-400 hover:bg-orange-500/10 hover:border-orange-500" onClick={() => setOpen(false)}>
                      <Clapperboard className="w-4 h-4" />
                      View Motion #{relatedMovement.id}
                    </Button>
                  </WouterLink>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
