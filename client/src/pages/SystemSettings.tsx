import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Shield, User, Loader2, Trash2, AlertTriangle, RefreshCcw, Bomb, Bug, Scan } from "lucide-react";

export default function SystemSettings() {
  const [platformName, setPlatformName] = useState("BlueEye");
  const [alertThreshold, setAlertThreshold] = useState(0.75);
  const [retentionDays, setRetentionDays] = useState(90);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [pushAlerts, setPushAlerts] = useState(true);
  const [clearOnStart, setClearOnStart] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [biometricThreshold, setBiometricThreshold] = useState(0.50);
  
  // AI Engine States
  const [cvSceneBufferSec, setCvSceneBufferSec] = useState(3.0);
  const [cvDetectionInterval, setCvDetectionInterval] = useState(2);
  const [cvDownscaleFactor, setCvDownscaleFactor] = useState(0.5);
  const [cvRecognitionTolerance, setCvRecognitionTolerance] = useState(0.5);
  const [cvAlertCooldownSec, setCvAlertCooldownSec] = useState(60);
  const [cvDeepAnalysisEnabled, setCvDeepAnalysisEnabled] = useState(true);
  const [cvFaceMinHeight, setCvFaceMinHeight] = useState(40);

  const { data: settings, isLoading } = trpc.settings.get.useQuery();
  const updateMutation = trpc.settings.update.useMutation();
  const clearDataMutation = trpc.settings.clearData.useMutation();
  const fullResetMutation = trpc.settings.fullReset.useMutation();

  useEffect(() => {
    if (settings) {
      setPlatformName(settings.platformName || "BlueEye");
      setAlertThreshold(parseFloat(settings.alertThreshold as any) || 0.75);
      setRetentionDays(settings.retentionDays || 90);
      if (settings.notificationPreferences) {
        setEmailAlerts(settings.notificationPreferences.emailAlerts ?? true);
        setPushAlerts(settings.notificationPreferences.pushAlerts ?? true);
      }
      setClearOnStart(settings.clearOnStart ?? false);
      setTestMode(settings.testMode ?? false);
      setBiometricThreshold(parseFloat(settings.biometricThreshold as any) || 0.50);

      // AI Engine settings
      setCvSceneBufferSec(parseFloat(settings.cvSceneBufferSec as any) || 3.0);
      setCvDetectionInterval(settings.cvDetectionInterval || 2);
      setCvDownscaleFactor(parseFloat(settings.cvDownscaleFactor as any) || 0.5);
      setCvRecognitionTolerance(parseFloat(settings.cvRecognitionTolerance as any) || 0.5);
      setCvAlertCooldownSec(settings.cvAlertCooldownSec || 60);
      setCvDeepAnalysisEnabled(settings.cvDeepAnalysisEnabled ?? true);
      setCvFaceMinHeight(settings.cvFaceMinHeight || 40);
    }
  }, [settings]);

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        platformName,
        alertThreshold,
        retentionDays,
        notificationPreferences: {
          emailAlerts,
          pushAlerts,
        },
        clearOnStart,
        testMode,
        biometricThreshold,
        cvSceneBufferSec,
        cvDetectionInterval,
        cvDownscaleFactor,
        cvRecognitionTolerance,
        cvAlertCooldownSec,
        cvDeepAnalysisEnabled,
        cvFaceMinHeight,
      });
      toast.success("Settings saved successfully");
    } catch (error) {
      toast.error("Failed to save settings");
      console.error("Error saving settings:", error);
    }
  };

  const handleClearData = async () => {
    if (!confirm("WARNING: This will permanently delete ALL alert logs and event history. This action cannot be undone. Are you sure?")) {
      return;
    }

    try {
      await clearDataMutation.mutateAsync();
      toast.success("Database logs cleared successfully");
    } catch (error) {
      toast.error("Failed to clear database");
      console.error(error);
    }
  };

  const handleFullReset = async () => {
    if (!confirm("CRITICAL WARNING: This will delete ALL data (Alerts, Events, Persons) and ALL saved photos. The AI will no longer recognize anyone. This is irreversible. Proceed?")) {
      return;
    }

    try {
      await fullResetMutation.mutateAsync();
      toast.success("System has been fully reset");
      window.location.reload();
    } catch (error) {
      toast.error("Failed to perform system reset");
      console.error(error);
    }
  };

  if (isLoading) {
    return <div className="p-8 text-center">Loading settings...</div>;
  }

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-3xl font-bold text-primary">System Settings</h1>
        <p className="text-muted-foreground">Configure platform-wide settings and preferences</p>
      </div>

      {/* Platform Settings */}
      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle>Platform Configuration</CardTitle>
          <CardDescription>General platform settings</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <Label className="text-sm font-medium">Platform Name</Label>
            <Input
              value={platformName}
              onChange={(e) => setPlatformName(e.target.value)}
              className="bg-input border-border mt-2"
              placeholder="BlueEye"
            />
          </div>

          <div>
            <Label className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-400" />
              Alert Confidence Threshold
            </Label>
            <div className="flex items-center gap-4 mt-2">
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={alertThreshold}
                onChange={(e) => setAlertThreshold(parseFloat(e.target.value))}
                className="bg-input border-border w-24"
              />
              <span className="text-sm text-muted-foreground">
                Only alerts with confidence above {(alertThreshold * 100).toFixed(0)}% will trigger
              </span>
            </div>
          </div>

          <div>
            <Label className="text-sm font-medium flex items-center gap-2">
              <Scan className="w-4 h-4 text-blue-400" />
              Biometric Match Sensitivity (Distance)
            </Label>
            <div className="flex items-center gap-4 mt-2">
              <Input
                type="number"
                min="0.1"
                max="1.0"
                step="0.05"
                value={biometricThreshold}
                onChange={(e) => setBiometricThreshold(parseFloat(e.target.value))}
                className="bg-input border-border w-24"
              />
              <div className="text-sm text-muted-foreground flex flex-col">
                <span>Lower distance = More strict (Higher similarity required)</span>
                <span>Recommended: 0.50 - 0.60. Current: {biometricThreshold.toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div>
            <Label className="text-sm font-medium">Event Log Retention</Label>
            <div className="flex items-center gap-4 mt-2">
              <Input
                type="number"
                min="1"
                value={retentionDays}
                onChange={(e) => setRetentionDays(parseInt(e.target.value))}
                className="bg-input border-border w-24"
              />
              <span className="text-sm text-muted-foreground">
                Keep event logs for {retentionDays} days
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between p-4 rounded-lg border border-yellow-500/20 bg-yellow-500/5">
            <div className="space-y-0.5">
              <Label className="text-sm font-bold flex items-center gap-2">
                <Bug className="w-4 h-4 text-yellow-500" />
                Developer Test Mode
              </Label>
              <p className="text-xs text-muted-foreground">Enable testing utilities and automated data entry</p>
            </div>
            <Switch
              checked={testMode}
              onCheckedChange={setTestMode}
            />
          </div>
        </CardContent>
      </Card>

      {/* AI Engine & Detection Settings */}
      <Card className="glow-card bg-card/50 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scan className="w-5 h-5 text-primary" />
            AI Engine & Detection Configuration
          </CardTitle>
          <CardDescription>Optimize detection precision and hardware performance</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <Label className="text-sm font-medium">Scene Buffer (Seconds)</Label>
                <div className="flex items-center gap-4 mt-2">
                  <Input
                    type="number"
                    step="0.5"
                    value={cvSceneBufferSec}
                    onChange={(e) => setCvSceneBufferSec(parseFloat(e.target.value))}
                    className="bg-input border-border w-24"
                  />
                  <p className="text-xs text-muted-foreground">Observation time before picking the best frame. Lower = Faster alers.</p>
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium">Detection Interval (Skip Frames)</Label>
                <div className="flex items-center gap-4 mt-2">
                  <Input
                    type="number"
                    min="1"
                    value={cvDetectionInterval}
                    onChange={(e) => setCvDetectionInterval(parseInt(e.target.value))}
                    className="bg-input border-border w-24"
                  />
                  <p className="text-xs text-muted-foreground">Process every {cvDetectionInterval} frames. High = Lower CPU usage.</p>
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium">Image Downscale Factor</Label>
                <div className="flex items-center gap-4 mt-2">
                  <Input
                    type="number"
                    step="0.05"
                    min="0.1"
                    max="1.0"
                    value={cvDownscaleFactor}
                    onChange={(e) => setCvDownscaleFactor(parseFloat(e.target.value))}
                    className="bg-input border-border w-24"
                  />
                  <p className="text-xs text-muted-foreground">Size reduction before AI analysis. Recommended: 0.50 (50%).</p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <Label className="text-sm font-medium">Recognition Tolerance</Label>
                <div className="flex items-center gap-4 mt-2">
                  <Input
                    type="number"
                    step="0.05"
                    min="0.3"
                    max="0.8"
                    value={cvRecognitionTolerance}
                    onChange={(e) => setCvRecognitionTolerance(parseFloat(e.target.value))}
                    className="bg-input border-border w-24"
                  />
                  <p className="text-xs text-muted-foreground">Distance threshold. Lower = Strict. Default: 0.50.</p>
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium">Alert Cooldown (Seconds)</Label>
                <div className="flex items-center gap-4 mt-2">
                  <Input
                    type="number"
                    min="0"
                    value={cvAlertCooldownSec}
                    onChange={(e) => setCvAlertCooldownSec(parseInt(e.target.value))}
                    className="bg-input border-border w-24"
                  />
                  <p className="text-xs text-muted-foreground">Wait time before same person triggers another alert.</p>
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium">Min Face Height (Pixels)</Label>
                <div className="flex items-center gap-4 mt-2">
                  <Input
                    type="number"
                    min="20"
                    value={cvFaceMinHeight}
                    onChange={(e) => setCvFaceMinHeight(parseInt(e.target.value))}
                    className="bg-input border-border w-24"
                  />
                  <p className="text-xs text-muted-foreground">Ignore small background faces.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between p-4 rounded-lg border border-primary/20 bg-primary/5">
            <div className="space-y-0.5">
              <Label className="text-sm font-bold flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                Deep Secondary Analysis (Multi-Face Detection)
              </Label>
              <p className="text-xs text-muted-foreground">Run a secondary high-precision scan to detect multiple people and crowds</p>
            </div>
            <Switch
              checked={cvDeepAnalysisEnabled}
              onCheckedChange={setCvDeepAnalysisEnabled}
            />
          </div>
        </CardContent>
      </Card>

      {/* Notification Preferences */}
      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle>Notification Preferences</CardTitle>
          <CardDescription>Configure alert delivery methods</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-4 rounded border border-border/50 bg-card/50">
            <div>
              <Label className="text-sm font-medium">Email Alerts</Label>
              <p className="text-xs text-muted-foreground">Send alerts via email</p>
            </div>
            <Switch
              checked={emailAlerts}
              onCheckedChange={setEmailAlerts}
            />
          </div>

          <div className="flex items-center justify-between p-4 rounded border border-border/50 bg-card/50">
            <div>
              <Label className="text-sm font-medium">Push Notifications</Label>
              <p className="text-xs text-muted-foreground">Send real-time push alerts</p>
            </div>
            <Switch
              checked={pushAlerts}
              onCheckedChange={setPushAlerts}
            />
          </div>
        </CardContent>
      </Card>

      {/* Data Maintenance */}
      <Card className="glow-card bg-card/50 backdrop-blur border-red-500/20">
        <CardHeader>
          <CardTitle className="text-red-400 flex items-center gap-2">
            <Trash2 className="w-5 h-5" />
            Data Maintenance
          </CardTitle>
          <CardDescription>Manage database logs and automatic cleanup</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-4 rounded border border-border/50 bg-card/50">
            <div className="space-y-1">
              <Label className="text-sm font-medium flex items-center gap-2">
                <RefreshCcw className="w-3 h-3" />
                Clear Logs on Startup
              </Label>
              <p className="text-xs text-muted-foreground">Automatically purge alerts and events when the server starts</p>
            </div>
            <Switch
              checked={clearOnStart}
              onCheckedChange={setClearOnStart}
            />
          </div>

          <div className="p-4 rounded border border-red-500/30 bg-red-500/5 flex items-center justify-between">
            <div className="space-y-1">
              <Label className="text-sm font-medium text-red-400 flex items-center gap-2">
                <AlertTriangle className="w-3 h-3" />
                Manual Data Purge
              </Label>
              <p className="text-xs text-muted-foreground">Immediately delete all historical logs and alerts</p>
            </div>
            <Button 
              variant="destructive" 
              size="sm"
              onClick={handleClearData}
              disabled={clearDataMutation.isPending}
              className="gap-2"
            >
              <Trash2 className="w-4 h-4" />
              Purge Database Now
            </Button>
          </div>

          <div className="p-4 rounded border-2 border-red-600/50 bg-red-600/10 flex items-center justify-between">
            <div className="space-y-1">
              <Label className="text-sm font-bold text-red-500 flex items-center gap-2 uppercase tracking-tighter">
                <Bomb className="w-4 h-4" />
                Factory Reset / Global Clean
              </Label>
              <p className="text-xs text-muted-foreground font-medium">Delete ALL data, persons registry, and AI matching history</p>
            </div>
            <Button 
              variant="destructive" 
              size="lg"
              onClick={handleFullReset}
              disabled={fullResetMutation.isPending}
              className="gap-2 bg-red-600 hover:bg-red-700 shadow-[0_0_20px_rgba(220,38,38,0.3)]"
            >
              <Bomb className="w-4 h-4" />
              Reset Everything
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* User Management */}
      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle>User Management</CardTitle>
          <CardDescription>Manage user roles and platform access</CardDescription>
        </CardHeader>
        <CardContent>
          <UserTable />
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => window.location.reload()}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Save Settings
        </Button>
      </div>
    </div>
  );
}

