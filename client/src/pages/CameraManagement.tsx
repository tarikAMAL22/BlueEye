import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Plus, Edit, Trash2, Eye, Power, PowerOff } from "lucide-react";
import { useForm, Controller } from "react-hook-form";
import { toast } from "sonner";
import { HlsPlayer } from "@/components/HlsPlayer";

export default function CameraManagement() {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [previewCamera, setPreviewCamera] = useState<any>(null);
  const { register, handleSubmit, reset, control, setValue } = useForm();

  const { data: cameras, isLoading, refetch } = trpc.cameras.list.useQuery();
  const { data: zones } = trpc.zones.list.useQuery();
  const createMutation = trpc.cameras.create.useMutation();
  const updateMutation = trpc.cameras.update.useMutation();
  const deleteMutation = trpc.cameras.delete.useMutation();

  const onSubmit = async (data: any) => {
    try {
      // Strip frontend/DB injected fields
      const { createdAt, updatedAt, lastSeen, originalStatus, ...payload } = data;
      
      // Sanitize properties
      const sanitized = {
        name: payload.name,
        rtspUrl: payload.rtspUrl,
        location: payload.location || undefined,
        zoneId: payload.zoneId ? Number(payload.zoneId) : undefined,
        status: payload.status || "offline"
      };

      if (editingId) {
        await updateMutation.mutateAsync({ id: editingId, ...sanitized });
        toast.success("Camera updated successfully");
      } else {
        await createMutation.mutateAsync(sanitized);
        toast.success("Camera created successfully");
      }
      reset();
      setOpen(false);
      setEditingId(null);
      refetch();
    } catch (error: any) {
      console.error("Error saving camera:", error);
      toast.error(`Error saving camera: ${error.message}`);
    }
  };

  const handleToggleStatus = async (id: number, currentStatus: string) => {
    const newStatus = currentStatus === "online" ? "offline" : "online";
    try {
      await updateMutation.mutateAsync({ id, status: newStatus as any });
      toast.success(`Camera marked as ${newStatus}`);
      refetch();
    } catch (error: any) {
      toast.error(`Failed to update status: ${error.message}`);
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm("Are you sure you want to delete this camera?")) {
      try {
        await deleteMutation.mutateAsync({ id });
        refetch();
      } catch (error) {
        console.error("Error deleting camera:", error);
      }
    }
  };

  const handleEdit = (camera: any) => {
    setEditingId(camera.id);
    reset({ ...camera, zoneId: camera.zoneId ? String(camera.zoneId) : undefined });
    setOpen(true);
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "online":
        return "bg-green-400/10 text-green-400";
      case "offline":
        return "bg-gray-400/10 text-gray-400";
      case "maintenance":
        return "bg-yellow-400/10 text-yellow-400";
      default:
        return "bg-gray-400/10 text-gray-400";
    }
  };

  const mediamtxUrl = import.meta.env.VITE_MEDIAMTX_URL || "http://localhost:8888";

  const getStreamName = (rtspUrl: string) => {
    try {
      const url = new URL(rtspUrl);
      return url.pathname.replace(/^\/+/, '');
    } catch {
      return rtspUrl.split('/').pop() || '';
    }
  };

  return (
    <div className="space-y-6 p-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-primary">Camera Management</h1>
          <p className="text-muted-foreground">Add, edit, and manage RTSP cameras</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => { setEditingId(null); reset(); }} className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-4 h-4" />
              Add Camera
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-border">
            <DialogHeader>
              <DialogTitle>{editingId ? "Edit Camera" : "Add New Camera"}</DialogTitle>
              <DialogDescription>Configure camera details and RTSP stream</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label className="text-sm font-medium">Camera Name</label>
                <Input {...register("name")} placeholder="e.g., Main Entrance" className="bg-input border-border mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium">RTSP URL</label>
                <Input {...register("rtspUrl")} placeholder="rtsp://..." className="bg-input border-border mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium">Location</label>
                <Input {...register("location")} placeholder="e.g., Building A, Floor 2" className="bg-input border-border mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium">Zone</label>
                <Controller
                  name="zoneId"
                  control={control}
                  render={({ field }) => (
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger className="bg-input border-border mt-1">
                        <SelectValue placeholder="Select a zone" />
                      </SelectTrigger>
                      <SelectContent className="bg-card border-border">
                        {zones?.map((zone: any) => (
                          <SelectItem key={zone.id} value={String(zone.id)}>
                            {zone.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Status</label>
                <Controller
                  name="status"
                  control={control}
                  defaultValue="offline"
                  render={({ field }) => (
                    <Select onValueChange={field.onChange} value={field.value || "offline"}>
                      <SelectTrigger className="bg-input border-border mt-1">
                        <SelectValue placeholder="Select a status" />
                      </SelectTrigger>
                      <SelectContent className="bg-card border-border">
                        <SelectItem value="online">Online</SelectItem>
                        <SelectItem value="offline">Offline</SelectItem>
                        <SelectItem value="maintenance">Maintenance</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
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
          <CardTitle>Active Cameras</CardTitle>
          <CardDescription>Total: {cameras?.length || 0} cameras</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8">Loading cameras...</div>
          ) : cameras && cameras.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50">
                    <TableHead>Name</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Seen</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cameras.map((camera: any) => (
                    <TableRow key={camera.id} className="border-border/50 hover:bg-accent/5">
                      <TableCell className="font-medium data-value">{camera.name}</TableCell>
                      <TableCell>{camera.location || "-"}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Switch 
                            checked={camera.status === "online"} 
                            onCheckedChange={() => handleToggleStatus(camera.id, camera.status)}
                            className="data-[state=checked]:bg-green-500"
                          />
                          <Badge className={`${statusColor(camera.status)} min-w-[80px] justify-center`}>
                            {camera.status}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground data-value">
                        {camera.lastSeen ? new Date(camera.lastSeen).toLocaleString() : "Never"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setPreviewCamera(camera)}
                            className="text-primary hover:text-primary hover:bg-primary/10"
                            title="Preview Stream"
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleEdit(camera)}
                            className="text-primary hover:text-primary hover:bg-primary/10"
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(camera.id)}
                            className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No cameras configured yet. Add one to get started.
            </div>
          )}
        </CardContent>
      </Card>

        <Dialog open={!!previewCamera} onOpenChange={(val) => !val && setPreviewCamera(null)}>
        <DialogContent className="bg-card border-border max-w-4xl">
          <DialogHeader>
            <DialogTitle>{previewCamera?.name} - Live Stream</DialogTitle>
            <DialogDescription>{previewCamera?.rtspUrl}</DialogDescription>
          </DialogHeader>
          <div className="w-full aspect-video bg-black rounded-md overflow-hidden relative border border-border/50">
            {previewCamera && (
              <HlsPlayer
                streamUrl={`/hls-proxy/${getStreamName(previewCamera.rtspUrl)}/index.m3u8`}
              />
            )}
            <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-sm px-2 py-1 rounded text-xs font-mono text-white flex gap-2 items-center z-10">
              <div className="status-pulse w-2 h-2 rounded-full bg-red-500" />
              LIVE
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
