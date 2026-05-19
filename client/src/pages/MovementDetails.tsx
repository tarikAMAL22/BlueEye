import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useLocation, Link as WouterLink } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Film, Users, AlertCircle, Play, Pause, SkipBack, SkipForward, Clock, RefreshCw, Settings } from "lucide-react";

function sortClipUrls(urls: string[]): string[] {
  const tsOf = (u: string) => {
    const m = u.match(/clip_(\d{13})_/);
    return m ? parseInt(m[1]) : 0;
  };
  return [...urls].sort((a, b) => tsOf(a) - tsOf(b) || a.localeCompare(b));
}

function FlipbookPlayer({ urls, autoPlay = false, bestFrameIdx, faceCropUrl, intervalMs = 500 }: {
  urls: string[];
  autoPlay?: boolean;
  bestFrameIdx?: number;
  faceCropUrl?: string;
  intervalMs?: number;
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
    intervalRef.current = setInterval(() => setIdx(i => (i + 1) % urls.length), intervalMs);
    setPlaying(true);
  }, [urls.length, stop, intervalMs]);

  const pause = useCallback(() => { stop(); setPlaying(false); }, [stop]);

  useEffect(() => {
    if (autoPlay) play();
    return stop;
  }, [autoPlay, play, stop]);

  if (!urls || urls.length === 0) {
    return (
      <div className="w-full aspect-video bg-black/40 rounded-xl flex items-center justify-center">
        <Film className="w-12 h-12 text-muted-foreground/20" />
      </div>
    );
  }

  const isBest = bestFrameIdx !== undefined && idx === bestFrameIdx;

  return (
    <div className="space-y-2">
      <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden border border-border/50">
        <img src={urls[idx]} alt={`Frame ${idx + 1}/${urls.length}`} className="w-full h-full object-contain" />
        {faceCropUrl && (
          <div className="absolute bottom-8 left-2 w-14 h-14 rounded border-2 border-primary/80 overflow-hidden bg-black shadow-lg">
            <img src={faceCropUrl} alt="Face" className="w-full h-full object-cover" />
          </div>
        )}
        {isBest && (
          <div className="absolute top-2 left-2 bg-primary/90 text-primary-foreground text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-wide">
            ★ Best frame
          </div>
        )}
        <div className="absolute bottom-2 right-2 bg-black/60 text-white text-[9px] font-mono px-1.5 py-0.5 rounded">
          {idx + 1}/{urls.length}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => { pause(); setIdx(0); }}>
          <SkipBack className="w-4 h-4" />
        </Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={playing ? pause : play}>
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => { pause(); setIdx(urls.length - 1); }}>
          <SkipForward className="w-4 h-4" />
        </Button>
        <input
          type="range" min={0} max={urls.length - 1} value={idx}
          onChange={e => { pause(); setIdx(Number(e.target.value)); }}
          className="flex-1 h-1.5 accent-primary cursor-pointer"
        />
      </div>
    </div>
  );
}

