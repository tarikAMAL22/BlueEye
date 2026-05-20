import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Plus, Edit, Trash2, User, Shield, Eye, Sparkles,
  Search, Fingerprint, Ghost, CheckCircle2, AlertTriangle,
  UserCheck, X, Camera, Clock,
} from "lucide-react";
import { useForm, Controller } from "react-hook-form";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export default function PersonRegistry() {
  const [, setLocation] = useLocation();
  const [showForm,     setShowForm]     = useState(false);
  const [editingId,    setEditingId]    = useState<number | null>(null);
  const [photoBase64,  setPhotoBase64]  = useState<string>("");
  const [anglePersonId, setAnglePersonId] = useState<number | null>(null);
  const [angleBase64,  setAngleBase64]  = useState<string>("");
  const [knownSearch,   setKnownSearch]   = useState("");
  const [unknownSearch, setUnknownSearch] = useState("");

  const { register, handleSubmit, reset, control } = useForm({
    defaultValues: { name: "", role: "staff", isBlacklisted: false },
  });

  const { data: persons, isLoading, refetch } = trpc.persons.list.useQuery();
  const { data: zones }    = trpc.zones.list.useQuery();
  const { data: settings } = trpc.settings.get.useQuery();
  const { data: groups }            = trpc.groups.list.useQuery();
  const { data: allMemberships }    = trpc.groups.allMemberships.useQuery();

  const personGroupsMap = useMemo(() => {
    if (!allMemberships) return new Map<number, { groupId: number; groupName: string; groupColor: string }[]>();
    const map = new Map<number, { groupId: number; groupName: string; groupColor: string }[]>();
    for (const m of allMemberships) {
      if (!map.has(m.personId)) map.set(m.personId, []);
      map.get(m.personId)!.push({ groupId: m.groupId, groupName: m.groupName ?? "", groupColor: m.groupColor ?? "#888" });
    }
    return map;
  }, [allMemberships]);
  const createMutation      = trpc.persons.create.useMutation();
  const updateMutation      = trpc.persons.update.useMutation();
  const deleteMutation      = trpc.persons.delete.useMutation();
  const addEncodingMutation = trpc.personsExtra.addEncoding.useMutation();

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
      setShowForm(false);
      setEditingId(null);
      refetch();
      toast.success(editingId ? "Person updated" : "Person added");
    } catch (error: any) {
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
        toast.error("Failed to delete person");
      }
    }
  };

  const handleEdit = (person: any) => {
    setEditingId(person.id);
    reset(person);
    setPhotoBase64("");
    setShowForm(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setPhotoBase64(reader.result as string);
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
    return persons
      .filter((p: any) =>
        !p.isBlacklisted &&
        p.role.toLowerCase() !== "unknown" &&
        !p.name.toLowerCase().startsWith("unknown-")
      )
      .filter((p: any) =>
        p.name.toLowerCase().includes(knownSearch.toLowerCase()) ||
        p.role.toLowerCase().includes(knownSearch.toLowerCase())
      );
  }, [persons, knownSearch]);

  const blacklistedPersons = useMemo(() => {
    if (!persons) return [];
    return persons
      .filter((p: any) => p.isBlacklisted)
      .filter((p: any) => p.name.toLowerCase().includes(knownSearch.toLowerCase()));
  }, [persons, knownSearch]);

  const unknownPersons = useMemo(() => {
    if (!persons) return [];
    return persons
      .filter((p: any) =>
        !p.isBlacklisted &&
        (p.role.toLowerCase() === "unknown" || p.name.toLowerCase().startsWith("unknown-"))
      )
      .filter((p: any) => p.name.toLowerCase().includes(unknownSearch.toLowerCase()));
  }, [persons, unknownSearch]);

  return (
    <div className="space-y-6 p-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-primary">Person Registry</h1>
          <p className="text-muted-foreground">Manage known individuals and their access permissions</p>
        </div>
        <Button
          onClick={() => {
            if (showForm && !editingId) { setShowForm(false); return; }
            setEditingId(null);
            reset({ name: "", role: "staff", isBlacklisted: false });
            setPhotoBase64("");
            setShowForm(true);
          }}
          className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {showForm && !editingId ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showForm && !editingId ? "Cancel" : "Add Person"}
        </Button>
      </div>

      {/* Inline Add / Edit form */}
      {showForm && (
        <Card className="border-border/60 bg-card/60">
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold mb-4">{editingId ? "Edit Person" : "Add New Person"}</h2>
            {settings?.testMode && !editingId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mb-4 h-7 text-[10px] gap-1.5 border-yellow-500/30 text-yellow-500 hover:bg-yellow-500/10"
                onClick={() => reset({ name: `Test User ${Math.floor(Math.random() * 1000)}`, role: ["staff","contractor","admin","visitor"][Math.floor(Math.random() * 4)] as any })}
              >
                <Sparkles className="w-3 h-3" /> Fill Test Data
              </Button>
            )}
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 max-w-lg">
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
                {photoBase64 && <div className="mt-1 text-xs text-green-500">Photo selected ✓</div>}
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
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  )}
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" className="bg-primary text-primary-foreground hover:bg-primary/90">
                  {editingId ? "Update" : "Create"}
                </Button>
                <Button type="button" variant="outline" onClick={() => { setShowForm(false); setEditingId(null); reset(); }}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

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

          <div className="relative group">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
            <Input
              placeholder="Search individuals..."
              className="pl-10 w-64 bg-card/30 border-border/40 focus:border-primary/50 transition-all"
              onChange={e => { setKnownSearch(e.target.value); setUnknownSearch(e.target.value); }}
            />
          </div>
        </div>

        {/* Known Registry */}
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
                        <TableRow key={person.id} className="border-border/50 hover:bg-primary/5 group transition-colors">
                          <TableCell className="pl-6">
                            <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center border border-border/50 group-hover:border-primary/30 transition-all overflow-hidden shadow-inner">
                              {person.photoUrl
                                ? <img src={person.photoUrl} alt={person.name} className="w-full h-full object-cover" />
                                : <User className="w-6 h-6 text-muted-foreground" />
                              }
                            </div>
                          </TableCell>
                          <TableCell className="font-semibold text-foreground/90">
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2 flex-wrap">
                                {person.name}
                                {person.isBlacklisted && (
                                  <Badge variant="destructive" className="text-[10px] h-4 px-1 animate-pulse">BLACKLISTED</Badge>
                                )}
                                {/* Multi-encoding count badge */}
                                {(() => {
                                  const count = Array.isArray(person.faceEncodings) ? person.faceEncodings.length : (person.faceEncoding ? 1 : 0);
                                  return count > 0 ? (
                                    <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-cyan-500/30 text-cyan-400">
                                      <Fingerprint className="w-2.5 h-2.5 mr-0.5" /> {count}/5
                                    </Badge>
                                  ) : null;
                                })()}
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
                            <div className="flex flex-wrap gap-1">
                              {(personGroupsMap.get(person.id) ?? []).length > 0
                                ? (personGroupsMap.get(person.id) ?? []).map(g => (
                                    <Badge
                                      key={g.groupId}
                                      variant="outline"
                                      className="text-[9px] h-4 px-1.5 leading-none border"
                                      style={{ borderColor: g.groupColor + "60", color: g.groupColor }}
                                    >
                                      {g.groupName}
                                    </Badge>
                                  ))
                                : <span className="text-[11px] text-muted-foreground italic">No group</span>
                              }
                            </div>
                          </TableCell>
                          <TableCell className="text-xs font-medium text-muted-foreground">
                            {person.activityHistory?.length > 0
                              ? new Date(person.activityHistory[0].timestamp).toLocaleDateString()
                              : "No data"}
                          </TableCell>
                          <TableCell className="text-right pr-6">
                            <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button size="icon" variant="ghost" onClick={() => setLocation(`/persons/${person.id}/timeline`)} className="h-8 w-8 text-cyan-400 hover:text-cyan-300 hover:bg-cyan-400/10" title="View timeline">
                                <Clock className="w-4 h-4" />
                              </Button>
                              <Button size="icon" variant="ghost" onClick={() => { setAnglePersonId(person.id); setAngleBase64(""); }} className="h-8 w-8 text-green-400 hover:text-green-300 hover:bg-green-400/10" title="Add photo angle">
                                <Camera className="w-4 h-4" />
                              </Button>
                              <Button size="icon" variant="ghost" onClick={() => setLocation(`/persons/${person.id}`)} className="h-8 w-8 text-blue-400 hover:text-blue-300 hover:bg-blue-400/10">
                                <Eye className="w-4 h-4" />
                              </Button>
                              <Button size="icon" variant="ghost" onClick={() => handleEdit(person)} className="h-8 w-8 text-primary hover:bg-primary/10">
                                <Edit className="w-4 h-4" />
                              </Button>
                              <Button size="icon" variant="ghost" onClick={() => handleDelete(person.id)} className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-500/10">
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

        {/* Blacklist */}
        <TabsContent value="blacklist" className="mt-0">
          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {[1,2,3,4,5].map(i => <Skeleton key={i} className="aspect-[3/4] rounded-xl" />)}
            </div>
          ) : blacklistedPersons.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {blacklistedPersons.map((person: any) => (
                <div
                  key={person.id}
                  onClick={() => setLocation(`/persons/${person.id}`)}
                  className="group relative cursor-pointer rounded-xl overflow-hidden border border-red-500/20 bg-card/50 hover:border-red-500/60 hover:shadow-[0_0_20px_rgba(239,68,68,0.15)] transition-all duration-200"
                >
                  <div className="aspect-[3/4] bg-red-500/5 flex items-center justify-center overflow-hidden">
                    {person.photoUrl ? (
                      <img src={person.photoUrl} alt={person.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                    ) : (
                      <AlertTriangle className="w-12 h-12 text-red-500/30" />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-70 group-hover:opacity-90 transition-opacity" />
                  </div>
                  <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/60 backdrop-blur-sm px-2 py-1 rounded-full">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-[9px] font-bold text-red-400 uppercase tracking-wider">Live</span>
                  </div>
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

        {/* Unknown Detections */}
        <TabsContent value="unknown" className="mt-0">
          {unknownPersons.length > 0 && (
            <div className="flex justify-end mb-3">
              <Button
                onClick={() => setLocation("/persons/review")}
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
                                onClick={() => setLocation(`/persons/review?personId=${person.id}`)}
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

      {/* Add Photo Angle dialog */}
      {anglePersonId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <Card className="w-96 border-border/60 bg-card/95">
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold flex items-center gap-2">
                  <Camera className="w-4 h-4 text-green-400" /> Add Photo Angle
                </h3>
                <Button size="icon" variant="ghost" onClick={() => { setAnglePersonId(null); setAngleBase64(""); }}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Upload an additional face angle to improve recognition accuracy (max 5 total).
              </p>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                id="angle-upload"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onloadend = () => setAngleBase64(reader.result as string);
                    reader.readAsDataURL(file);
                  }
                }}
              />
              {angleBase64 ? (
                <img src={angleBase64} className="w-full h-40 object-contain rounded border border-border/50" alt="preview" />
              ) : (
                <label
                  htmlFor="angle-upload"
                  className="flex flex-col items-center justify-center h-32 border border-dashed border-green-500/30 rounded-lg cursor-pointer hover:bg-green-500/5 transition-colors"
                >
                  <Camera className="w-8 h-8 text-green-400/50 mb-2" />
                  <span className="text-xs text-muted-foreground">Click to select image</span>
                </label>
              )}
              {angleBase64 && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 bg-green-500/20 text-green-400 border-green-500/30 hover:bg-green-500/30"
                    variant="outline"
                    disabled={addEncodingMutation.isPending}
                    onClick={async () => {
                      try {
                        const result = await addEncodingMutation.mutateAsync({
                          personId: anglePersonId!,
                          photoBase64: angleBase64,
                        });
                        toast.success(`Angle added (${result.encodingCount}/5 total)`);
                        setAnglePersonId(null);
                        setAngleBase64("");
                        refetch();
                      } catch (e: any) {
                        toast.error(`Failed: ${e.message}`);
                      }
                    }}
                  >
                    {addEncodingMutation.isPending ? "Saving…" : "Save Angle"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAngleBase64("")}>
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
