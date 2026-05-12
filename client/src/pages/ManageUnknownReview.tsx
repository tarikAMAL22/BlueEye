import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  ArrowLeft, Ghost, UserCheck, SkipForward, Trash2,
  ChevronLeft, ChevronRight, Camera, Calendar, Scan,
  RefreshCw, Search, User, Link as LinkIcon,
} from "lucide-react";
import { toast } from "sonner";

export default function ManageUnknownReview() {
  const [, setLocation] = useLocation();
  const search = useSearch();

  const startPersonId = useMemo(() => {
    const p = new URLSearchParams(search).get("personId");
    return p ? parseInt(p) : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: persons, isLoading, refetch } = trpc.persons.list.useQuery();
  const updateMutation          = trpc.persons.update.useMutation();
  const deleteMutation          = trpc.persons.delete.useMutation();
  const mergeMutation           = trpc.persons.mergePersons.useMutation();
  const computeEncodingMutation = trpc.persons.computeEncoding.useMutation();

  const unknownPersons = useMemo(() => {
    if (!persons) return [];
    return persons.filter((p: any) =>
      !p.isBlacklisted &&
      (p.role.toLowerCase() === "unknown" || p.name.toLowerCase().startsWith("unknown-"))
    );
  }, [persons]);

  const [unknownIdx,       setUnknownIdx]       = useState(0);
  const [resolvedName,     setResolvedName]     = useState("");
  const [resolvedRole,     setResolvedRole]     = useState("staff");
  const [resolvedBlacklist, setResolvedBlacklist] = useState(false);
  const [matchSearchQuery, setMatchSearchQuery] = useState("");
  const [matchThreshold,   setMatchThreshold]   = useState(50);
  const matchDistThreshold = 1.0 - matchThreshold / 100;

  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !persons || unknownPersons.length === 0) return;
    initialized.current = true;
    if (startPersonId) {
      const idx = unknownPersons.findIndex((p: any) => p.id === startPersonId);
      if (idx >= 0) setUnknownIdx(idx);
    }
  }, [persons, unknownPersons, startPersonId]);

  const currentUnknown = unknownPersons[unknownIdx] ?? null;
  const unknownTotal   = unknownPersons.length;

  const { data: unknownAlerts } = trpc.alerts.getByPerson.useQuery(
    { personId: currentUnknown?.id ?? 0 },
    { enabled: !!currentUnknown }
  );
  const recentAlert = unknownAlerts?.[0] ?? null;

  const { data: potentialMatches, isLoading: isMatchesLoading, refetch: refetchMatches } =
    trpc.persons.getPotentialMatches.useQuery(
      { personId: currentUnknown?.id ?? 0, threshold: matchDistThreshold },
      { enabled: !!currentUnknown }
    );

  const knownMatches = useMemo(() =>
    (potentialMatches ?? []).filter((m: any) =>
      m.id !== currentUnknown?.id &&
      m.role.toLowerCase() !== "unknown" &&
      !m.name.toLowerCase().startsWith("unknown-")
    ),
    [potentialMatches, currentUnknown?.id]
  );

  const manualSearchResults = useMemo(() => {
    if (!matchSearchQuery.trim() || !persons) return [];
    const q = matchSearchQuery.toLowerCase().trim();
    return (persons as any[])
      .filter((p: any) => p.id !== currentUnknown?.id)
      .map((p: any) => {
        const name = p.name.toLowerCase();
        let score = 0;
        if (name === q) score = 3;
        else if (name.startsWith(q)) score = 2;
        else if (name.includes(q) || String(p.id).includes(q)) score = 1;
        return { ...p, _score: score };
      })
      .filter((p: any) => p._score > 0)
      .sort((a: any, b: any) => b._score - a._score)
      .slice(0, 5);
  }, [matchSearchQuery, persons, currentUnknown?.id]);

  const resetDecisionState = () => {
    setResolvedName("");
    setResolvedRole("staff");
    setResolvedBlacklist(false);
    setMatchSearchQuery("");
  };

  const goNext = () => {
    const next = unknownIdx + 1;
    if (next < unknownTotal) {
      setUnknownIdx(next);
      resetDecisionState();
    } else {
      toast.success("All unknown detections reviewed.");
      setLocation("/persons");
    }
  };

  const goPrev = () => {
    if (unknownIdx > 0) {
      setUnknownIdx(unknownIdx - 1);
      resetDecisionState();
    }
  };

  const advanceAfterRemoval = () => {
    if (unknownIdx >= unknownTotal - 1) {
      toast.success("All unknown detections reviewed.");
      setLocation("/persons");
    } else {
      resetDecisionState();
    }
  };

  const handleIdentify = async () => {
    if (!currentUnknown || !resolvedName.trim()) return;
    try {
      await updateMutation.mutateAsync({
        id: currentUnknown.id,
        name: resolvedName.trim(),
        role: resolvedRole || "staff",
        isBlacklisted: resolvedBlacklist,
      });
      toast.success(`${resolvedName} identified and saved.`);
      await refetch();
      advanceAfterRemoval();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleAssignTo = async (targetId: number, targetName: string) => {
    if (!currentUnknown) return;
    try {
      await mergeMutation.mutateAsync({ sourceId: currentUnknown.id, targetId });
      toast.success(`Merged into ${targetName} — all history transferred.`);
      await refetch();
      advanceAfterRemoval();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleDeleteUnknown = async () => {
    if (!currentUnknown) return;
    try {
      await deleteMutation.mutateAsync({ id: currentUnknown.id });
      toast.success("Unknown detection deleted.");
      await refetch();
      advanceAfterRemoval();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6 p-8">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-8">
          <Skeleton className="aspect-[3/4] rounded-xl" />
          <div className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (unknownPersons.length === 0) {
    return (
      <div className="p-8 text-center space-y-4">
        <Ghost className="w-12 h-12 mx-auto text-muted-foreground opacity-20" />
        <p className="text-muted-foreground">No unknown detections to review.</p>
        <Button variant="outline" onClick={() => setLocation("/persons")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Registry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/persons")} className="gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Person Registry
        </Button>
        <div className="h-4 w-px bg-border/50" />
        <div className="flex items-center gap-3">
          <Ghost className="w-5 h-5 text-purple-400" />
          <h1 className="text-2xl font-bold text-purple-300">Review Unknown Detections</h1>
          <Badge variant="outline" className="bg-purple-500/10 text-purple-300 border-purple-500/30">
            {unknownIdx + 1} / {unknownTotal}
          </Badge>
        </div>
      </div>

      {/* Main two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-5xl">
        {/* Left — photos */}
        <div className="space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Detection Photo</p>
          <div
            className="w-full rounded-xl bg-purple-500/10 border border-purple-500/20 overflow-hidden flex items-center justify-center"
            style={{ minHeight: "360px", maxHeight: "460px" }}
          >
            {currentUnknown?.photoUrl ? (
              <img src={currentUnknown.photoUrl} alt="Unknown" className="w-full h-full object-cover" style={{ maxHeight: "460px" }} />
            ) : (
              <Ghost className="w-20 h-20 text-purple-400/40" />
            )}
          </div>
          {recentAlert?.bestFrameSnapshotUrl && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Camera className="w-3 h-3" /> Best Alert Frame
              </p>
              <div className="w-full aspect-video rounded-lg overflow-hidden border border-orange-500/20">
                <img src={recentAlert.bestFrameSnapshotUrl} alt="Alert frame" className="w-full h-full object-cover" />
              </div>
              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {new Date(recentAlert.createdAt).toLocaleString()}
              </p>
            </div>
          )}
        </div>

        {/* Right — decision inputs */}
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Temp ID</p>
            <p className="font-mono text-sm text-purple-300">{currentUnknown?.name}</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Full Name</Label>
            <Input
              placeholder="Enter person's name..."
              value={resolvedName}
              onChange={e => setResolvedName(e.target.value)}
              className="bg-input border-border"
              onKeyDown={e => { if (e.key === "Enter" && resolvedName.trim()) handleIdentify(); }}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Role</Label>
            <div className="flex flex-wrap gap-2">
              {["staff", "contractor", "admin", "visitor"].map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setResolvedRole(r)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    resolvedRole === r
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted/30 text-muted-foreground border-border/50 hover:border-primary/50"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border border-red-500/20 bg-red-500/5">
            <div className="space-y-0.5">
              <Label className="text-sm font-semibold text-red-400">Add to Blacklist</Label>
              <p className="text-[10px] text-muted-foreground">Flag as high-priority watchlist target</p>
            </div>
            <Switch checked={resolvedBlacklist} onCheckedChange={setResolvedBlacklist} />
          </div>

          <div className="flex-1" />

          <div className="space-y-2 pt-2">
            <Button
              className="w-full gap-2 bg-purple-600 hover:bg-purple-700 text-white"
              disabled={!resolvedName.trim() || updateMutation.isPending}
              onClick={handleIdentify}
            >
              <UserCheck className="w-4 h-4" />
              Identify &amp; Save
            </Button>
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="outline"
                className="gap-1.5 border-border/50"
                disabled={unknownIdx === 0}
                onClick={goPrev}
              >
                <ChevronLeft className="w-4 h-4" /> Prev
              </Button>
              <Button
                variant="outline"
                className="gap-1.5 border-border/50"
                onClick={goNext}
              >
                <SkipForward className="w-4 h-4" /> Skip
              </Button>
              <Button
                variant="outline"
                className="gap-1.5 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500/50"
                disabled={deleteMutation.isPending}
                onClick={handleDeleteUnknown}
              >
                <Trash2 className="w-4 h-4" /> Delete
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Potential Matches */}
      <div className="border-t border-border/40 pt-5 space-y-4 max-w-5xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Scan className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-semibold uppercase tracking-wider text-blue-400">Assign to Known Person</span>
            {!isMatchesLoading && (
              <Badge variant="outline" className="border-blue-500/40 text-blue-400 text-[10px]">
                {knownMatches.length} AI match{knownMatches.length !== 1 ? "es" : ""}
              </Badge>
            )}
            <button
              type="button"
              title="Compute face encoding from this person's photo"
              disabled={computeEncodingMutation.isPending || !currentUnknown}
              onClick={async () => {
                if (!currentUnknown) return;
                try {
                  const result = await computeEncodingMutation.mutateAsync({ personId: currentUnknown.id });
                  if ((result as any).status === "ok") {
                    toast.success("Encoding computed — refreshing matches...");
                    refetchMatches();
                  } else {
                    toast.warning(`No face detected (status: ${(result as any).status})`);
                  }
                } catch (e: any) {
                  toast.error(`Encoding failed: ${e.message}`);
                }
              }}
              className="text-[10px] px-2 py-1 rounded border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-40"
            >
              {computeEncodingMutation.isPending ? "Computing..." : "Compute Encoding"}
            </button>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase text-muted-foreground font-bold">Threshold</span>
              <span className="text-[10px] font-mono text-blue-400 font-bold w-8 text-right">{matchThreshold}%</span>
              <Slider
                value={[matchThreshold]}
                onValueChange={vals => setMatchThreshold(vals[0])}
                max={100}
                step={5}
                className="w-24"
              />
            </div>
            <button
              type="button"
              onClick={() => refetchMatches()}
              className={`text-muted-foreground hover:text-blue-400 transition-colors ${isMatchesLoading ? "animate-spin" : ""}`}
              title="Re-scan"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {isMatchesLoading ? (
          <div className="grid grid-cols-2 gap-3">
            {[1, 2].map(i => <div key={i} className="h-16 rounded-xl bg-muted/30 animate-pulse" />)}
          </div>
        ) : knownMatches.length > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            {knownMatches.map((match: any) => (
              <div key={match.id} className="flex items-center gap-3 p-3 rounded-xl border border-blue-500/20 bg-blue-500/5 hover:bg-blue-500/10 transition-colors group">
                <div className="w-12 h-12 rounded-lg overflow-hidden border border-blue-500/30 flex-shrink-0 bg-muted">
                  {match.photoUrl
                    ? <img src={match.photoUrl} alt={match.name} className="w-full h-full object-cover" />
                    : <User className="w-6 h-6 m-3 text-muted-foreground" />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-blue-300 truncate">{match.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-blue-500/30 text-blue-400">{match.role}</Badge>
                    <span className="text-[10px] font-mono text-blue-500">{match.matchScore}%</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-700 h-8 px-3 text-xs gap-1 flex-shrink-0"
                  onClick={() => handleAssignTo(match.id, match.name)}
                  disabled={mergeMutation.isPending}
                >
                  <UserCheck className="w-3.5 h-3.5" /> Is Him
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic text-center py-2 border border-dashed border-border/40 rounded-lg">
            No automatic matches found — use manual search below
          </p>
        )}

        {/* Manual identity link */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <LinkIcon className="w-3 h-3" />
            Manual Identity Link
            <span className="normal-case font-normal text-muted-foreground/60">— merge duplicates or assign to any person</span>
          </p>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50 pointer-events-none" />
            <Input
              placeholder="Type a name to search all persons…"
              className="pl-10 bg-background/50 border-border/50 text-sm"
              value={matchSearchQuery}
              onChange={e => setMatchSearchQuery(e.target.value)}
            />
            {matchSearchQuery && (
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setMatchSearchQuery("")}
              >
                ×
              </button>
            )}
          </div>
          {matchSearchQuery.trim() && (
            <div className="rounded-lg border border-border/60 bg-card shadow-lg overflow-hidden">
              {manualSearchResults.length > 0 ? (
                manualSearchResults.map((candidate: any, i: number) => {
                  const isUnknown = candidate.role.toLowerCase() === "unknown" || candidate.name.toLowerCase().startsWith("unknown-");
                  return (
                    <div
                      key={candidate.id}
                      className={`flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors group cursor-default ${i > 0 ? "border-t border-border/30" : ""}`}
                    >
                      <div className="w-8 h-8 rounded-md overflow-hidden border border-border/50 bg-muted flex-shrink-0">
                        {candidate.photoUrl
                          ? <img src={candidate.photoUrl} className="w-full h-full object-cover" />
                          : <User className="w-4 h-4 m-2 text-muted-foreground" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold leading-tight truncate">{candidate.name}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className={`text-[9px] px-1.5 py-px rounded-full border font-medium ${isUnknown ? "border-purple-500/30 text-purple-400 bg-purple-500/10" : "border-border/50 text-muted-foreground bg-muted/30"}`}>
                            {isUnknown ? "unknown" : candidate.role}
                          </span>
                          <span className="text-[9px] text-muted-foreground">#{candidate.id}</span>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2.5 text-xs gap-1.5 text-blue-400 hover:text-blue-300 hover:bg-blue-400/10 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                        onClick={() => handleAssignTo(candidate.id, candidate.name)}
                        disabled={mergeMutation.isPending}
                      >
                        <LinkIcon className="w-3.5 h-3.5" /> Merge
                      </Button>
                    </div>
                  );
                })
              ) : (
                <div className="px-4 py-3 text-xs text-muted-foreground text-center">
                  No persons match "{matchSearchQuery}"
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
