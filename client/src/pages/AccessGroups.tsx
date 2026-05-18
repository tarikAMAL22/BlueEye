import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus, Trash2, UsersRound, Shield, X, Check, Users,
  ChevronDown, ChevronRight,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";

const PRESET_COLORS = ["#00F5FF", "#9333EA", "#EF4444", "#F59E0B", "#10B981", "#3B82F6", "#EC4899", "#8B5CF6"];

function GroupCard({
  group,
  onDelete,
  onRefresh,
}: {
  group: any;
  onDelete: (id: number) => void;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [addingZone, setAddingZone] = useState(false);
  const [addingMember, setAddingMember] = useState(false);

  const { data: zones } = trpc.zones.list.useQuery();
  const { data: persons } = trpc.persons.list.useQuery();
  const { data: groupZones, refetch: refetchZones } = trpc.groups.getZones.useQuery({ groupId: group.id }, { enabled: expanded });
  const { data: members, refetch: refetchMembers } = trpc.groups.getMembers.useQuery({ groupId: group.id }, { enabled: expanded });

  const addZoneMutation     = trpc.groups.addZone.useMutation();
  const removeZoneMutation  = trpc.groups.removeZone.useMutation();
  const addMemberMutation   = trpc.groups.addMember.useMutation();
  const removeMemberMutation = trpc.groups.removeMember.useMutation();

  const assignedZoneIds   = useMemo(() => new Set((groupZones ?? []).map((gz: any) => gz.zoneId)), [groupZones]);
  const assignedPersonIds = useMemo(() => new Set((members ?? []).map((m: any) => m.personId)), [members]);

  const availableZones   = useMemo(() => (zones ?? []).filter((z: any) => !assignedZoneIds.has(z.id)), [zones, assignedZoneIds]);
  const availablePersons = useMemo(() => (persons ?? []).filter((p: any) => !assignedPersonIds.has(p.id)), [persons, assignedPersonIds]);

  const handleAddZone = async (zoneId: number) => {
    try {
      await addZoneMutation.mutateAsync({ groupId: group.id, zoneId });
      refetchZones();
      setAddingZone(false);
      toast.success("Zone added to group");
    } catch { toast.error("Failed to add zone"); }
  };

  const handleRemoveZone = async (zoneId: number) => {
    try {
      await removeZoneMutation.mutateAsync({ groupId: group.id, zoneId });
      refetchZones();
      toast.success("Zone removed");
    } catch { toast.error("Failed to remove zone"); }
  };

  const handleAddMember = async (personId: number) => {
    try {
      await addMemberMutation.mutateAsync({ groupId: group.id, personId });
      refetchMembers();
      setAddingMember(false);
      toast.success("Member added");
    } catch { toast.error("Failed to add member"); }
  };

  const handleRemoveMember = async (personId: number) => {
    try {
      await removeMemberMutation.mutateAsync({ groupId: group.id, personId });
      refetchMembers();
      toast.success("Member removed");
    } catch { toast.error("Failed to remove member"); }
  };

  return (
    <Card className="border-border/60 bg-card/50 overflow-hidden">
      <CardContent className="p-0">
        {/* Header row */}
        <div
          className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-muted/20 transition-colors select-none"
          onClick={() => setExpanded(e => !e)}
        >
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: group.color ?? "#888" }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground">{group.name}</span>
              {group.isDefault && (
                <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-primary/40 text-primary">Default</Badge>
              )}
            </div>
            {group.description && (
              <p className="text-[11px] text-muted-foreground truncate mt-0.5">{group.description}</p>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Shield className="w-3 h-3" />{(groupZones ?? []).length} zones</span>
            <span className="flex items-center gap-1"><Users className="w-3 h-3" />{(members ?? []).length} members</span>
          </div>
          <div className="flex items-center gap-1">
            {!group.isDefault && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-red-500 hover:bg-red-500/10"
                onClick={e => { e.stopPropagation(); onDelete(group.id); }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </div>
        </div>

        {/* Expanded content */}
        {expanded && (
          <div className="border-t border-border/40 grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border/40">
            {/* Zones panel */}
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Authorized Zones</h4>
                <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1 px-2" onClick={() => setAddingZone(true)}>
                  <Plus className="w-3 h-3" /> Add Zone
                </Button>
              </div>
              {addingZone && (
                <div className="flex flex-col gap-1.5 p-2 bg-muted/30 rounded border border-border/40">
                  <p className="text-[10px] text-muted-foreground">Select a zone to grant access:</p>
                  {availableZones.length === 0
                    ? <p className="text-[10px] italic text-muted-foreground">All zones already added.</p>
                    : availableZones.map((z: any) => (
                        <button
                          key={z.id}
                          className="text-left text-xs px-2 py-1 rounded hover:bg-primary/10 hover:text-primary transition-colors"
                          onClick={() => handleAddZone(z.id)}
                        >
                          {z.name}
                        </button>
                      ))
                  }
                  <Button size="sm" variant="ghost" className="h-6 text-[10px] self-start" onClick={() => setAddingZone(false)}>
                    <X className="w-3 h-3 mr-1" /> Cancel
                  </Button>
                </div>
              )}
              <div className="space-y-1">
                {(groupZones ?? []).length === 0
                  ? <p className="text-[11px] italic text-muted-foreground">No zones assigned yet.</p>
                  : (groupZones ?? []).map((gz: any) => (
                      <div key={gz.zoneId} className="flex items-center justify-between px-2 py-1.5 rounded bg-muted/20 border border-border/30">
                        <span className="text-xs flex items-center gap-1.5">
                          <Shield className="w-3 h-3 text-primary/60" />
                          {gz.zone?.name ?? `Zone #${gz.zoneId}`}
                        </span>
                        <button
                          className="text-red-500/60 hover:text-red-500 transition-colors"
                          onClick={() => handleRemoveZone(gz.zoneId)}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))
                }
              </div>
            </div>

            {/* Members panel */}
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Members</h4>
                <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1 px-2" onClick={() => setAddingMember(true)}>
                  <Plus className="w-3 h-3" /> Add Member
                </Button>
              </div>
              {addingMember && (
                <div className="flex flex-col gap-1.5 p-2 bg-muted/30 rounded border border-border/40">
                  <p className="text-[10px] text-muted-foreground">Select a person:</p>
                  {availablePersons.length === 0
                    ? <p className="text-[10px] italic text-muted-foreground">All persons already members.</p>
                    : availablePersons.map((p: any) => (
                        <button
                          key={p.id}
                          className="text-left text-xs px-2 py-1 rounded hover:bg-primary/10 hover:text-primary transition-colors"
                          onClick={() => handleAddMember(p.id)}
                        >
                          {p.name} <span className="text-muted-foreground">({p.role})</span>
                        </button>
                      ))
                  }
                  <Button size="sm" variant="ghost" className="h-6 text-[10px] self-start" onClick={() => setAddingMember(false)}>
                    <X className="w-3 h-3 mr-1" /> Cancel
                  </Button>
                </div>
              )}
              <div className="space-y-1">
                {(members ?? []).length === 0
                  ? <p className="text-[11px] italic text-muted-foreground">No members yet.</p>
                  : (members ?? []).map((m: any) => (
                      <div key={m.personId} className="flex items-center justify-between px-2 py-1.5 rounded bg-muted/20 border border-border/30">
                        <span className="text-xs flex items-center gap-1.5">
                          <Users className="w-3 h-3 text-primary/60" />
                          {m.person?.name ?? `Person #${m.personId}`}
                          <span className="text-muted-foreground text-[10px]">· {m.person?.role}</span>
                        </span>
                        <button
                          className="text-red-500/60 hover:text-red-500 transition-colors"
                          onClick={() => handleRemoveMember(m.personId)}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))
                }
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AccessGroups() {
  const [showCreate, setShowCreate] = useState(false);
  const { data: groups, isLoading, refetch } = trpc.groups.list.useQuery();
  const createMutation = trpc.groups.create.useMutation();
  const deleteMutation = trpc.groups.delete.useMutation();

  const { register, handleSubmit, reset, watch, setValue } = useForm({
    defaultValues: { name: "", description: "", color: "#00F5FF", isDefault: false },
  });
  const selectedColor = watch("color");

  const onSubmit = async (data: any) => {
    try {
      await createMutation.mutateAsync(data);
      reset();
      setShowCreate(false);
      refetch();
      toast.success("Access group created");
    } catch (e: any) { toast.error(e.message); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this access group? All zone and member assignments will also be removed.")) return;
    try {
      await deleteMutation.mutateAsync({ id });
      refetch();
      toast.success("Group deleted");
    } catch { toast.error("Failed to delete group"); }
  };

  return (
    <div className="space-y-6 p-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-primary flex items-center gap-3">
            <UsersRound className="w-8 h-8" /> Access Groups
          </h1>
          <p className="text-muted-foreground mt-1">
            Define groups, assign zones, and control who can enter where.
          </p>
        </div>
        <Button
          className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={() => setShowCreate(s => !s)}
        >
          {showCreate ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showCreate ? "Cancel" : "New Group"}
        </Button>
      </div>

      {/* Create form */}
      {showCreate && (
        <Card className="border-primary/30 bg-card/60">
          <CardContent className="p-6">
            <h2 className="text-base font-semibold mb-4">Create Access Group</h2>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 max-w-lg">
              <div>
                <Label className="text-sm">Name *</Label>
                <Input {...register("name")} placeholder="e.g., Staff, Visitors" className="mt-1" />
              </div>
              <div>
                <Label className="text-sm">Description</Label>
                <Input {...register("description")} placeholder="Short description" className="mt-1" />
              </div>
              <div>
                <Label className="text-sm">Color</Label>
                <div className="flex items-center gap-2 mt-1">
                  {PRESET_COLORS.map(c => (
                    <button
                      type="button"
                      key={c}
                      className="w-6 h-6 rounded-full border-2 transition-all"
                      style={{ backgroundColor: c, borderColor: selectedColor === c ? "white" : "transparent" }}
                      onClick={() => setValue("color", c)}
                    />
                  ))}
                  <Input {...register("color")} className="h-7 w-28 text-xs" />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" className="bg-primary text-primary-foreground hover:bg-primary/90">
                  Create Group
                </Button>
                <Button type="button" variant="outline" onClick={() => { setShowCreate(false); reset(); }}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Group list */}
      <div className="space-y-3">
        {isLoading ? (
          [1, 2, 3].map(i => <Skeleton key={i} className="h-16 rounded-xl" />)
        ) : !groups || groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-3 border border-dashed border-border/50 rounded-xl">
            <UsersRound className="w-8 h-8 opacity-30" />
            <p className="text-sm italic">No access groups yet. Create one above.</p>
          </div>
        ) : (
          groups.map((group: any) => (
            <GroupCard
              key={group.id}
              group={group}
              onDelete={handleDelete}
              onRefresh={refetch}
            />
          ))
        )}
      </div>
    </div>
  );
}