function UserTable() {
  const { data: users, isLoading, refetch } = trpc.users.list.useQuery();
  const updateRoleMutation = trpc.users.updateRole.useMutation();

  const handleToggleRole = async (userId: number, currentRole: "user" | "admin") => {
    try {
      const newRole = currentRole === "user" ? "admin" : "user";
      await updateRoleMutation.mutateAsync({ id: userId, role: newRole });
      toast.success(`User role updated to ${newRole}`);
      refetch();
    } catch (error) {
      toast.error("Failed to update user role");
      console.error(error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-border/50">
            <TableHead>User</TableHead>
            <TableHead>OpenID</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users?.map((user) => (
            <TableRow key={user.id} className="border-border/50">
              <TableCell className="font-medium">
                {user.name || "Unknown User"}
                <div className="text-xs text-muted-foreground">{user.email}</div>
              </TableCell>
              <TableCell className="text-xs font-mono text-muted-foreground">{user.openId}</TableCell>
              <TableCell>
                <Badge variant={user.role === "admin" ? "default" : "secondary"} className="gap-1">
                  {user.role === "admin" ? <Shield className="w-3 h-3" /> : <User className="w-3 h-3" />}
                  {user.role.toUpperCase()}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleToggleRole(user.id, user.role as any)}
                  disabled={updateRoleMutation.isPending}
                >
                  Make {user.role === "user" ? "Admin" : "User"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
