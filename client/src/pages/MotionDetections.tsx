import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { RefreshCw, Film, Users, AlertCircle, X, Filter, User, Users2 } from "lucide-react";

const REFRESH_INTERVAL = 10000;

function MovementCard({ mov, cameraName, zoneName, onClick }: {
  mov: any; cameraName: string; zoneName: string; onClick: () => void;
}) {
  const frames: string[] = (mov.frameUrls ?? []).slice().sort((a: string, b: string) => {
    const tsOf = (u: string) => { const m = u.match(/clip_(\d{13})_/); return m ? parseInt(m[1]) : 0; };
    return tsOf(a) - tsOf(b) || a.localeCompare(b);
  });
  const isMulti = (mov.faceCount ?? 0) > 1;
  const hasAlert = !!mov.alertId;
  const dt: string = mov.detectionType ?? "MOTION";

  const dtBadge = dt === "FACE"
    ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-600/80 text-white">👤 Face</span>
    : dt === "BODY"
    ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-600/80 text-white">🚶 Body</span>
    : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground">🎥 Motion</span>;

  return (
    <div
      className={`rounded-xl border overflow-hidden cursor-pointer transition-all hover:scale-[1.01] ${
        isMulti ? "border-red-600/50 bg-red-950/20" : "border-border/40 bg-card/60"
      }`}
      onClick={onClick}
    >
      <div className="relative aspect-video bg-black overflow-hidden">
        {mov.bestFrameUrl
          ? <img src={mov.bestFrameUrl} alt="Best frame" className="w-full h-full object-cover" />
          : frames.length > 0
          ? <img src={frames[0]} alt="Preview" className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center"><Film className="w-8 h-8 text-muted-foreground/20" /></div>
        }
        {mov.faceCropUrl && (
          <div className="absolute bottom-1.5 left-1.5 w-10 h-10 rounded border-2 border-primary/70 overflow-hidden bg-black shadow-lg">
            <img src={mov.faceCropUrl} alt="Face" className="w-full h-full object-cover" />
          </div>
        )}
        <div className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1">
          <Film className="w-2.5 h-2.5" /> {frames.length} frames
        </div>
        {isMulti && (
          <div className="absolute top-1.5 right-1.5 bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1">
            <Users className="w-2.5 h-2.5" /> {mov.faceCount}
          </div>
        )}
        {hasAlert && (
          <div className="absolute bottom-1.5 right-1.5 bg-orange-500/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
            Alert #{mov.alertId}
          </div>
        )}
      </div>
      <div className="p-2.5 space-y-1">
        <div className="flex items-center justify-between gap-1">
          <div className="text-[11px] font-bold truncate">{cameraName}</div>
          {dtBadge}
        </div>
        <div className="text-[10px] text-muted-foreground">{zoneName}</div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-muted-foreground/70">
            {new Date(mov.timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
          </span>
          <Badge variant={hasAlert ? "default" : "outline"} className="text-[9px] h-4 px-1.5">
            {hasAlert ? "Alert" : "No alert"}
          </Badge>
        </div>
      </div>
    </div>
  );
}

type Tab = "MOTION" | "FACE" | "BODY";

export default function MotionDetections() {
  const [, setLocation]   = useLocation();
  const [tab, setTab]     = useState<Tab>("MOTION");
  const [filterCamera, setFilterCamera] = useState("all");
  const [filterZone,   setFilterZone]   = useState("all");
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);

  const { data: allMovements } = trpc.movements.list.useQuery({ limit: 500 });

  const { data: movList, isLoading, refetch } = trpc.movements.list.useQuery({
    limit:         200,
    cameraId:      filterCamera !== "all" ? parseInt(filterCamera) : undefined,
    zoneId:        filterZone   !== "all" ? parseInt(filterZone)   : undefined,
    detectionType: tab === "MOTION" ? undefined : (tab as any),
  });

  const { data: camerasList } = trpc.cameras.list.useQuery();
  const { data: zonesList }   = trpc.zones.list.useQuery();

  const getCameraName = (id: number) => camerasList?.find((c: any) => c.id === id)?.name ?? `Camera #${id}`;
  const getZoneName   = (id: number) => zonesList?.find((z: any)   => z.id === id)?.name ?? `Zone #${id}`;

  useEffect(() => {
    if (!isAutoRefresh) return;
    const t = setInterval(() => refetch(), REFRESH_INTERVAL);
    return () => clearInterval(t);
  }, [isAutoRefresh, refetch]);

  const countForTab = (key: string) => {
    if (!allMovements) return "…";
    if (key === "MOTION") return allMovements.length;
    return allMovements.filter((m: any) => m.detectionType === key).length;
  };

  const statsRow = () => {
    const list = movList ?? [];
    if (tab === "MOTION") {
      return [
        { icon: Film,        color: "text-primary",     bg: "",                             label: "Total",        value: list.length },
        { icon: Users,       color: "text-red-400",     bg: "bg-red-950/20 border-red-600/30",    label: "Multi-Person", value: list.filter((m: any) => (m.faceCount ?? 0) > 1).length },
        { icon: AlertCircle, color: "text-orange-400",  bg: "bg-orange-950/20 border-orange-600/30", label: "With Alert",   value: list.filter((m: any) => m.alertId).length },
      ];
    }
    if (tab === "FACE") {
      return [
        { icon: User,        color: "text-green-400",   bg: "bg-green-950/20 border-green-600/30",  label: "Total Faces",  value: list.length },
        { icon: User,        color: "text-green-400",   bg: "bg-green-950/20 border-green-600/30",  label: "With Face Crop", value: list.filter((m: any) => m.faceCropUrl).length },
        { icon: AlertCircle, color: "text-orange-400",  bg: "bg-orange-950/20 border-orange-600/30", label: "With Alert",   value: list.filter((m: any) => m.alertId).length },
      ];
    }
    return [
      { icon: Users2,      color: "text-orange-400",  bg: "bg-orange-950/20 border-orange-600/30", label: "Total Bodies", value: list.length },
      { icon: AlertCircle, color: "text-orange-400",  bg: "bg-orange-950/20 border-orange-600/30", label: "With Alert",   value: list.filter((m: any) => m.alertId).length },
      { icon: Film,        color: "text-primary",     bg: "",                             label: "No Alert",     value: list.filter((m: any) => !m.alertId).length },
    ];
  };

  const TABS: { key: Tab; icon: any; label: string }[] = [
    { key: "MOTION", icon: Film,   label: "Motion Detection" },
    { key: "FACE",   icon: User,   label: "Person Face Detected" },
    { key: "BODY",   icon: Users2, label: "Person Body Detected" },
  ];

  return (
    <div className="space-y-6 p-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-primary">Motion Detections</h1>
          <p className="text-muted-foreground">All movement events — including suppressed detections</p>
        </div>
        <div className="flex gap-2">
          <Button variant={isAutoRefresh ? "default" : "outline"} onClick={() => setIsAutoRefresh(v => !v)}>
            <RefreshCw className={`w-4 h-4 mr-2 ${isAutoRefresh ? "animate-spin" : ""}`} />
            {isAutoRefresh ? "Auto ON" : "Auto OFF"}
          </Button>
          <Button variant="outline" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 bg-card/30 rounded-lg border border-border/40 w-fit">
        {TABS.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              tab === key
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
            <span className="text-[10px] opacity-70 ml-1">({countForTab(key)})</span>
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {statsRow().map((s, i) => (
          <Card key={i} className={`${s.bg || "bg-card/40 border-border/40"}`}>
            <CardContent className="p-4 flex items-center gap-3">
              <s.icon className={`w-6 h-6 ${s.color}`} />
              <div>
                <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-muted-foreground">{s.label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card className="bg-card/30 border-border/40">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Filter className="w-4 h-4" />
              <span className="text-sm font-medium uppercase tracking-wider">Filters</span>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase font-bold text-muted-foreground">Camera</Label>
              <Select value={filterCamera} onValueChange={setFilterCamera}>
                <SelectTrigger className="w-[160px] h-9 bg-background/50"><SelectValue placeholder="All Cameras" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Cameras</SelectItem>
                  {camerasList?.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase font-bold text-muted-foreground">Zone</Label>
              <Select value={filterZone} onValueChange={setFilterZone}>
                <SelectTrigger className="w-[160px] h-9 bg-background/50"><SelectValue placeholder="All Zones" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Zones</SelectItem>
                  {zonesList?.map((z: any) => <SelectItem key={z.id} value={String(z.id)}>{z.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {(filterCamera !== "all" || filterZone !== "all") && (
              <Button variant="ghost" size="sm" onClick={() => { setFilterCamera("all"); setFilterZone("all"); }}
                className="h-9 px-3 text-muted-foreground hover:text-primary">
                <X className="w-4 h-4 mr-2" /> Reset
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-video w-full rounded-xl" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : !movList || movList.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Film className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p>No movements for this filter. Try a different tab or camera.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {movList.map((mov: any) => (
            <MovementCard key={mov.id} mov={mov}
              cameraName={getCameraName(mov.cameraId)}
              zoneName={getZoneName(mov.zoneId)}
              onClick={() => setLocation(`/movements/${mov.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
