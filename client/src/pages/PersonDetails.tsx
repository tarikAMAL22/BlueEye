import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  User,
  Shield,
  History,
  ArrowLeft,
  CheckCircle,
  AlertCircle,
  Link as LinkIcon,
  Trash2,
  Scan,
  UserCheck,
  Search,
  ChevronDown,
  RefreshCw,
  Edit2,
  Save,
  X,
  Sparkles,
  Eye,
  UserMinus,
  Video,
  Camera,
  Check,
  AlertTriangle,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Slider } from "@/components/ui/slider";
import { useEffect } from "react";

export default function PersonDetails() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const personId = parseInt(id || "0");

  // Biometric Search Threshold (0-100 score mapped to 1.0-0.0 distance)
  const [searchScore, setSearchScore] = useState(() => {
    const saved = localStorage.getItem("blueeye_search_score");
    return saved ? parseInt(saved) : 50;
  });

  useEffect(() => {
    localStorage.setItem("blueeye_search_score", searchScore.toString());
  }, [searchScore]);

  // Map score (0-100) to distance threshold (1.0 - 0.0)
  const threshold = 1.0 - (searchScore / 100);

  const { data: person, isLoading: isPersonLoading } = trpc.persons.getById.useQuery({ id: personId });
  const { data: history, isLoading: isHistoryLoading } = trpc.alerts.getByPerson.useQuery({ personId });
  const { data: matches, isLoading: isMatchesLoading, refetch: refetchMatches } = trpc.persons.getPotentialMatches.useQuery({ 
    personId, 
    threshold 
  });
  const { data: personsList } = trpc.persons.list.useQuery(undefined, { staleTime: 0 });
  const { data: zones } = trpc.zones.list.useQuery();
  const { data: cameras } = trpc.cameras.list.useQuery();
  const { data: settings } = trpc.settings.get.useQuery();

  const [searchQuery, setSearchQuery] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState("");
  const [editedRole, setEditedRole] = useState("");
  const [selectedAlertDetail, setSelectedAlertDetail] = useState<any>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [photoBase64, setPhotoBase64] = useState<string>("");

  const updateMutation = trpc.persons.update.useMutation();
  const mergeMutation = trpc.persons.mergePersons.useMutation();
  const notHimMutation = trpc.alerts.notHim.useMutation();
  const computeEncodingMutation = trpc.persons.computeEncoding.useMutation();

  const handleEditStart = () => {
    if (person) {
      setEditedName(person.name);
      setEditedRole(person.role);
      setPhotoBase64("");
      setIsEditing(true);
    }
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

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        id: personId,
        name: editedName,
        role: editedRole,
        photoBase64: photoBase64 || undefined
      });
      toast.success("Profile updated");
      setIsEditing(false);
      window.location.reload();
    } catch (error: any) {
      toast.error(`Update failed: ${error.message}`);
    }
  };

  const handleToggleBlacklist = async () => {
    const next = !person.isBlacklisted;
    try {
      await updateMutation.mutateAsync({ id: personId, isBlacklisted: next });
      toast.success(next ? "Added to watchlist — critical alerts enabled." : "Removed from watchlist.");
      window.location.reload();
    } catch (error: any) {
      toast.error(`Failed: ${error.message}`);
    }
  };

  const handlePromoteToProfile = async (photoUrl: string) => {
    if (!confirm("Do you want to set this snapshot as the primary identity photo? This will improve AI recognition with this capture.")) {
      return;
    }

    try {
      await updateMutation.mutateAsync({
        id: personId,
        photoUrl: photoUrl
      });
      toast.success("Profile photo updated successfully");
      window.location.reload();
    } catch (error: any) {
      toast.error(`Update failed: ${error.message}`);
    }
  };

  const handleMerge = async (matchId: number, matchName: string, matchRole: string) => {
    const isCurrentUnknown = person.role.toLowerCase() === "unknown" || person.name.toLowerCase().startsWith("unknown-");
    const isMatchUnknown = matchRole.toLowerCase() === "unknown" || matchName.toLowerCase().startsWith("unknown-");

    // Rule: Always merge UNKNOWN into KNOWN
    let sourceId: number;
    let targetId: number;
    let targetName: string;

    if (isCurrentUnknown && !isMatchUnknown) {
      // Merge current (unknown) into match (known)
      sourceId = personId;
      targetId = matchId;
      targetName = matchName;
    } else {
      // Merge match (unknown) into current (known)
      sourceId = matchId;
      targetId = personId;
      targetName = person.name;
    }

    if (!confirm(`Are you sure you want to merge these identities? All history will be moved to ${targetName} and the unidentified record will be deleted.`)) {
      return;
    }

    try {
      await mergeMutation.mutateAsync({ sourceId, targetId });
      toast.success(`Identity merged into ${targetName}`);
      
      // If we merged the current person away, redirect to the survivor
      if (sourceId === personId) {
        setLocation(`/persons/${targetId}`);
      } else {
        refetchMatches();
      }
    } catch (error: any) {
      toast.error(`Merge failed: ${error.message}`);
    }
  };

  const handleNotHim = async (alertId: number) => {
    if (!confirm("Are you sure this is NOT the correct person? The alert will be unassigned and queued for re-review.")) {
      return;
    }

    try {
      await notHimMutation.mutateAsync({ alertId });
      toast.success("Correction saved. CV worker will sync in ≤30s.");
      window.location.reload();
    } catch (error: any) {
      if (error.message?.includes('CV Worker')) {
        toast.success("Correction enregistrée (sync CV worker dans 30s)");
        window.location.reload();
      } else {
        toast.error(`Correction failed: ${error.message}`);
      }
    }
  };

  if (isPersonLoading) {
    return <div className="p-8 space-y-6">
      <Skeleton className="h-10 w-48" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Skeleton className="h-64 col-span-1" />
        <Skeleton className="h-64 col-span-2" />
      </div>
    </div>;
  }

  if (!person) {
    return <div className="p-8 text-center space-y-4">
      <h1 className="text-2xl font-bold">Person not found</h1>
      <Button onClick={() => setLocation("/persons")}>Back to Registry</Button>
    </div>;
  }

  const getCameraName = (id: number) => cameras?.find(c => c.id === id)?.name || `Camera #${id}`;
  const getZoneName = (id: number) => zones?.find(z => z.id === id)?.name || `Zone #${id}`;

  return (
    <>
      <div className="space-y-6 p-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/persons")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          {!isEditing ? (
            <div>
              <h1 className="text-3xl font-bold text-primary flex items-center gap-3">
                {person.name}
                <Badge variant="outline" className="text-xs uppercase tracking-widest">{person.role}</Badge>
                {person.isBlacklisted && (
                  <Badge className="bg-red-600 text-white text-[10px] uppercase tracking-wider animate-pulse px-2 py-0.5 gap-1">
                    <AlertTriangle className="w-3 h-3" /> WATCHLIST
                  </Badge>
                )}
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={handleEditStart}>
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={`h-8 px-3 text-xs gap-1.5 transition-colors ${person.isBlacklisted ? "border-red-500/50 text-red-400 hover:bg-red-500/10 bg-red-500/5" : "border-border/50 text-muted-foreground hover:border-red-500/50 hover:text-red-400 hover:bg-red-500/5"}`}
                  disabled={updateMutation.isPending}
                  onClick={handleToggleBlacklist}
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {person.isBlacklisted ? "Remove from Watchlist" : "Add to Watchlist"}
                </Button>
              </h1>
              <p className="text-muted-foreground">ID: {person.id} • Created {new Date(person.createdAt).toLocaleDateString()}</p>
            </div>
          ) : (
            <div className="flex items-end gap-3 animate-in slide-in-from-left-2">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Full Name</Label>
                <Input 
                  value={editedName} 
                  onChange={(e) => setEditedName(e.target.value)} 
                  className="bg-background/50 h-9 min-w-[250px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Role</Label>
                <Input 
                  value={editedRole} 
                  onChange={(e) => setEditedRole(e.target.value)} 
                  className="bg-background/50 h-9 w-32"
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" className="bg-primary" onClick={handleSave} disabled={updateMutation.isPending}>
                  <Save className="w-4 h-4 mr-2" /> Save
                </Button>
                <Button size="sm" variant="outline" onClick={() => setIsEditing(false)}>
                  <X className="w-4 h-4 mr-2" /> Cancel
                </Button>
                {settings?.testMode && (
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="border-yellow-500/30 text-yellow-500 hover:bg-yellow-500/10 gap-1.5"
                    onClick={() => {
                      setEditedName(`Test User ${Math.floor(Math.random() * 1000)}`);
                      setEditedRole(["staff", "contractor", "admin", "visitor"][Math.floor(Math.random() * 4)]);
                    }}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Fill Test
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Profile Card */}
        <Card className="glow-card bg-card/50 backdrop-blur border-primary/20">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-tighter flex items-center gap-2">
              <User className="w-4 h-4" />
              Identity Profile
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className={`aspect-square rounded-xl overflow-hidden bg-muted border border-border/50 relative group ${isEditing ? 'cursor-pointer hover:ring-2 ring-primary transition-all' : ''}`}>
              {photoBase64 ? (
                <img src={photoBase64} alt="New profile" className="w-full h-full object-cover" />
              ) : person.photoUrl ? (
                <img src={person.photoUrl} alt={person.name} className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-500" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <User className="w-20 h-20 text-muted-foreground/20" />
                </div>
              )}
              
              {isEditing ? (
                <label className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center cursor-pointer">
                  <Camera className="w-10 h-10 text-white mb-2" />
                  <span className="text-white text-xs font-bold uppercase">Change Photo</span>
                  <input type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
                </label>
              ) : (
                <div className="absolute top-2 right-2">
                  <Badge className="bg-primary/80 backdrop-blur-sm border-none">Primary Identity Photo</Badge>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded bg-muted/30 border border-border/50">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">Access Permissions</span>
                </div>
                <Badge variant="outline" className="bg-green-500/10 text-green-400 border-green-500/20">Active</Badge>
              </div>
              
              <div className="flex flex-wrap gap-2">
                {zones?.map((zone: any) => (
                  <Badge key={zone.id} variant="secondary" className="text-[10px]">
                    {zone.name}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Biometric Matching Card */}
        <Card className="col-span-1 lg:col-span-2 glow-card bg-card/50 backdrop-blur border-blue-500/20">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-sm uppercase tracking-tighter flex items-center gap-2">
                <Scan className="w-4 h-4 text-blue-400" />
                Potential Biometric Matches
              </CardTitle>
              <CardDescription>AI detected unknown persons that might be {person.name}</CardDescription>
            </div>
            <div className="flex items-center gap-6">
              <div className="flex flex-col items-end gap-1.5 min-w-[140px]">
                <div className="flex justify-between w-full px-1">
                  <span className="text-[10px] uppercase text-muted-foreground font-bold">Match Score</span>
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
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-3 text-xs gap-1.5 border-blue-500/30 text-blue-400 hover:bg-blue-500/10"
                  disabled={computeEncodingMutation.isPending}
                  title="Compute face encoding from the profile photo so this person appears in biometric matches"
                  onClick={async () => {
                    try {
                      const result = await computeEncodingMutation.mutateAsync({ personId });
                      if ((result as any).status === "ok") {
                        toast.success("Encoding computed — refreshing matches...");
                        refetchMatches();
                      } else {
                        toast.warning(`No face detected in photo (status: ${(result as any).status})`);
                      }
                    } catch (e: any) {
                      toast.error(`Encoding failed: ${e.message}`);
                    }
                  }}
                >
                  <Scan className={`w-3.5 h-3.5 ${computeEncodingMutation.isPending ? "animate-pulse" : ""}`} />
                  {computeEncodingMutation.isPending ? "Computing..." : "Compute Encoding"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-8 w-8 text-muted-foreground hover:text-blue-400 ${isMatchesLoading ? 'animate-spin' : ''}`}
                  onClick={() => refetchMatches()}
                  title="Scan for new matches"
                >
                  <RefreshCw className="w-4 h-4" />
                </Button>
                {!isMatchesLoading && matches && (
                  <Badge variant="outline" className="border-blue-500/50 text-blue-400">
                    {matches.filter((m: any) => m.id !== personId).length} Matches Found
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* AI Potential Matches */}
            {isMatchesLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : matches && matches.filter((m: any) => {
                if (m.id === personId) return false;
                const isCurrentUnknown = person?.role.toLowerCase() === "unknown" || person?.name.toLowerCase().startsWith("unknown-");
                const isMatchUnknown = m.role.toLowerCase() === "unknown" || m.name.toLowerCase().startsWith("unknown-");
                
                // If current is unknown, show known matches. If current is known, show unknown matches.
                return isCurrentUnknown ? !isMatchUnknown : isMatchUnknown;
              }).length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {matches.filter((m: any) => {
                  if (m.id === personId) return false;
                  const isCurrentUnknown = person?.role.toLowerCase() === "unknown" || person?.name.toLowerCase().startsWith("unknown-");
                  const isMatchUnknown = m.role.toLowerCase() === "unknown" || m.name.toLowerCase().startsWith("unknown-");
                  return isCurrentUnknown ? !isMatchUnknown : isMatchUnknown;
                }).map((match: any) => (
                  <div key={match.id} className="p-4 rounded-xl border border-border/50 bg-background/40 hover:bg-background/60 transition-colors flex items-center gap-4 group">
                    <div className="w-16 h-16 rounded-lg overflow-hidden bg-muted flex-shrink-0 border border-blue-500/30">
                      <img src={match.photoUrl} alt="Match" className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-bold text-blue-400 truncate">{match.name}</p>
                        <span className="text-[10px] font-mono font-bold text-blue-500/80">{match.matchScore}%</span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">AI Suggestion</p>
                    </div>
                    <Button 
                      size="sm" 
                      className="bg-blue-600 hover:bg-blue-700 h-8 px-3 text-xs gap-1 shadow-lg shadow-blue-900/20"
                      onClick={() => handleMerge(match.id, match.name, match.role)}
                      disabled={mergeMutation.isPending}
                    >
                      <UserCheck className="w-3.5 h-3.5" />
                      Is Him
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 border-2 border-dashed border-border/50 rounded-xl opacity-60">
                <p className="text-xs text-muted-foreground font-medium">No automatic matches found</p>
              </div>
            )}

            {/* Manual Search & Merge */}
            <div className="pt-6 border-t border-border/40">
              <div className="flex items-center gap-2 mb-4">
                <Search className="w-4 h-4 text-muted-foreground" />
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Manual Identity Link</Label>
              </div>
              
              <div className="space-y-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                  <Input 
                    placeholder="Search unknowns by name or ID..." 
                    className="pl-10 bg-background/50 border-border/50"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                <div className="max-h-[300px] overflow-y-auto space-y-2 pr-2 scrollbar-thin">
                  {personsList?.filter(p => {
                    if (p.id === personId) return false;
                    const isCurrentUnknown = person?.role.toLowerCase() === "unknown" || person?.name.toLowerCase().startsWith("unknown-");
                    const isTargetUnknown = p.role.toLowerCase() === "unknown" || p.name.toLowerCase().startsWith("unknown-");
                    
                    // Filter by bidirectional logic + search query
                    const matchesLogic = isCurrentUnknown ? !isTargetUnknown : isTargetUnknown;
                    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || String(p.id).includes(searchQuery);
                    
                    return matchesLogic && matchesSearch;
                  }).slice(0, 10).map((candidate: any) => (
                    <div key={candidate.id} className="flex items-center justify-between p-3 rounded-lg bg-background/30 border border-border/40 hover:border-blue-500/50 transition-all group">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded overflow-hidden border border-border/50">
                          <img src={candidate.photoUrl} className="w-full h-full object-cover" />
                        </div>
                        <div>
                          <p className="text-sm font-bold truncate">{candidate.name}</p>
                          <p className="text-[10px] text-muted-foreground">Registered {new Date(candidate.createdAt).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <Button 
                        size="sm" 
                        variant="ghost"
                        className="text-blue-400 hover:text-blue-300 hover:bg-blue-400/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleMerge(candidate.id, candidate.name, candidate.role)}
                        disabled={mergeMutation.isPending}
                      >
                        <LinkIcon className="w-4 h-4 mr-1.5" />
                        Merge
                      </Button>
                    </div>
                  ))}
                  {searchQuery && personsList?.filter(p => {
                    if (p.id === personId) return false;
                    const isCurrentUnknown = person?.role.toLowerCase() === "unknown" || person?.name.toLowerCase().startsWith("unknown-");
                    const isTargetUnknown = p.role.toLowerCase() === "unknown" || p.name.toLowerCase().startsWith("unknown-");
                    return (isCurrentUnknown ? !isTargetUnknown : isTargetUnknown) && 
                           (p.name.toLowerCase().includes(searchQuery.toLowerCase()) || String(p.id).includes(searchQuery));
                  }).length === 0 && (
                    <p className="text-center py-4 text-xs text-muted-foreground">No matching persons found for "{searchQuery}"</p>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* History Card */}
        <Card className="col-span-1 lg:col-span-3 glow-card bg-card/50 backdrop-blur">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-tighter flex items-center gap-2">
              <History className="w-4 h-4" />
              Identification History
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isHistoryLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : history && history.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border/50">
                      <TableHead>Snapshot</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Camera</TableHead>
                      <TableHead>Confidence</TableHead>
                      <TableHead>Timestamp</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((alert: any) => (
                      <TableRow 
                        key={alert.id} 
                        className="border-border/50 cursor-pointer hover:bg-primary/5 transition-colors group"
                        onClick={() => {
                          setSelectedAlertDetail(alert);
                          setIsDetailOpen(true);
                        }}
                      >
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded overflow-hidden bg-muted border border-border/50 relative group/img">
                              <img src={alert.faceSnapshotUrl} className="w-full h-full object-cover" />
                              <div className="absolute inset-0 bg-primary/20 opacity-0 group-hover/img:opacity-100 flex items-center justify-center transition-opacity">
                                <Eye className="w-4 h-4 text-white" />
                              </div>
                            </div>
                            <Button
                              size="icon"
                              variant="outline"
                              className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity border-primary/30 text-primary hover:bg-primary/10"
                              title="Set as Profile Photo"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePromoteToProfile(alert.faceSnapshotUrl);
                              }}
                            >
                              <Check className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="font-medium text-sm">{getZoneName(alert.zoneId)}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">{getCameraName(alert.cameraId)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-primary" 
                                style={{ width: `${alert.confidence}%` }} 
                              />
                            </div>
                            <span className="text-xs font-mono">{alert.confidence}%</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(alert.timestamp).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-between gap-2">
                            <Badge variant="outline" className="text-[10px] uppercase">{alert.status}</Badge>
                            <div className="flex items-center gap-1">
                              <Button 
                                size="sm" 
                                variant="ghost" 
                                className="h-7 px-2 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-400/10 gap-1"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleNotHim(alert.id);
                                }}
                                disabled={notHimMutation.isPending}
                              >
                                <UserMinus className="w-3 h-3" />
                                Not Him
                              </Button>
                              <ArrowLeft className="w-3 h-3 rotate-180 opacity-0 group-hover:opacity-100 transition-opacity text-primary" />
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                No detection history for this person yet.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>

    <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
      <DialogContent className="bg-card border-border max-w-[90vw] lg:max-w-[1200px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <History className="w-4 h-4 text-primary" />
            </div>
            Identification Details
          </DialogTitle>
          <DialogDescription>Full biometric and event information recorded by the system</DialogDescription>
        </DialogHeader>

        {selectedAlertDetail && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mt-4 animate-in fade-in zoom-in-95 duration-300">
            {/* Visual Evidence */}
            <div className="lg:col-span-7 space-y-6">
              <div className="space-y-3">
                <Label className="text-xs uppercase font-bold text-muted-foreground flex items-center gap-2">
                  <Video className="w-3.5 h-3.5 text-primary" />
                  Full Scene Best Frame
                </Label>
                <div className="aspect-video rounded-xl border border-border/50 bg-black overflow-hidden relative shadow-2xl group">
                  <img src={selectedAlertDetail.bestFrameSnapshotUrl} className="w-full h-full object-contain" />
                  <div className="absolute top-4 left-4 bg-black/60 backdrop-blur px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-white flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    Source: {getCameraName(selectedAlertDetail.cameraId)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-3">
                  <Label className="text-xs uppercase font-bold text-muted-foreground">Extracted Face</Label>
                  <div className="aspect-square rounded-xl border border-border/50 bg-muted overflow-hidden shadow-lg">
                    <img src={selectedAlertDetail.faceSnapshotUrl} className="w-full h-full object-cover" />
                  </div>
                </div>
                <div className="flex flex-col justify-end">
                  <div className="p-6 rounded-xl border border-border/50 bg-card/50 shadow-inner">
                    <Label className="text-xs uppercase font-bold text-muted-foreground block mb-4">Biometric Confidence</Label>
                    <div className="flex items-center gap-4">
                      <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-primary shadow-[0_0_10px_rgba(var(--primary),0.5)]" 
                          style={{ width: `${selectedAlertDetail.confidence}%` }} 
                        />
                      </div>
                      <span className="text-2xl font-bold text-primary font-mono">{selectedAlertDetail.confidence}%</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-3 italic">
                      High confidence score indicates a strong biometric match with the registry encoding.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Event Metadata */}
            <div className="lg:col-span-5 space-y-6">
              <div className="p-6 rounded-2xl border border-primary/20 bg-primary/5 space-y-6">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-2xl bg-card border border-border overflow-hidden shadow-md">
                    <img src={person?.photoUrl} className="w-full h-full object-cover" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Currently Assigned To</h4>
                    <p className="text-2xl font-bold text-primary">{person?.name}</p>
                    <Badge variant="secondary" className="mt-1">{person?.role}</Badge>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-6 pt-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase font-bold text-muted-foreground">Zone</Label>
                    <p className="text-sm font-bold">{getZoneName(selectedAlertDetail.zoneId)}</p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase font-bold text-muted-foreground">Status</Label>
                    <Badge variant="outline" className="h-5 px-1.5 uppercase text-[9px]">{selectedAlertDetail.status}</Badge>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase font-bold text-muted-foreground">Detection Date</Label>
                    <p className="text-sm font-bold">{new Date(selectedAlertDetail.timestamp).toLocaleDateString()}</p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase font-bold text-muted-foreground">Detection Time</Label>
                    <p className="text-sm font-bold font-mono text-primary">{new Date(selectedAlertDetail.timestamp).toLocaleTimeString()}</p>
                  </div>
                </div>

                <div className="pt-4 flex gap-3">
                  <Button 
                    className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground gap-2"
                    onClick={() => setIsDetailOpen(false)}
                  >
                    <CheckCircle className="w-4 h-4" />
                    Validated
                  </Button>
                  <Button 
                    variant="outline" 
                    className="flex-1 border-red-500/30 text-red-500 hover:bg-red-500/10 gap-2"
                    onClick={() => {
                      setIsDetailOpen(false);
                      handleNotHim(selectedAlertDetail.id);
                    }}
                  >
                    <UserMinus className="w-4 h-4" />
                    Not Him
                  </Button>
                </div>
              </div>

              {selectedAlertDetail.logs && selectedAlertDetail.logs.length > 0 && (
                <div className="space-y-4">
                  <Label className="text-xs uppercase font-bold text-muted-foreground ml-1">Event Activity Log</Label>
                  <div className="space-y-2 max-h-[250px] overflow-y-auto pr-2">
                    {selectedAlertDetail.logs.map((log: any, idx: number) => (
                      <div key={idx} className="p-3 rounded-lg bg-card border border-border/50 text-[11px] leading-relaxed relative overflow-hidden group">
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary/20 group-hover:bg-primary transition-colors" />
                        <div className="flex justify-between items-start mb-1">
                          <span className="font-bold text-primary">{log.action}</span>
                          <span className="text-[9px] text-muted-foreground font-mono">{new Date(log.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <p className="text-muted-foreground">{log.details}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
