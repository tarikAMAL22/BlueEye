import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link as WouterLink } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RefreshCw, Play, Pause, SkipBack, SkipForward, Film, Users, AlertCircle, X, Filter } from "lucide-react";

const REFRESH_INTERVAL = 10000;
const FLIPBOOK_FPS = 8;

// Sort clip URLs chronologically.
// New format:  /uploads/clip_<13-digit-ms-ts>_<uuid>.jpg  → sort by embedded timestamp.
// Old format:  /uploads/clip_<uuid>.jpg                   → fallback to lexicographic sort.
function sortClipUrls(urls: string[]): string[] {
  const tsOf = (u: string) => {
    const m = u.match(/clip_(\d{13})_/);
    return m ? parseInt(m[1]) : 0;
  };
  return [...urls].sort((a, b) => tsOf(a) - tsOf(b) || a.localeCompare(b));
}

// ─── Flipbook video player ────────────────────────────────────────────────────
function FlipbookPlayer({
  urls,
  autoPlay = false,
  bestFrameIdx,
  faceCropUrl,
}: {
  urls: string[];
  autoPlay?: boolean;
  bestFrameIdx?: number;   // index of the best frame → shows a badge
  faceCropUrl?: string;    // face crop pinned to bottom-left of player
}) {
  const [idx, setIdx]         = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
  }, []);

  const play = useCallback(() => {
    stop();
    if (urls.length < 2) return;
    intervalRef.current = setInterval(() => {
      setIdx(i => (i + 1) % urls.length);
    }, 1000 / FLIPBOOK_FPS);
    setPlaying(true);
  }, [urls.length, stop]);

  const pause = useCallback(() => {
    stop();
    setPlaying(false);
  }, [stop]);

  useEffect(() => {
    if (autoPlay) play();
    return stop;
  }, [autoPlay, play, stop]);

  if (!urls || urls.length === 0) {
    return (
      <div className="w-full aspect-video bg-black/40 rounded flex items-center justify-center">
        <Film className="w-8 h-8 text-muted-foreground/30" />
      </div>
    );
  }

  const isBest = bestFrameIdx !== undefined && idx === bestFrameIdx;

  return (
    <div className="space-y-1.5">
      <div className="relative w-full aspect-video bg-black rounded overflow-hidden">
        <img
          src={urls[idx]}
          alt={`Frame ${idx + 1}/${urls.length}`}
          className="w-full h-full object-contain"
        />

        {/* Face crop pinned bottom-left */}
        {faceCropUrl && (
          <div className="absolute bottom-7 left-1.5 w-12 h-12 rounded border-2 border-primary/80 overflow-hidden bg-black shadow-lg">
            <img src={faceCropUrl} alt="Face" className="w-full h-full object-cover" />
          </div>
        )}

        {/* Best frame badge */}
        {isBest && (
          <div className="absolute top-1.5 left-1.5 bg-primary/90 text-primary-foreground text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide">
            ★ Best frame
          </div>
        )}

        {/* Frame counter */}
        <div className="absolute bottom-1 right-1.5 bg-black/60 text-white text-[9px] font-mono px-1.5 py-0.5 rounded">
          {idx + 1}/{urls.length}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
          onClick={() => { pause(); setIdx(0); }}>
          <SkipBack className="w-3.5 h-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
          onClick={playing ? pause : play}>
          {playing
            ? <Pause className="w-3.5 h-3.5" />
            : <Play  className="w-3.5 h-3.5" />}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
          onClick={() => { pause(); setIdx(urls.length - 1); }}>
          <SkipForward className="w-3.5 h-3.5" />
        </Button>
        {/* Scrubber */}
        <input
          type="range" min={0} max={urls.length - 1} value={idx}
          onChange={e => { pause(); setIdx(Number(e.target.value)); }}
          className="flex-1 h-1 accent-primary cursor-pointer"
        />
      </div>
    </div>
  );
}

