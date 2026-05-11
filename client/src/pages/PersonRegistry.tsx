import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Edit, Trash2, User, Shield, Eye, Sparkles, Search, Fingerprint, Ghost, CheckCircle2, AlertTriangle, ChevronLeft, ChevronRight, UserCheck, SkipForward, Camera, Calendar, Scan, RefreshCw, Link as LinkIcon } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { useForm, Controller } from "react-hook-form";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export default function PersonRegistry() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string>("");
  const [knownSearch, setKnownSearch] = useState("");
  const [unknownSearch, setUnknownSearch] = useState("");
  const { register, handleSubmit, reset, control } = useForm({
    defaultValues: {
      name: "",
      role: "staff",
      isBlacklisted: false
    }
  });

  const { data: persons, isLoading, refetch } = trpc.persons.list.useQuery();
  const { data: zones } = trpc.zones.list.useQuery();
  const { data: settings } = trpc.settings.get.useQuery();
  const createMutation = trpc.persons.create.useMutation();
  const updateMutation = trpc.persons.update.useMutation();
  const deleteMutation = trpc.persons.delete.useMutation();
  const mergeMutation          = trpc.persons.mergePersons.useMutation();
  const computeEncodingMutation = trpc.persons.computeEncoding.useMutation();

  const onSubmit = async (data: any) => {
    try {
      const payload = { ...data, photoBase64: photoBase64 || undefined };
      if (editingId) {
        await updateMutation.mutateAsync({ id: editingId, ...payload });
      } else {
        await createMutation.mutateAsync(payload);
      }
      reset();
      setPhotoBase64("");
      setOpen(false);
      setEditingId(null);
      refetch();
      toast.success(editingId ? "Person updated" : "Person added");
    } catch (error: any) {
      console.error("Error saving person:", error);
      toast.error(`Error saving person: ${error.message}`);
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm("Are you sure you want to delete this person?")) {
      try {
        await deleteMutation.mutateAsync({ id });
        refetch();
        toast.success("Person deleted");
      } catch (error: any) {
        console.error("Error deleting person:", error);
        toast.error("Failed to delete person");
      }
    }
  };

  const handleEdit = (person: any) => {
    setEditingId(person.id);
    reset(person);
    setPhotoBase64("");
    setOpen(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoBase64(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const getRoleColor = (role: string) => {
    const r = role.toLowerCase();
    if (r === "admin") return "bg-red-500/10 text-red-400 border-red-500/20";
    if (r === "employee" || r === "staff") return "bg-green-500/10 text-green-400 border-green-500/20";
    if (r === "contractor") return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
    if (r === "unknown") return "bg-purple-500/10 text-purple-400 border-purple-500/20";
    return "bg-gray-500/10 text-gray-400 border-gray-500/20";
  };

  const knownPersons = useMemo(() => {
    if (!persons) return [];
    return persons.filter(p => 
      !p.isBlacklisted && 
      p.role.toLowerCase() !== "unknown" && 
      !p.name.toLowerCase().startsWith("unknown-")
    ).filter(p => p.name.toLowerCase().includes(knownSearch.toLowerCase()) || p.role.toLowerCase().includes(knownSearch.toLowerCase()));
  }, [persons, knownSearch]);

  const blacklistedPersons = useMemo(() => {
    if (!persons) return [];
    return persons.filter(p => p.isBlacklisted)
      .filter(p => p.name.toLowerCase().includes(knownSearch.toLowerCase()));
  }, [persons, knownSearch]);

  const unknownPersons = useMemo(() => {
    if (!persons) return [];
    return persons.filter(p =>
      !p.isBlacklisted &&
      (p.role.toLowerCase() === "unknown" || p.name.toLowerCase().startsWith("unknown-"))
    ).filter(p => p.name.toLowerCase().includes(unknownSearch.toLowerCase()));
  }, [persons, unknownSearch]);

  // ── Manage Unknown state ────────────────────────────────────────────────────
  const [manageOpen, setManageOpen] = useState(false);
  const [unknownIdx, setUnknownIdx] = useState(0);
  const [resolvedName, setResolvedName] = useState("");
  const [resolvedRole, setResolvedRole] = useState("staff");
  const [resolvedBlacklist, setResolvedBlacklist] = useState(false);

  const currentUnknown = unknownPersons[unknownIdx] ?? null;
  const unknownTotal   = unknownPersons.length;

  const [matchSearchQuery, setMatchSearchQuery] = useState("");
  const [matchThreshold, setMatchThreshold] = useState(50); // slider 0–100 → distance 1.0–0.0
  const matchDistThreshold = 1.0 - matchThreshold / 100;

  const { data: unknownAlerts } = trpc.alerts.getByPerson.useQuery(
    { personId: currentUnknown?.id ?? 0 },
    { enabled: manageOpen && !!currentUnknown }
  );
  const recentAlert = unknownAlerts?.[0] ?? null;

  const { data: potentialMatches, isLoading: isMatchesLoading, refetch: refetchMatches } =
    trpc.persons.getPotentialMatches.useQuery(
      { personId: currentUnknown?.id ?? 0, threshold: matchDistThreshold },
      { enabled: manageOpen && !!currentUnknown }
    );

  const knownMatches = (potentialMatches ?? []).filter((m: any) =>
    m.id !== currentUnknown?.id &&
    m.role.toLowerCase() !== "unknown" &&
    !m.name.toLowerCase().startsWith("unknown-")
  );

  // Autocomplete results: all persons (incl. unknowns for duplicate merges), scored by name relevance
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

  const openManage = (startIdx = 0) => {
    setUnknownIdx(startIdx);
    resetDecisionState();
    setManageOpen(true);
  };

  // Used only for Skip — does NOT remove the current item so index advances normally.
  const goNext = () => {
    const next = unknownIdx + 1;
    if (next < unknownTotal) {
      setUnknownIdx(next);
      resetDecisionState();
    } else {
      setManageOpen(false);
      toast.success("All unknown detections reviewed.");
    }
  };

  const goPrev = () => {
    if (unknownIdx > 0) {
      setUnknownIdx(unknownIdx - 1);
      resetDecisionState();
    }
  };

  // Called after any action that *removes* the current person from unknownPersons.
  // The list shrinks by 1, so the next person is now at the same index — no increment needed.
  const advanceAfterRemoval = () => {
    if (unknownIdx >= unknownTotal - 1) {
      setManageOpen(false);
      toast.success("All unknown detections reviewed.");
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

  const handleSkip = () => goNext();

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

  return (
    <div className="space-y-6 p-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-primary">Person Registry</h1>
          <p className="text-muted-foreground">Manage known individuals and their access permissions</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => { setEditingId(null); reset(); }} className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-4 h-4" />
              Add Person
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-border">
            <DialogHeader>
              <DialogTitle>{editingId ? "Edit Person" : "Add New Person"}</DialogTitle>
              <DialogDescription className="flex justify-between items-center">
                <span>Add a known individual to the registry</span>
                {settings?.testMode && !editingId && (
                  <Button 
                    type="button" 
                    variant="outline" 
                    size="sm" 
                    className="h-7 text-[10px] gap-1.5 border-yellow-500/30 text-yellow-500 hover:bg-yellow-500/10"
                    onClick={() => {
                      reset({
                        name: `Test User ${Math.floor(Math.random() * 1000)}`,
                        role: ["staff", "contractor", "admin", "visitor"][Math.floor(Math.random() * 4)]
                      });
                    }}
                  >
                    <Sparkles className="w-3 h-3" />
                    Fill Test Data
                  </Button>
                )}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label className="text-sm font-medium">Name</label>
                <Input {...register("name")} placeholder="Full name" className="bg-input border-border mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium">Role</label>
                <Input {...register("role")} placeholder="e.g., Employee, Contractor, Admin" className="bg-input border-border mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium">Photo</label>
                <Input type="file" accept="image/*" onChange={handleFileChange} className="bg-input border-border mt-1" />
                {photoBase64 && (
                  <div className="mt-2 text-xs text-green-500">Photo selected ✓</div>
                )}
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg border border-red-500/20 bg-red-500/5">
                <div className="space-y-0.5">
                  <Label className="text-sm font-semibold text-red-400">High-Priority Watchlist</Label>
                  <p className="text-[10px] text-muted-foreground">Mark this person as blacklisted for instant alerts</p>
                </div>
                <Controller
                  name="isBlacklisted"
                  control={control}
                  render={({ field }) => (
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </div>
              <div className="p-3 rounded border border-border/50 bg-muted/50">
                <p className="text-xs text-muted-foreground mb-2">Zone Access Permissions (Allowed Zones)</p>
                <div className="flex flex-wrap gap-2">
                  {zones?.map((zone: any) => (
                    <Badge key={zone.id} variant="outline" className="text-xs">
                      {zone.name}
                    </Badge>
                  )) || <p className="text-xs text-muted-foreground">No zones available</p>}
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" className="bg-primary text-primary-foreground hover:bg-primary/90">
                  {editingId ? "Update" : "Create"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs defaultValue="known" className="w-full">
        <div className="flex items-center justify-between mb-4">
          <TabsList className="bg-card/50 border border-border/50 p-1">
            <TabsTrigger value="known" className="gap-2 px-4 py-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <CheckCircle2 className="w-4 h-4" />
              Known Registry
              <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px] bg-primary/20 text-primary border-none">
                {knownPersons.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="blacklist" className="gap-2 px-4 py-2 data-[state=active]:bg-red-600 data-[state=active]:text-white">
              <AlertTriangle className="w-4 h-4" />
              Blacklist
              <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px] bg-red-500/20 text-red-200 border-none">
                {blacklistedPersons.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="unknown" className="gap-2 px-4 py-2 data-[state=active]:bg-purple-600 data-[state=active]:text-white">
              <Ghost className="w-4 h-4" />
              Unknown Detections
              <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px] bg-purple-500/20 text-purple-300 border-none">
                {unknownPersons.length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <div className="flex gap-4">
            <div className="relative group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
              <Input 
                placeholder="Search individuals..." 
                className="pl-10 w-64 bg-card/30 border-border/40 focus:border-primary/50 transition-all"
                onChange={(e) => {
                  setKnownSearch(e.target.value);
                  setUnknownSearch(e.target.value);
                }}
              />
            </div>
          </div>
        </div>

        <TabsContent value="known" className="mt-0">
          <Card className="glow-card bg-card/50 backdrop-blur border-border/50 overflow-hidden">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/30">
                    <TableRow className="border-border/50 hover:bg-transparent">
                      <TableHead className="w-[80px]">Photo</TableHead>
                      <TableHead>Full Name</TableHead>
                      <TableHead>System Role</TableHead>
                      <TableHead>Access Summary</TableHead>
                      <TableHead>Last Seen</TableHead>
                      <TableHead className="text-right pr-6">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      [1, 2, 3].map(i => (
                        <TableRow key={i} className="border-border/50">
                          <TableCell><Skeleton className="w-10 h-10 rounded" /></TableCell>
                          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                          <TableCell><Skeleton className="h-6 w-20 rounded-full" /></TableCell>
                          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                          <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                        </TableRow>
                      ))
                    ) : knownPersons.length > 0 ? (
                      knownPersons.map((person: any) => (
                        <TableRow key={person.id} className={`border-border/50 hover:bg-primary/5 group transition-colors ${person.isBlacklisted ? "bg-red-500/5 hover:bg-red-500/10" : ""}`}>
                          <TableCell className="pl-6">
                            <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center border border-border/50 group-hover:border-primary/30 transition-all overflow-hidden shadow-inner">
                              {person.photoUrl ? (
                                <img src={person.photoUrl} alt={person.name} className="w-full h-full object-cover" />
                              ) : (
                                <User className="w-6 h-6 text-muted-foreground" />
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="font-semibold text-foreground/90">
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                {person.name}
                                {person.isBlacklisted && (
                                  <Badge variant="destructive" className="text-[10px] h-4 px-1 animate-pulse">
                                    BLACKLISTED
                                  </Badge>
                                )}
                              </div>
                              <span className="text-[10px] text-muted-foreground uppercase tracking-widest mt-0.5">#{person.id}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`${getRoleColor(person.role)} px-2.5 py-0.5 border`}>
                              {person.role}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Shield className="w-3.5 h-3.5 text-primary/70" />
                              <span>{zones?.length || 0} Security Zones</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs font-medium text-muted-foreground">
                            {person.activityHistory && person.activityHistory.length > 0
                              ? new Date(person.activityHistory[0].timestamp).toLocaleDateString()
                              : "No data"}
                          </TableCell>
                          <TableCell className="text-right pr-6">
                            <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setLocation(`/persons/${person.id}`)}
                                className="h-8 w-8 text-blue-400 hover:text-blue-300 hover:bg-blue-400/10"
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => handleEdit(person)}
                                className="h-8 w-8 text-primary hover:text-primary hover:bg-primary/10"
                              >
                                <Edit className="w-4 h-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => handleDelete(person.id)}
                                className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="h-32 text-center text-muted-foreground italic">
                          No known individuals found matching your search.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="blacklist" className="mt-0">
          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {[1,2,3,4,5].map(i => (
                <Skeleton key={i} className="aspect-[3/4] rounded-xl" />
              ))}
            </div>
          ) : blacklistedPersons.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {blacklistedPersons.map((person: any) => (
                <div
                  key={person.id}
                  onClick={() => setLocation(`/persons/${person.id}`)}
                  className="group relative cursor-pointer rounded-xl overflow-hidden border border-red-500/20 bg-card/50 hover:border-red-500/60 hover:shadow-[0_0_20px_rgba(239,68,68,0.15)] transition-all duration-200"
                >
                  {/* Photo */}
                  <div className="aspect-[3/4] bg-red-500/5 flex items-center justify-center overflow-hidden">
                    {person.photoUrl ? (
                      <img
                        src={person.photoUrl}
                        alt={person.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                    ) : (
                      <AlertTriangle className="w-12 h-12 text-red-500/30" />
                    )}
                    {/* Overlay on hover */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-70 group-hover:opacity-90 transition-opacity" />
                  </div>

                  {/* Live monitor dot */}
                  <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/60 backdrop-blur-sm px-2 py-1 rounded-full">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-[9px] font-bold text-red-400 uppercase tracking-wider">Live</span>
                  </div>

                  {/* Name + ID */}
                  <div className="absolute bottom-0 left-0 right-0 p-3">
                    <Badge variant="outline" className="border-red-500/40 text-red-400 bg-red-500/10 text-[9px] uppercase tracking-wider mb-1.5">
                      Blacklisted
                    </Badge>
                    <p className="text-sm font-bold text-white leading-tight truncate">{person.name}</p>
                    <p className="text-[10px] text-red-300/70 mt-0.5">#{person.id} · {person.role}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-3 border border-dashed border-red-500/20 rounded-xl bg-red-500/[0.02]">
              <AlertTriangle className="w-8 h-8 text-red-500/30" />
              <p className="text-sm italic">No blacklisted persons found.</p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="unknown" className="mt-0">
          {unknownPersons.length > 0 && (
            <div className="flex justify-end mb-3">
              <Button
                onClick={() => openManage(0)}
                className="gap-2 bg-purple-600 hover:bg-purple-700 text-white"
              >
                <Ghost className="w-4 h-4" />
                Manage Unknown ({unknownPersons.length})
              </Button>
            </div>
          )}
          <Card className="glow-card bg-card/50 backdrop-blur border-border/50 overflow-hidden border-purple-500/20">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-purple-500/5">
                    <TableRow className="border-border/50 hover:bg-transparent">
                      <TableHead className="w-[80px]">Scan</TableHead>
                      <TableHead>Temporary ID</TableHead>
                      <TableHead>AI Status</TableHead>
                      <TableHead>Detection Confidence</TableHead>
                      <TableHead>First Spotted</TableHead>
                      <TableHead className="text-right pr-6">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      [1, 2].map(i => (
                        <TableRow key={i} className="border-border/50">
                          <TableCell><Skeleton className="w-10 h-10 rounded" /></TableCell>
                          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                          <TableCell><Skeleton className="h-6 w-20 rounded-full" /></TableCell>
                          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                          <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                        </TableRow>
                      ))
                    ) : unknownPersons.length > 0 ? (
                      unknownPersons.map((person: any) => (
                        <TableRow key={person.id} className="border-border/50 hover:bg-purple-500/5 group transition-colors">
                          <TableCell className="pl-6">
                            <div className="w-12 h-12 rounded-lg bg-purple-500/10 flex items-center justify-center border border-purple-500/20 group-hover:border-purple-500/40 transition-all overflow-hidden relative shadow-inner">
                              {person.photoUrl ? (
                                <img src={person.photoUrl} alt={person.name} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all" />
                              ) : (
                                <Ghost className="w-6 h-6 text-purple-400" />
                              )}
                              <div className="absolute inset-0 bg-gradient-to-t from-purple-900/40 to-transparent" />
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-sm text-purple-300">{person.name}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/30 px-2.5 py-0.5">
                              UNVERIFIED
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Fingerprint className="w-3.5 h-3.5 text-purple-400" />
                              <span>AI Tracked Entity</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs font-medium text-muted-foreground">
                            {new Date(person.createdAt).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-right pr-6">
                            <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => openManage(unknownPersons.findIndex((p: any) => p.id === person.id))}
                                className="h-8 w-8 text-purple-400 hover:text-purple-300 hover:bg-purple-400/10"
                                title="Review this unknown"
                              >
                                <UserCheck className="w-4 h-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setLocation(`/persons/${person.id}`)}
                                className="h-8 w-8 text-blue-400 hover:text-blue-300 hover:bg-blue-400/10"
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => handleDelete(person.id)}
                                className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="h-32 text-center text-muted-foreground italic">
                          No unknown detections found.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Manage Unknown Dialog ─────────────────────────────────────────── */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="bg-card border-border max-w-7xl w-full max-h-[96vh] flex flex-col gap-0 p-0">
          {/* ── Fixed header ── */}
          <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-border/40">
            <DialogTitle className="flex items-center gap-3 text-lg">
              <Ghost className="w-5 h-5 text-purple-400" />
              Review Unknown Detections
              {unknownTotal > 0 && (
                <Badge variant="outline" className="bg-purple-500/10 text-purple-300 border-purple-500/30 text-sm">
                  {unknownIdx + 1} / {unknownTotal}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              Identify this person or skip to the next unknown detection
            </DialogDescription>
          </DialogHeader>

          {/* ── Scrollable body ── */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
          {!currentUnknown ? (
            <div className="py-10 text-center text-muted-foreground italic">
              No unknown detections to review.
            </div>
          ) : (
            <div className="space-y-6">
            <div className="grid grid-cols-2 gap-8">
              {/* Left — photos */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Detection Photo</p>
                <div className="w-full rounded-xl bg-purple-500/10 border border-purple-500/20 overflow-hidden flex items-center justify-center" style={{minHeight: "360px", maxHeight: "460px"}}>
                  {currentUnknown.photoUrl ? (
                    <img src={currentUnknown.photoUrl} alt="Unknown" className="w-full h-full object-cover" style={{maxHeight: "460px"}} />
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
                  <p className="font-mono text-sm text-purple-300">{currentUnknown.name}</p>
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
                  <Switch
                    checked={resolvedBlacklist}
                    onCheckedChange={setResolvedBlacklist}
                  />
                </div>

                <div className="flex-1" />

                {/* Action buttons */}
                <div className="space-y-2 pt-2">
                  <Button
                    className="w-full gap-2 bg-purple-600 hover:bg-purple-700 text-white"
                    disabled={!resolvedName.trim()}
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
                      <ChevronLeft className="w-4 h-4" />
                      Prev
                    </Button>
                    <Button
                      variant="outline"
                      className="gap-1.5 border-border/50"
                      onClick={handleSkip}
                    >
                      <SkipForward className="w-4 h-4" />
                      Skip
                    </Button>
                    <Button
                      variant="outline"
                      className="gap-1.5 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500/50"
                      onClick={handleDeleteUnknown}
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Potential Matches ──────────────────────────────────────── */}
            <div className="border-t border-border/40 pt-5 space-y-4">
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
                    title="Compute face encoding from this person's photo so biometric matching works"
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

              {/* AI auto-matches */}
              {isMatchesLoading ? (
                <div className="grid grid-cols-2 gap-3">
                  {[1, 2].map(i => (
                    <div key={i} className="h-16 rounded-xl bg-muted/30 animate-pulse" />
                  ))}
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
                        <UserCheck className="w-3.5 h-3.5" />
                        Is Him
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic text-center py-2 border border-dashed border-border/40 rounded-lg">
                  No automatic matches found — use manual search below
                </p>
              )}

              {/* Manual identity link — all persons, autocomplete, top 5 by score */}
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
                      manualSearchResults.map((candidate: any, idx: number) => {
                        const isUnknown = candidate.role.toLowerCase() === "unknown" || candidate.name.toLowerCase().startsWith("unknown-");
                        return (
                          <div
                            key={candidate.id}
                            className={`flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors group cursor-default ${idx > 0 ? "border-t border-border/30" : ""}`}
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
                              <LinkIcon className="w-3.5 h-3.5" />
                              Merge
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
          )}
          </div>{/* end scrollable body */}
        </DialogContent>
      </Dialog>
    </div>
  );
}
