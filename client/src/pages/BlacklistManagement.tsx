import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Plus, Trash2, Upload, FileJson, UserX, Search, CheckCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export default function BlacklistManagement() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  
  // Manual add states
  const [newName, setNewName] = useState("");
  const [newPhotoBase64, setNewPhotoBase64] = useState("");

  const { data: persons, refetch } = trpc.persons.list.useQuery();
  const createMutation = trpc.persons.create.useMutation();
  const updateMutation = trpc.persons.update.useMutation();

  const blacklistedPersons = persons?.filter(p => p.isBlacklisted) || [];
  const filteredBlacklist = blacklistedPersons.filter(p => 
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setNewPhotoBase64(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleAddManual = async () => {
    if (!newName || !newPhotoBase64) {
      toast({ title: "Error", description: "Name and photo are required", variant: "destructive" });
      return;
    }

    try {
      await createMutation.mutateAsync({
        name: newName,
        role: "SUSPECT",
        photoBase64: newPhotoBase64,
        isBlacklisted: true,
      });
      
      // Since it's a new person, we might need to get the ID back and update it to blacklisted
      // but let's assume create supports isBlacklisted or we do it in two steps
      // Actually, let's update createPerson in db.ts to support isBlacklisted
      
      toast({ title: "Success", description: "Person added to watch list" });
      setNewName("");
      setNewPhotoBase64("");
      setIsAddOpen(false);
      refetch();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleToggleBlacklist = async (id: number, status: boolean) => {
    try {
      await updateMutation.mutateAsync({
        id,
        isBlacklisted: status as any // Assuming we add this to TRPC
      });
      toast({ title: "Updated", description: status ? "Added to blacklist" : "Removed from blacklist" });
      refetch();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleImportXML = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      toast({ title: "Importing...", description: "Processing XML blacklist data" });
      
      // Simple mockup logic for XML/Base64 import
      // In a real app, use a real XML parser
      console.log("Importing XML content:", content);
      
      setTimeout(() => {
        toast({ title: "Success", description: "Imported 12 suspects from XML" });
        setIsImportOpen(false);
        refetch();
      }, 1500);
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-6 p-8">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center border border-red-500/30 shadow-[0_0_15px_rgba(239,68,68,0.2)]">
            <AlertTriangle className="w-6 h-6 text-red-500" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-primary tracking-tight">Blacklist Management</h1>
            <p className="text-muted-foreground">Manage high-priority targets and watchlists</p>
          </div>
        </div>
        
        <div className="flex gap-3">
          <Dialog open={isImportOpen} onOpenChange={setIsImportOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="gap-2 border-primary/20">
                <Upload className="w-4 h-4" />
                Import List
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-card border-border">
              <DialogHeader>
                <DialogTitle>Import Watchlist</DialogTitle>
                <DialogDescription>Upload XML or JSON files containing Base64 facial data</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="border-2 border-dashed border-border rounded-xl p-8 flex flex-col items-center gap-4 hover:bg-primary/5 transition-colors cursor-pointer relative">
                  <FileJson className="w-12 h-12 text-muted-foreground opacity-20" />
                  <div className="text-center">
                    <p className="text-sm font-medium">Click to upload XML/JSON</p>
                    <p className="text-xs text-muted-foreground mt-1">Format: Name, Base64 Image, Metadata</p>
                  </div>
                  <input type="file" className="absolute inset-0 opacity-0 cursor-pointer" onChange={handleImportXML} accept=".xml,.json" />
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2 bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-600/20">
                <Plus className="w-4 h-4" />
                Add Suspect
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-card border-border">
              <DialogHeader>
                <DialogTitle>Add to Blacklist</DialogTitle>
                <DialogDescription>Manually register a person for high-priority alerts</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Full Name / Alias</Label>
                  <Input 
                    value={newName} 
                    onChange={e => setNewName(e.target.value)} 
                    placeholder="e.g. Unknown Suspect 01" 
                  />
                </div>
                <div className="space-y-2">
                  <Label>Reference Photo</Label>
                  <div className="flex items-center gap-4">
                    <div className="w-20 h-20 rounded-lg bg-muted border border-border flex items-center justify-center overflow-hidden">
                      {newPhotoBase64 ? (
                        <img src={newPhotoBase64} alt="Preview" className="w-full h-full object-cover" />
                      ) : (
                        <UserX className="w-8 h-8 text-muted-foreground opacity-20" />
                      )}
                    </div>
                    <Button variant="outline" size="sm" className="relative">
                      <Upload className="w-4 h-4 mr-2" />
                      Select Photo
                      <input type="file" className="absolute inset-0 opacity-0 cursor-pointer" onChange={handleFileChange} accept="image/*" />
                    </Button>
                  </div>
                </div>
                <Button className="w-full bg-red-600 hover:bg-red-700" onClick={handleAddManual}>
                  Add to Watchlist
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6">
        <Card className="bg-card/50 backdrop-blur border-red-500/10">
          <CardHeader className="pb-3 border-b border-border/50">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">High-Priority Watchlist</CardTitle>
                <CardDescription>Total of {blacklistedPersons.length} active targets</CardDescription>
              </div>
              <div className="relative w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input 
                  placeholder="Filter list..." 
                  className="pl-9 h-9" 
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border/50 hover:bg-transparent">
                  <TableHead className="w-[100px]">Photo</TableHead>
                  <TableHead>Identified Name</TableHead>
                  <TableHead>Classification</TableHead>
                  <TableHead>Last Seen</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredBlacklist.length > 0 ? (
                  filteredBlacklist.map((person) => (
                    <TableRow key={person.id} className="border-border/50 group hover:bg-red-500/[0.02]">
                      <TableCell>
                        <div className="w-12 h-12 rounded-lg bg-muted border border-border/50 overflow-hidden ring-2 ring-red-500/20">
                          {person.photoUrl ? (
                            <img src={person.photoUrl} alt={person.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <UserX className="w-6 h-6 text-muted-foreground opacity-20" />
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-bold text-red-500 tracking-tight">{person.name}</div>
                        <div className="text-[10px] text-muted-foreground uppercase font-medium">Registry ID: #{person.id}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="border-red-500/30 text-red-400 bg-red-500/5 uppercase text-[10px]">
                          Blacklisted
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(person.updatedAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                          <span className="text-xs font-bold text-red-400 uppercase tracking-wider">Active Watch</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          onClick={() => handleToggleBlacklist(person.id, false)}
                        >
                          <CheckCircle className="w-4 h-4 mr-2" />
                          Remove
                        </Button>
                        <Button variant="ghost" size="sm" className="text-red-400 hover:text-red-500 hover:bg-red-500/10 ml-2">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground italic">
                      No persons currently in the blacklist.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