export default function MovementDetails() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const movId = parseInt(id || "0");

  const { data: movement, isLoading } = trpc.movements.getById.useQuery({ id: movId }, { enabled: !!movId });
  const { data: camerasList } = trpc.cameras.list.useQuery();
  const { data: zonesList }   = trpc.zones.list.useQuery();
  const { data: settingsData } = trpc.settings.get.useQuery();
  const flipbookIntervalMs = (settingsData as any)?.cvFlipbookInterval ?? 500;

  const getCameraName = (id: number) => camerasList?.find((c: any) => c.id === id)?.name ?? `Camera #${id}`;
  const getZoneName   = (id: number) => zonesList?.find((z: any) => z.id === id)?.name   ?? `Zone #${id}`;

  if (isLoading) {
    return (
      <div className="space-y-6 p-8">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="aspect-video w-full max-w-3xl rounded-xl" />
        <div className="grid grid-cols-2 gap-4 max-w-3xl">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!movement) {
    return (
      <div className="p-8 text-center">
        <Film className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-20" />
        <p className="text-muted-foreground">Movement not found.</p>
        <Button className="mt-4" variant="outline" onClick={() => setLocation("/movements")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Movements
        </Button>
      </div>
    );
  }

  const clipFrames: string[] = sortClipUrls((movement as any).frameUrls ?? []);
  const allFrames: string[] = [
    ...((movement as any).bestFrameUrl ? [(movement as any).bestFrameUrl] : []),
    ...clipFrames,
  ];
  const bestIdx  = (movement as any).bestFrameUrl ? 0 : undefined;
  const isMulti  = ((movement as any).faceCount ?? 0) > 1;

  return (
    <div className="space-y-6 p-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/movements")} className="gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Movements
        </Button>
        <div className="h-4 w-px bg-border/50" />
        <div className="flex items-center gap-3">
          <Film className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold text-primary">Movement #{movement.id}</h1>
          {isMulti && (
            <Badge className="bg-red-600 text-white text-[10px] font-bold flex items-center gap-1">
              <Users className="w-3 h-3" /> {(movement as any).faceCount} persons
            </Badge>
          )}
          {(movement as any).alertId ? (
            <Badge className="bg-orange-500/80 text-white text-[10px] font-bold">Alert linked</Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">No alert</Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-5xl">
        {/* Flipbook player */}
        <div className="space-y-4">
          {isMulti && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-600/20 border border-red-500/50 text-red-400 text-xs font-bold uppercase">
              <Users className="w-4 h-4" /> {(movement as any).faceCount} persons detected in frame
            </div>
          )}
          <div>
            <p className="text-xs font-bold text-muted-foreground uppercase mb-2">
              Motion Clip ({allFrames.length} frames{(movement as any).bestFrameUrl ? " · frame 1 = best" : ""})
            </p>
            <FlipbookPlayer
              urls={allFrames}
              autoPlay
              bestFrameIdx={bestIdx}
              faceCropUrl={(movement as any).faceCropUrl ?? undefined}
              intervalMs={flipbookIntervalMs}
            />
          </div>
        </div>

        {/* Metadata */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Details</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="p-4 rounded-xl bg-muted/30 border border-border/30">
              <div className="text-xs text-muted-foreground mb-1">Camera</div>
              <div className="font-bold">{getCameraName((movement as any).cameraId)}</div>
            </div>
            <div className="p-4 rounded-xl bg-muted/30 border border-border/30">
              <div className="text-xs text-muted-foreground mb-1">Zone</div>
              <div className="font-bold">{getZoneName((movement as any).zoneId)}</div>
            </div>
            <div className="p-4 rounded-xl bg-muted/30 border border-border/30">
              <div className="text-xs text-muted-foreground mb-1">Frames collected</div>
              <div className="font-bold">{(movement as any).frameCount}</div>
            </div>
            <div className="p-4 rounded-xl bg-muted/30 border border-border/30">
              <div className="text-xs text-muted-foreground mb-1">Faces detected</div>
              <div className="font-bold">{(movement as any).faceCount ?? 0}</div>
            </div>
            <div className="p-4 rounded-xl bg-muted/30 border border-border/30">
              <div className="text-xs text-muted-foreground mb-1">Timestamp</div>
              <div className="font-bold font-mono text-xs">{new Date((movement as any).timestamp).toLocaleString()}</div>
            </div>
            <div className="p-4 rounded-xl bg-muted/30 border border-border/30">
              <div className="text-xs text-muted-foreground mb-1">Tracker ID</div>
              <div className="font-bold font-mono text-xs truncate">{(movement as any).trackerId}</div>
            </div>
            <div className="p-4 rounded-xl bg-muted/30 border border-border/30 col-span-2">
              <div className="text-xs text-muted-foreground mb-2">Detection Type</div>
              <div className="flex items-center gap-2">
                {(movement as any).detectionType === "FACE" && (
                  <Badge className="bg-green-600 text-white">👤 Face Detected</Badge>
                )}
                {(movement as any).detectionType === "BODY" && (
                  <Badge className="bg-orange-600 text-white">🚶 Body Only</Badge>
                )}
                {((!movement || (movement as any).detectionType === "MOTION" || !(movement as any).detectionType)) && (
                  <Badge variant="outline">🎥 Motion Only</Badge>
                )}
              </div>
            </div>
          </div>

          {/* Alert link / suppression info */}
          <div className="pt-2">
            {(movement as any).alertId ? (
              <WouterLink href={`/alerts/${(movement as any).alertId}`}>
                <Button variant="outline" className="gap-2 border-orange-500/50 text-orange-400 hover:bg-orange-500/10 hover:border-orange-500 w-full">
                  <AlertCircle className="w-4 h-4" />
                  View Alert #{(movement as any).alertId}
                </Button>
              </WouterLink>
            ) : (() => {
              const reason   = (movement as any).suppressionReason as string | undefined;
              const details  = (movement as any).suppressionDetails as any;
              if (reason === 'cooldown') {
                return (
                  <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-2">
                    <div className="flex items-center gap-2 text-amber-400 font-bold text-xs uppercase tracking-wide">
                      <Clock className="w-4 h-4" /> Alert suppressed — camera cooldown active
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {details?.secondsRemaining != null
                        ? `Cooldown had ${details.secondsRemaining}s remaining (setting: ${details.cooldownSeconds}s).`
                        : `Alert cooldown was still active when this person was detected.`}
                    </p>
                    <WouterLink href="/settings">
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-amber-400 hover:bg-amber-500/10 gap-1.5">
                        <Settings className="w-3 h-3" /> Adjust cooldown in Settings
                      </Button>
                    </WouterLink>
                  </div>
                );
              }
              if (reason === 'dedup') {
                return (
                  <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/30 space-y-2">
                    <div className="flex items-center gap-2 text-blue-400 font-bold text-xs uppercase tracking-wide">
                      <RefreshCw className="w-4 h-4" /> Alert suppressed — person recently seen
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {details?.secondsAgo != null
                        ? `Same biometric match detected ${details.secondsAgo}s ago (dedup window: ${details.windowSeconds}s).`
                        : `This person was already detected within the dedup window.`}
                    </p>
                    <WouterLink href="/settings">
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-blue-400 hover:bg-blue-500/10 gap-1.5">
                        <Settings className="w-3 h-3" /> Adjust dedup window in Settings
                      </Button>
                    </WouterLink>
                  </div>
                );
              }
              return (
                <div className="p-4 rounded-xl bg-muted/20 border border-border/30 text-center text-xs text-muted-foreground italic">
                  No alert was generated for this movement.
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