// ─── Movement card ────────────────────────────────────────────────────────────
function MovementCard({ mov, cameraName, zoneName, onClick }: {
  mov: any;
  cameraName: string;
  zoneName: string;
  onClick: () => void;
}) {
  const frames: string[] = sortClipUrls(mov.frameUrls ?? []);
  const isMulti = (mov.faceCount ?? 0) > 1;
  const hasAlert = !!mov.alertId;

  return (
    <div
      className={`rounded-xl border overflow-hidden cursor-pointer transition-all hover:scale-[1.01] ${
        isMulti
          ? "border-red-600/50 bg-red-950/20"
          : "border-border/40 bg-card/60"
      }`}
      onClick={onClick}
    >
      {/* Preview thumbnail — prefer best frame, fallback to first clip frame */}
      <div className="relative aspect-video bg-black overflow-hidden">
        {mov.bestFrameUrl
          ? <img src={mov.bestFrameUrl} alt="Best frame" className="w-full h-full object-cover" />
          : frames.length > 0
          ? <img src={frames[0]} alt="Preview" className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center"><Film className="w-8 h-8 text-muted-foreground/20" /></div>
        }
        {/* Face crop overlay — bottom-left corner */}
        {mov.faceCropUrl && (
          <div className="absolute bottom-1.5 left-1.5 w-10 h-10 rounded border-2 border-primary/70 overflow-hidden bg-black shadow-lg">
            <img src={mov.faceCropUrl} alt="Face" className="w-full h-full object-cover" />
          </div>
        )}
        {/* Frame count badge */}
        <div className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1">
          <Film className="w-2.5 h-2.5" /> {frames.length} frames
        </div>
        {/* Multi-person badge */}
        {isMulti && (
          <div className="absolute top-1.5 right-1.5 bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1">
            <Users className="w-2.5 h-2.5" /> {mov.faceCount}
          </div>
        )}
        {/* Alert link badge */}
        {hasAlert && (
          <div className="absolute bottom-1.5 right-1.5 bg-orange-500/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
            Alert #{mov.alertId}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-2.5 space-y-1">
        <div className="text-[11px] font-bold truncate">{cameraName}</div>
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

// ─── Main page ────────────────────────────────────────────────────────────────
export default function MotionDetections() {
  const [selectedMov, setSelectedMov]   = useState<any>(null);
  const [filterCamera, setFilterCamera] = useState("all");
  const [filterZone,   setFilterZone]   = useState("all");
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);

  // Read ?alertId from URL to auto-open the linked motion
  const urlAlertId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("alertId");
    return v ? parseInt(v) : null;
  }, []);

  const { data: movList, isLoading, refetch } = trpc.movements.list.useQuery({
    limit:    200,
    cameraId: filterCamera !== "all" ? parseInt(filterCamera) : undefined,
    zoneId:   filterZone   !== "all" ? parseInt(filterZone)   : undefined,
  });

  const { data: camerasList } = trpc.cameras.list.useQuery();
  const { data: zonesList }   = trpc.zones.list.useQuery();

  const getCameraName = (id: number) => camerasList?.find((c: any) => c.id === id)?.name ?? `Camera #${id}`;
  const getZoneName   = (id: number) => zonesList?.find((z: any)   => z.id === id)?.name ?? `Zone #${id}`;

  // Auto-open motion when navigated from an alert popup
  useEffect(() => {
    if (!urlAlertId || !movList || selectedMov) return;
    const linked = movList.find((m: any) => m.alertId === urlAlertId);
    if (linked) setSelectedMov(linked);
  }, [urlAlertId, movList]);

  useEffect(() => {
    if (!isAutoRefresh) return;
    const t = setInterval(() => refetch(), REFRESH_INTERVAL);
    return () => clearInterval(t);
  }, [isAutoRefresh, refetch]);

  const multiCount = movList?.filter((m: any) => (m.faceCount ?? 0) > 1).length ?? 0;
  const alertCount = movList?.filter((m: any) => m.alertId).length ?? 0;

  return (
    <div className="space-y-6 p-8">
      {/* Header */}
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

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="bg-card/40 border-border/40">
          <CardContent className="p-4 flex items-center gap-3">
            <Film className="w-6 h-6 text-primary" />
            <div>
              <div className="text-2xl font-bold">{movList?.length ?? 0}</div>
              <div className="text-xs text-muted-foreground">Total Movements</div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-red-950/20 border-red-600/30">
          <CardContent className="p-4 flex items-center gap-3">
            <Users className="w-6 h-6 text-red-400" />
            <div>
              <div className="text-2xl font-bold text-red-400">{multiCount}</div>
              <div className="text-xs text-muted-foreground">Multi-Person</div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-orange-950/20 border-orange-600/30">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertCircle className="w-6 h-6 text-orange-400" />
            <div>
              <div className="text-2xl font-bold text-orange-400">{alertCount}</div>
              <div className="text-xs text-muted-foreground">Generated Alerts</div>
            </div>
          </CardContent>
        </Card>
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
                <SelectTrigger className="w-[160px] h-9 bg-background/50">
                  <SelectValue placeholder="All Cameras" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Cameras</SelectItem>
                  {camerasList?.map((c: any) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase font-bold text-muted-foreground">Zone</Label>
              <Select value={filterZone} onValueChange={setFilterZone}>
                <SelectTrigger className="w-[160px] h-9 bg-background/50">
                  <SelectValue placeholder="All Zones" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Zones</SelectItem>
                  {zonesList?.map((z: any) => (
                    <SelectItem key={z.id} value={String(z.id)}>{z.name}</SelectItem>
                  ))}
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
          <p>No movements detected yet. System is monitoring...</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {movList.map((mov: any) => (
            <MovementCard
              key={mov.id}
              mov={mov}
              cameraName={getCameraName(mov.cameraId)}
              zoneName={getZoneName(mov.zoneId)}
              onClick={() => setSelectedMov(mov)}
            />
          ))}
        </div>
      )}

      {/* Detail modal */}
      <Dialog open={!!selectedMov} onOpenChange={open => !open && setSelectedMov(null)}>
        <DialogContent className="max-w-2xl bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Film className="w-5 h-5 text-primary" />
              Movement #{selectedMov?.id}
            </DialogTitle>
          </DialogHeader>
          {selectedMov && (() => {
            const clipFrames: string[] = sortClipUrls(selectedMov.frameUrls ?? []);
            // Merge: best frame first (index 0), then chronological clip frames.
            // This ensures all evidence is in one unified player.
            const bestIdx  = selectedMov.bestFrameUrl ? 0 : undefined;
            const allFrames: string[] = [
              ...(selectedMov.bestFrameUrl ? [selectedMov.bestFrameUrl] : []),
              ...clipFrames,
            ];
            const isMulti = (selectedMov.faceCount ?? 0) > 1;
            return (
              <div className="space-y-4">
                {isMulti && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-600/20 border border-red-500/50 text-red-400 text-xs font-bold uppercase">
                    <Users className="w-4 h-4" /> {selectedMov.faceCount} persons detected in frame
                  </div>
                )}

                {/* Unified motion clip: best frame + all clip frames + face crop overlay */}
                <div>
                  <p className="text-xs font-bold text-muted-foreground uppercase mb-2">
                    Motion Clip ({allFrames.length} frames
                    {selectedMov.bestFrameUrl ? " · frame 1 = best" : ""})
                  </p>
                  <FlipbookPlayer
                    urls={allFrames}
                    autoPlay={true}
                    bestFrameIdx={bestIdx}
                    faceCropUrl={selectedMov.faceCropUrl ?? undefined}
                  />
                </div>

                {/* Metadata */}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="p-3 rounded-lg bg-muted/30 border border-border/30">
                    <div className="text-xs text-muted-foreground mb-1">Camera</div>
                    <div className="font-bold">{getCameraName(selectedMov.cameraId)}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/30 border border-border/30">
                    <div className="text-xs text-muted-foreground mb-1">Zone</div>
                    <div className="font-bold">{getZoneName(selectedMov.zoneId)}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/30 border border-border/30">
                    <div className="text-xs text-muted-foreground mb-1">Frames collected</div>
                    <div className="font-bold">{selectedMov.frameCount}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/30 border border-border/30">
                    <div className="text-xs text-muted-foreground mb-1">Alert generated</div>
                    <div className="font-bold">
                      {selectedMov.alertId ? (
                        <WouterLink
                          href={`/alerts?alertId=${selectedMov.alertId}`}
                          className="text-orange-400 hover:text-orange-300 hover:underline underline-offset-2 transition-colors"
                          onClick={() => setSelectedMov(null)}
                        >
                          Alert #{selectedMov.alertId} ↗
                        </WouterLink>
                      ) : (
                        <span className="text-muted-foreground">Suppressed</span>
                      )}
                    </div>
                  </div>
                </div>

                <p className="text-[10px] text-muted-foreground font-mono">
                  {new Date(selectedMov.timestamp).toLocaleString()} · Tracker {selectedMov.trackerId}
                </p>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
