import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle, AlertTriangle, Eye, RefreshCw, User, Filter, X, Users } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Search } from "lucide-react";

const REFRESH_INTERVAL = 5000;

export default function LiveAlertsFeed() {
  const [, setLocation] = useLocation();
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);

  const [filterStatus,    setFilterStatus]    = useState<string>("all");
  const [filterZoneId,    setFilterZoneId]    = useState<string>("all");
  const [filterPersonId,  setFilterPersonId]  = useState<string>("all");
  const [filterTimeRange, setFilterTimeRange] = useState<string>("all");
  const [filterDateFrom,  setFilterDateFrom]  = useState<string>("");
  const [filterDateTo,    setFilterDateTo]    = useState<string>("");
  const [personFilterQuery, setPersonFilterQuery] = useState("");
  const [personFilterOpen,  setPersonFilterOpen]  = useState(false);

  const getStartDate = () => {
    if (filterDateFrom) return new Date(filterDateFrom).toISOString();
    if (filterTimeRange === "all") return undefined;
    const now = new Date();
    switch (filterTimeRange) {
      case "1h":  now.setHours(now.getHours() - 1);  break;
      case "24h": now.setHours(now.getHours() - 24); break;
      case "7d":  now.setDate(now.getDate() - 7);     break;
      case "30d": now.setDate(now.getDate() - 30);    break;
    }
    return now.toISOString();
  };

  const getEndDate = () => filterDateTo ? new Date(filterDateTo).toISOString() : undefined;

  const { data: alerts, isLoading, refetch } = trpc.alerts.list.useQuery({
    limit:    50,
    status:   filterStatus   !== "all" ? filterStatus   : undefined,
    zoneId:   filterZoneId   !== "all" ? parseInt(filterZoneId)   : undefined,
    personId: filterPersonId !== "all" ? parseInt(filterPersonId) : undefined,
    startDate: getStartDate(),
  });
  const { data: personsList } = trpc.persons.list.useQuery();
  const { data: camerasList } = trpc.cameras.list.useQuery();
  const { data: zonesList }   = trpc.zones.list.useQuery();

  const getCameraName = (id: number) => camerasList?.find((c: any) => c.id === id)?.name ?? `Camera #${id}`;
  const getZoneName   = (id: number) => zonesList?.find((z: any)   => z.id === id)?.name ?? `Zone #${id}`;
  const getPersonName = (id: number | null) => id ? (personsList?.find((p: any) => p.id === id)?.name ?? `Person #${id}`) : "Unknown";
  const getPersonRole = (id: number | null) => id ? (personsList?.find((p: any) => p.id === id)?.role ?? "staff") : null;

  useEffect(() => {
    if (!isAutoRefresh) return;
    const interval = setInterval(() => refetch(), REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [isAutoRefresh, refetch]);

  const threatLevelColor = (level: string) => {
    switch (level) {
      case "low":      return "threat-low";
      case "medium":   return "threat-medium";
      case "high":     return "threat-high";
      case "critical": return "threat-critical";
      default:         return "threat-medium";
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "active":       return <AlertCircle  className="w-4 h-4 text-red-500" />;
      case "acknowledged": return <CheckCircle  className="w-4 h-4 text-yellow-400" />;
      case "escalated":    return <AlertTriangle className="w-4 h-4 text-orange-500" />;
      case "dismissed":    return <CheckCircle  className="w-4 h-4 text-green-400" />;
      default:             return <AlertCircle  className="w-4 h-4" />;
    }
  };

  const activeAlerts = alerts?.filter((a: any) => a.status === "active") || [];

  return (
    <div className="space-y-6 p-8">
      {/* Header */}
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
          <Button variant="outline" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh Now
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
                  className="w-[200px] h-9 pl-8 bg-background/50 text-sm"
                  placeholder="Search name..."
                  value={personFilterQuery}
                  onChange={e => { setPersonFilterQuery(e.target.value); setFilterPersonId("all"); setPersonFilterOpen(true); }}
                  onFocus={() => setPersonFilterOpen(true)}
                  onBlur={() => setTimeout(() => setPersonFilterOpen(false), 150)}
                  autoComplete="off"
                />
                {filterPersonId !== "all" && (
                  <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                    onClick={() => { setFilterPersonId("all"); setPersonFilterQuery(""); }}>
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              {personFilterOpen && (
                <div className="absolute z-50 top-full left-0 mt-1 w-[250px] max-h-[220px] overflow-y-auto rounded-lg border border-border/60 bg-card shadow-xl backdrop-blur">
                  <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 text-xs text-muted-foreground border-b border-border/30"
                    onMouseDown={() => { setFilterPersonId("all"); setPersonFilterQuery(""); setPersonFilterOpen(false); }}>
                    All Identities
                  </div>
                  {personsList?.filter(p => p.name.toLowerCase().includes(personFilterQuery.toLowerCase())).slice(0, 12).map(p => (
                    <div key={p.id}
                      className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-primary/10 transition-colors ${filterPersonId === String(p.id) ? "bg-primary/15" : ""}`}
                      onMouseDown={() => { setFilterPersonId(String(p.id)); setPersonFilterQuery(p.name); setPersonFilterOpen(false); }}>
                      <div className="w-7 h-7 rounded overflow-hidden bg-muted flex-shrink-0 border border-border/40">
                        {p.photoUrl ? <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover" /> : <User className="w-full h-full p-1.5 text-muted-foreground/50" />}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold truncate">{p.name}</div>
                        <div className="text-[9px] text-muted-foreground uppercase">{p.role}</div>
                      </div>
                      {filterPersonId === String(p.id) && <CheckCircle className="w-3.5 h-3.5 text-primary ml-auto" />}
                    </div>
                  ))}
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
                <div className="flex gap-1">
                  {(["1h","24h","7d","30d"] as const).map(preset => (
                    <button key={preset}
                      onClick={() => { setFilterTimeRange(filterTimeRange === preset ? "all" : preset); setFilterDateFrom(""); setFilterDateTo(""); }}
                      className={`h-9 px-2.5 rounded text-[10px] font-bold uppercase tracking-wide border transition-colors ${
                        filterTimeRange === preset && !filterDateFrom
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background/50 border-border/50 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                      }`}>
                      {preset}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <input type="datetime-local" value={filterDateFrom}
                    onChange={e => { setFilterDateFrom(e.target.value); setFilterTimeRange("all"); }}
                    className="h-9 px-2 rounded border border-border/50 bg-background/50 text-xs text-foreground focus:outline-none focus:border-primary/60 w-[155px]" />
                  {filterDateFrom && (
                    <button onClick={() => setFilterDateFrom("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <span className="text-muted-foreground text-xs">→</span>
                <div className="relative">
                  <input type="datetime-local" value={filterDateTo}
                    onChange={e => { setFilterDateTo(e.target.value); setFilterTimeRange("all"); }}
                    className="h-9 px-2 rounded border border-border/50 bg-background/50 text-xs text-foreground focus:outline-none focus:border-primary/60 w-[155px]" />
                  {filterDateTo && (
                    <button onClick={() => setFilterDateTo("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex-1" />

            {(filterStatus !== "all" || filterZoneId !== "all" || filterPersonId !== "all" || filterTimeRange !== "all" || filterDateFrom || filterDateTo) && (
              <Button variant="ghost" size="sm"
                onClick={() => { setFilterStatus("all"); setFilterZoneId("all"); setFilterPersonId("all"); setFilterTimeRange("all"); setFilterDateFrom(""); setFilterDateTo(""); setPersonFilterQuery(""); }}
                className="h-9 px-3 text-muted-foreground hover:text-primary transition-colors">
                <X className="w-4 h-4 mr-2" /> Reset
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Alert list */}
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
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex items-center gap-4 p-4 rounded border border-border/50 bg-card/30">
                  <Skeleton className="w-16 h-16 rounded flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                  <Skeleton className="h-8 w-8 rounded-full" />
                </div>
              ))}
            </div>
          ) : alerts && alerts.length > 0 ? (
            <div className="space-y-3 max-h-[600px] overflow-y-auto">
              {alerts.map((alert: any) => (
                <div key={alert.id}
                  className={`flex items-center gap-4 p-4 rounded border transition-colors cursor-pointer ${
                    alert.person?.isBlacklisted
                      ? "bg-red-500/10 border-red-500/50 hover:bg-red-500/20 shadow-[0_0_15px_rgba(239,68,68,0.1)]"
                      : (alert.metadata as any)?.multiPersonFrame
                      ? "bg-red-900/20 border-red-700/60 hover:bg-red-900/30 shadow-[0_0_12px_rgba(220,38,38,0.08)]"
                      : "bg-card/50 border-border/50 hover:border-primary/50 hover:bg-card/80"
                  }`}
                  onClick={() => setLocation(`/alerts/${alert.id}`)}>

                  {/* Face Thumbnail */}
                  <div className="w-16 h-16 rounded bg-muted flex items-center justify-center flex-shrink-0">
                    {alert.faceSnapshotUrl
                      ? <img src={alert.faceSnapshotUrl} alt="Face" className="w-full h-full object-cover rounded" />
                      : <AlertCircle className="w-8 h-8 text-muted-foreground" />}
                  </div>

                  {/* Alert Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {statusIcon(alert.status)}
                      <span className={`font-medium data-value ${alert.person?.isBlacklisted ? "text-red-500 font-bold" : ""}`}>
                        {getPersonName(alert.personId)}
                      </span>
                      {alert.person?.isBlacklisted && (
                        <Badge variant="destructive" className="text-[10px] h-4 px-1 animate-pulse">BLACKLISTED</Badge>
                      )}
                      <Badge className={`${threatLevelColor(alert.threatLevel)} text-xs`}>{alert.threatLevel}</Badge>
                      {(alert.metadata as any)?.multiPersonFrame && (
                        <Badge className="bg-red-600 text-white text-[10px] font-bold px-1.5 py-0 flex items-center gap-1">
                          <Users className="w-3 h-3" /> Multiple Persons
                        </Badge>
                      )}
                      {alert.status === "active" && <div className="status-pulse w-2 h-2 rounded-full bg-red-500 ml-auto" />}
                    </div>
                    <p className="text-sm text-muted-foreground">{getCameraName(alert.cameraId)} • {getZoneName(alert.zoneId)}</p>
                    <p className="text-xs text-muted-foreground">{new Date(alert.timestamp).toLocaleString()}</p>
                  </div>

                  {/* Confidence + Eye */}
                  <div className="text-right flex-shrink-0">
                    {(alert.metadata as any)?.bodyOnlyDetection ? (
                      <Badge className="bg-orange-500/20 border border-orange-500/50 text-orange-400 text-[10px] font-bold uppercase mb-2 px-2 py-1">
                        NO FACE
                      </Badge>
                    ) : (
                      <div className="text-lg font-bold data-value text-primary mb-2">{alert.confidence}%</div>
                    )}
                    <Button size="sm" variant="ghost"
                      onClick={e => { e.stopPropagation(); setLocation(`/alerts/${alert.id}`); }}
                      className="text-primary hover:text-primary hover:bg-primary/10">
                      <Eye className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">No active alerts. System is monitoring...</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
