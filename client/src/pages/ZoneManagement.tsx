import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus, Edit, Trash2, Camera } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

export default function ZoneManagement() {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [threatLevel, setThreatLevel] = useState("medium");
  const { register, handleSubmit, reset } = useForm();

  const { data: zones, isLoading, refetch } = trpc.zones.list.useQuery();
  const { data: cameras } = trpc.cameras.list.useQuery();
  const createMutation = trpc.zones.create.useMutation();
  const updateMutation = trpc.zones.update.useMutation();
  const deleteMutation = trpc.zones.delete.useMutation();

  const onSubmit = async (data: any) => {
    try {
      const payload = {
        ...data,
        threatLevel,
      };
      if (editingId) {
        await updateMutation.mutateAsync({ id: editingId, ...payload });
      } else {
        await createMutation.mutateAsync(payload);
      }
      reset();
      setOpen(false);
      setEditingId(null);
      setThreatLevel("medium");
      refetch();
      toast.success(editingId ? "Zone updated" : "Zone created");
    } catch (error: any) {
      console.error("Error saving zone:", error);
      toast.error(`Error saving zone: ${error.message}`);
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm("Are you sure you want to delete this zone?")) {
      try {
        await deleteMutation.mutateAsync({ id });
        refetch();
        toast.success("Zone deleted");
      } catch (error: any) {
        console.error("Error deleting zone:", error);
        toast.error("Failed to delete zone");
      }
    }
  };

  const handleEdit = (zone: any) => {
    setEditingId(zone.id);
    setThreatLevel(zone.threatLevel);
    reset(zone);
    setOpen(true);
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

  const getAssignedCameras = (zoneId: number) => {
    return cameras?.filter((c: any) => c.zoneId === zoneId) || [];
  };

  return (
    <div className="space-y-6 p-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-primary">Zone Management</h1>
          <p className="text-muted-foreground">Create and configure security zones</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => { setEditingId(null); setThreatLevel("medium"); reset(); }} className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-4 h-4" />
              Add Zone
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-border">
            <DialogHeader>
              <DialogTitle>{editingId ? "Edit Zone" : "Add New Zone"}</DialogTitle>
              <DialogDescription>Configure zone details and threat level</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label className="text-sm font-medium">Zone Name</label>
                <Input {...register("name")} placeholder="e.g., Restricted Area A" className="bg-input border-border mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium">Description</label>
                <Input {...register("description")} placeholder="Zone description" className="bg-input border-border mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium">Threat Level</label>
                <Select value={threatLevel} onValueChange={setThreatLevel}>
                  <SelectTrigger className="bg-input border-border">
                    <SelectValue placeholder="Select threat level" />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="p-3 rounded border border-border/50 bg-muted/50">
                <p className="text-xs text-muted-foreground mb-2">Access Rules (Allowed Roles)</p>
                <div className="flex gap-2">
                  <Badge variant="outline" className="text-xs">Admin</Badge>
                  <Badge variant="outline" className="text-xs">User</Badge>
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

      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle>Security Zones</CardTitle>
          <CardDescription>Total: {zones?.length || 0} zones</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8">Loading zones...</div>
          ) : zones && zones.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50">
                    <TableHead>Zone Name</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Threat Level</TableHead>
                    <TableHead>Assigned Cameras</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {zones.map((zone: any) => {
                    const assignedCameras = getAssignedCameras(zone.id);
                    return (
                      <TableRow key={zone.id} className="border-border/50 hover:bg-accent/5">
                        <TableCell className="font-medium data-value">{zone.name}</TableCell>
                        <TableCell>{zone.description || "-"}</TableCell>
                        <TableCell>
                          <Badge className={`${threatLevelColor(zone.threatLevel)}`}>
                            {zone.threatLevel.toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Camera className="w-4 h-4 text-muted-foreground" />
                            <span className="data-value">{assignedCameras.length}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground data-value">
                          {new Date(zone.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleEdit(zone)}
                              className="text-primary hover:text-primary hover:bg-primary/10"
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleDelete(zone.id)}
                              className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No zones configured yet. Create one to get started.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Assigned Cameras Summary */}
      {zones && zones.length > 0 && (
        <Card className="glow-card bg-card/50 backdrop-blur">
          <CardHeader>
            <CardTitle>Zone-Camera Assignments</CardTitle>
            <CardDescription>Overview of camera assignments per zone</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {zones.map((zone: any) => {
                const assignedCameras = getAssignedCameras(zone.id);
                return (
                  <div key={zone.id} className="p-3 rounded border border-border/50 bg-card/50">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium data-value">{zone.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {assignedCameras.length} camera{assignedCameras.length !== 1 ? "s" : ""} assigned
                        </p>
                      </div>
                      <div className="text-right">
                        {assignedCameras.length > 0 ? (
                          <div className="flex flex-wrap gap-1 justify-end">
                            {assignedCameras.map((camera: any) => (
                              <Badge key={camera.id} variant="outline" className="text-xs">
                                {camera.name}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No cameras</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
