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
import { Slider } from "@/components/ui/slider";
import {
  Shield, User, Loader2, Trash2, AlertTriangle, RefreshCcw,
  Bomb, Bug, Bell, Film, FolderOpen, CheckCircle2, Zap,
} from "lucide-react";

// ─── Field helper ─────────────────────────────────────────────────────────────
function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function NumInput({
  value, onChange, min, max, step, integer,
}: {
  value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; integer?: boolean;
}) {
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step ?? (integer ? 1 : 0.05)}
      value={value}
      onChange={(e) =>
        onChange(integer ? parseInt(e.target.value) : parseFloat(e.target.value))
      }
      className="bg-input border-border w-28"
    />
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function SystemSettings() {
  // Platform
  const [platformName, setPlatformName]   = useState("BlueEye");
  const [retentionDays, setRetentionDays] = useState(90);
  const [clearOnStart, setClearOnStart]   = useState(false);
  const [testMode, setTestMode]           = useState(false);
  const [emailAlerts, setEmailAlerts]     = useState(true);
  const [pushAlerts, setPushAlerts]       = useState(true);
  const [cvMotionClipMaxFrames, setCvMotionClipMaxFrames] = useState(20);
  const [cvFlipbookInterval, setCvFlipbookInterval]       = useState(500);


  const { data: settings, isLoading } = trpc.settings.get.useQuery();
  const updateMutation    = trpc.settings.update.useMutation();
  const clearDataMutation = trpc.settings.clearData.useMutation();
  const fullResetMutation = trpc.settings.fullReset.useMutation();

  useEffect(() => {
    if (!settings) return;
    const f = parseFloat;
    const i = parseInt;

    setPlatformName(settings.platformName || "BlueEye");
    setRetentionDays(settings.retentionDays || 90);
    setClearOnStart(settings.clearOnStart ?? false);
    setTestMode(settings.testMode ?? false);
    if (settings.notificationPreferences) {
      setEmailAlerts(settings.notificationPreferences.emailAlerts ?? true);
      setPushAlerts(settings.notificationPreferences.pushAlerts ?? true);
    }
    setCvMotionClipMaxFrames((settings as any).cvMotionClipMaxFrames ?? 20);
    setCvFlipbookInterval((settings as any).cvFlipbookInterval ?? 500);

  }, [settings]);

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        platformName,
        retentionDays,
        clearOnStart,
        testMode,
        notificationPreferences: { emailAlerts, pushAlerts },
        cvMotionClipMaxFrames,
        cvFlipbookInterval,
      } as any);
      toast.success("Settings saved successfully");
    } catch (error) {
      toast.error("Failed to save settings");
      console.error(error);
    }
  };

  const handleClearData = async () => {
    if (!confirm("WARNING: This will permanently delete ALL alerts, events and motion history. This cannot be undone. Continue?")) return;
    try {
      await clearDataMutation.mutateAsync();
      toast.success("Database logs cleared");
    } catch (error) {
      toast.error("Failed to clear database");
    }
  };

  const handleFullReset = async () => {
    if (!confirm("CRITICAL: This deletes ALL data (Alerts, Events, Motions, Persons) and ALL saved photos. The AI will no longer recognise anyone. Proceed?")) return;
    try {
      await fullResetMutation.mutateAsync();
      toast.success("System has been fully reset");
      window.location.reload();
    } catch (error) {
      toast.error("Failed to reset system");
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-3xl font-bold text-primary">System Settings</h1>
        <p className="text-muted-foreground">Configure platform-wide settings and preferences</p>
      </div>

      {/* ── Platform ── */}
      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle>Platform</CardTitle>
          <CardDescription>General platform settings</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label="Platform Name">
            <Input
              value={platformName}
              onChange={(e) => setPlatformName(e.target.value)}
              className="bg-input border-border"
              placeholder="BlueEye"
            />
          </Field>

          <Field label="Event Log Retention (days)" hint="Older records will be auto-purged.">
            <NumInput value={retentionDays} onChange={setRetentionDays} min={1} integer />
          </Field>

          <div className="flex items-center justify-between p-4 rounded-lg border border-yellow-500/20 bg-yellow-500/5">
            <div>
              <Label className="text-sm font-bold flex items-center gap-2">
                <Bug className="w-4 h-4 text-yellow-500" />
                Developer Test Mode
              </Label>
              <p className="text-xs text-muted-foreground">Enable testing utilities and automated data entry</p>
            </div>
            <Switch checked={testMode} onCheckedChange={setTestMode} />
          </div>

          <VideoStreamPicker />
        </CardContent>
      </Card>

      {/* ── Detection Sensitivity ── */}
      <DetectionSensitivityCard />

      {/* ── Notifications ── */}
      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="w-5 h-5" />
            Notifications
          </CardTitle>
          <CardDescription>Configure alert delivery methods</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between p-4 rounded border border-border/50 bg-card/50">
            <div>
              <Label className="text-sm font-medium">Email Alerts</Label>
              <p className="text-xs text-muted-foreground">Send alerts via email</p>
            </div>
            <Switch checked={emailAlerts} onCheckedChange={setEmailAlerts} />
          </div>
          <div className="flex items-center justify-between p-4 rounded border border-border/50 bg-card/50">
            <div>
              <Label className="text-sm font-medium">Push Notifications</Label>
              <p className="text-xs text-muted-foreground">Send real-time push alerts</p>
            </div>
            <Switch checked={pushAlerts} onCheckedChange={setPushAlerts} />
          </div>
        </CardContent>
      </Card>

      {/* ── Motion Recording ── */}
      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Film className="w-5 h-5" />
            Motion Recording
          </CardTitle>
          <CardDescription>Configure motion clip capture and playback speed</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Field
            label="Max frames per motion clip"
            hint={`${cvMotionClipMaxFrames} frames max — with every-2nd-frame sampling at 150ms intervals = up to ${(cvMotionClipMaxFrames * 2 * 0.15).toFixed(1)}s of motion`}
          >
            <div className="flex items-center gap-4">
              <Slider
                min={5} max={50} step={1}
                value={[cvMotionClipMaxFrames]}
                onValueChange={([v]) => setCvMotionClipMaxFrames(v)}
                className="flex-1"
              />
              <span className="text-sm font-mono w-16 text-right">{cvMotionClipMaxFrames} frames</span>
            </div>
          </Field>

          <Field
            label="Flipbook playback speed"
            hint={`${cvFlipbookInterval}ms between frames — ${(1000 / cvFlipbookInterval).toFixed(1)} fps`}
          >
            <div className="flex items-center gap-4">
              <Slider
                min={200} max={2000} step={100}
                value={[cvFlipbookInterval]}
                onValueChange={([v]) => setCvFlipbookInterval(v)}
                className="flex-1"
              />
              <span className="text-sm font-mono w-24 text-right">{cvFlipbookInterval}ms</span>
            </div>
          </Field>
        </CardContent>
      </Card>

      {/* ── Data Maintenance ── */}
      <Card className="glow-card bg-card/50 backdrop-blur border-red-500/20">
        <CardHeader>
          <CardTitle className="text-red-400 flex items-center gap-2">
            <Trash2 className="w-5 h-5" />
            Data Maintenance
          </CardTitle>
          <CardDescription>Database cleanup and factory reset</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-4 rounded border border-border/50 bg-card/50">
            <div>
              <Label className="text-sm font-medium flex items-center gap-2">
                <RefreshCcw className="w-3 h-3" />
                Clear Logs on Startup
              </Label>
              <p className="text-xs text-muted-foreground">Auto-purge alerts, events and motions when the server starts</p>
            </div>
            <Switch checked={clearOnStart} onCheckedChange={setClearOnStart} />
          </div>

          <div className="p-4 rounded border border-red-500/30 bg-red-500/5 flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium text-red-400 flex items-center gap-2">
                <AlertTriangle className="w-3 h-3" />
                Manual Data Purge
              </Label>
              <p className="text-xs text-muted-foreground">Delete all alerts, events and motion records immediately</p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleClearData}
              disabled={clearDataMutation.isPending}
              className="gap-2"
            >
              {clearDataMutation.isPending
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Trash2 className="w-4 h-4" />}
              Purge Now
            </Button>
          </div>

          <div className="p-4 rounded border-2 border-red-600/50 bg-red-600/10 flex items-center justify-between">
            <div>
              <Label className="text-sm font-bold text-red-500 flex items-center gap-2 uppercase tracking-tighter">
                <Bomb className="w-4 h-4" />
                Factory Reset
              </Label>
              <p className="text-xs text-muted-foreground font-medium">Delete ALL data, person registry, photos and AI matching history</p>
            </div>
            <Button
              variant="destructive"
              size="lg"
              onClick={handleFullReset}
              disabled={fullResetMutation.isPending}
              className="gap-2 bg-red-600 hover:bg-red-700 shadow-[0_0_20px_rgba(220,38,38,0.3)]"
            >
              {fullResetMutation.isPending
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Bomb className="w-4 h-4" />}
              Reset Everything
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── User Management ── */}
      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle>User Management</CardTitle>
          <CardDescription>Manage user roles and platform access</CardDescription>
        </CardHeader>
        <CardContent>
          <UserTable />
        </CardContent>
      </Card>

      {/* ── Save ── */}
      <div className="flex justify-end gap-2 pb-4">
        <Button variant="outline" onClick={() => window.location.reload()}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={updateMutation.isPending}
          className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2"
        >
          {updateMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Save Settings
        </Button>
      </div>
    </div>
  );
}

// ─── Detection Sensitivity ────────────────────────────────────────────────────

function SliderField({
  label, note, warn,
  value, onChange,
  min, max, step,
  format,
}: {
  label: string; note?: string; warn?: string;
  value: number; onChange: (v: number) => void;
  min: number; max: number; step: number;
  format?: (v: number) => string;
}) {
  const display = format ? format(value) : String(value);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{label}</Label>
        <span className="text-sm font-mono font-bold text-primary tabular-nums">{display}</span>
      </div>
      <Slider
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        min={min} max={max} step={step}
        className="w-full"
      />
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{format ? format(min) : min}</span>
        {note && <span className="italic text-center px-2">{note}</span>}
        <span>{format ? format(max) : max}</span>
      </div>
      {warn && (
        <p className="text-[10px] text-amber-400 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3 shrink-0" />{warn}
        </p>
      )}
    </div>
  );
}

function SensGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70">
        {title}
      </p>
      {children}
    </div>
  );
}

function DetectionSensitivityCard() {
  const { data: cfg, isLoading, refetch } = trpc.cvConfig.get.useQuery();
  const updateMutation = trpc.cvConfig.update.useMutation();
  const resetMutation  = trpc.cvConfig.reset.useMutation();

  const [alertCooldown,      setAlertCooldown]      = useState(5);
  const [bioMemory,          setBioMemory]           = useState(20);
  const [bioThreshold,       setBioThreshold]        = useState(0.40);
  const [trackRadius,        setTrackRadius]         = useState(80);
  const [bufferSec,          setBufferSec]           = useState(1.0);
  const [maxPresence,        setMaxPresence]         = useState(8.0);
  const [analysisIntervalMs, setAnalysisIntervalMs]  = useState(150);
  const [minFacePx,          setMinFacePx]           = useState(50);
  const [faceMinHeight,      setFaceMinHeight]       = useState(20);
  const [landmarkMin,        setLandmarkMin]         = useState(10);
  const [downscaleFactor,    setDownscaleFactor]     = useState(0.50);
  const [upsampleTimes,      setUpsampleTimes]       = useState(2);
  const [recognitionTol,     setRecognitionTol]      = useState(0.50);

  useEffect(() => {
    if (!cfg) return;
    const f = parseFloat;
    setAlertCooldown(cfg.alertCooldownSeconds);
    setBioMemory(cfg.biometricMemorySeconds);
    setBioThreshold(f(cfg.biometricDistanceThreshold as any));
    setTrackRadius(cfg.trackingRadiusPx);
    setBufferSec(f(cfg.detectionBufferSeconds as any));
    setMaxPresence(f(cfg.maxPresenceSeconds as any));
    setAnalysisIntervalMs(cfg.frameAnalysisIntervalMs);
    setMinFacePx(cfg.minFacePixels);
    setFaceMinHeight((cfg as any).faceMinHeightPx ?? 20);
    setLandmarkMin((cfg as any).landmarkMinPoints ?? 10);
    setDownscaleFactor(f((cfg as any).imageDownscaleFactor) || 0.50);
    setUpsampleTimes((cfg as any).upsampleTimes ?? 2);
    setRecognitionTol(f((cfg as any).recognitionTolerance) || 0.50);
  }, [cfg]);

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        alertCooldownSeconds:       alertCooldown,
        biometricMemorySeconds:     bioMemory,
        biometricDistanceThreshold: bioThreshold,
        trackingRadiusPx:           trackRadius,
        detectionBufferSeconds:     bufferSec,
        maxPresenceSeconds:         maxPresence,
        frameAnalysisIntervalMs:    analysisIntervalMs,
        minFacePixels:              minFacePx,
        faceMinHeightPx:            faceMinHeight,
        landmarkMinPoints:          landmarkMin,
        imageDownscaleFactor:       downscaleFactor,
        upsampleTimes:              upsampleTimes,
        recognitionTolerance:       recognitionTol,
      });
      toast.success("Sensitivity settings saved — apply within 30s");
      refetch();
    } catch (e) {
      toast.error("Failed to save sensitivity settings");
    }
  };

  const handleReset = async () => {
    try {
      await resetMutation.mutateAsync();
      toast.success("Sensitivity reset to defaults");
      refetch();
    } catch (e) {
      toast.error("Reset failed");
    }
  };

  if (isLoading) return null;

  const s = (v: number, unit: string) => `${v}${unit}`;

  return (
    <Card className="glow-card bg-card/50 backdrop-blur border-primary/20">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Detection Sensitivity
            </CardTitle>
            <CardDescription>Changes apply within 30 seconds — no restart required</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={resetMutation.isPending}
            className="shrink-0 text-muted-foreground"
          >
            {resetMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />}
            Reset Defaults
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-8">
        <SensGroup title="Consecutive Detections">
          <SliderField
            label="Alert Cooldown"
            value={alertCooldown} onChange={setAlertCooldown}
            min={1} max={120} step={1}
            format={v => s(v, "s")}
            note="min time between alerts per camera"
            warn={alertCooldown < 5 ? "Very low — high CPU & DB write load" : undefined}
          />
          <SliderField
            label="Detection Buffer Window"
            value={bufferSec} onChange={setBufferSec}
            min={0.5} max={10} step={0.5}
            format={v => s(v, "s")}
            note="lower = faster alerts for quick passers"
          />
          <SliderField
            label="Max Presence Window"
            value={maxPresence} onChange={setMaxPresence}
            min={2} max={60} step={1}
            format={v => s(v, "s")}
            note="force-finalize alert after this long even if still visible"
          />
        </SensGroup>

        <SensGroup title="Person Tracking">
          <SliderField
            label="Tracking Radius"
            value={trackRadius} onChange={setTrackRadius}
            min={20} max={500} step={10}
            format={v => s(v, "px")}
            note="lower = two close persons = two separate alerts"
            warn={trackRadius > 200 ? "High radius — nearby persons may merge into one tracker" : undefined}
          />
          <SliderField
            label="Biometric Memory Window"
            value={bioMemory} onChange={setBioMemory}
            min={0} max={300} step={5}
            format={v => v === 0 ? "off" : s(v, "s")}
            note="0 = capture every single pass"
          />
          <SliderField
            label="Biometric Distance Threshold"
            value={bioThreshold} onChange={(v) => setBioThreshold(Math.round(v * 100) / 100)}
            min={0.10} max={0.90} step={0.01}
            format={v => v.toFixed(2)}
            note="lower = stricter duplicate suppression"
            warn={bioThreshold > 0.65 ? "High threshold — same person may trigger multiple alerts" : undefined}
          />
        </SensGroup>

        <SensGroup title="Analysis Performance">
          <SliderField
            label="Frame Analysis Interval"
            value={analysisIntervalMs} onChange={setAnalysisIntervalMs}
            min={50} max={2000} step={50}
            format={v => s(v, "ms")}
            note="target interval between face_recognition calls"
            warn={analysisIntervalMs < 100 ? "Very low — high CPU load" : undefined}
          />
          <SliderField
            label="Minimum Face Crop Size"
            value={minFacePx} onChange={setMinFacePx}
            min={30} max={300} step={10}
            format={v => s(v, "px")}
            note="crops smaller than this are ignored (person too far)"
            warn={minFacePx > 55 ? "Values above 55px prevent detection of persons at distance. Recommended: 50px" : undefined}
          />
        </SensGroup>

        <SensGroup title="Face Detection Filters">
          <SliderField
            label="Min Face Height"
            value={faceMinHeight} onChange={setFaceMinHeight}
            min={5} max={100} step={5}
            format={v => s(v, "px")}
            note="minimum detected face height in full-frame pixels"
            warn={faceMinHeight > 40 ? "Above 40px — background persons at distance will not be captured" : undefined}
          />
          <SliderField
            label="Min Landmark Points"
            value={landmarkMin} onChange={setLandmarkMin}
            min={2} max={68} step={2}
            format={v => String(v)}
            note="real faces return 20-68 points; non-faces return 0"
            warn={landmarkMin > 20 ? "Above 20 — small or angled faces will be rejected" : undefined}
          />
          <SliderField
            label="Image Downscale Factor"
            value={downscaleFactor} onChange={v => setDownscaleFactor(Math.round(v * 100) / 100)}
            min={0.1} max={1.0} step={0.05}
            format={v => `${Math.round(v * 100)}%`}
            note="frame resolution before face_recognition — lower = faster CPU"
          />
          <SliderField
            label="Upsample Times"
            value={upsampleTimes} onChange={setUpsampleTimes}
            min={0} max={3} step={1}
            format={v => String(v)}
            note="higher = detects smaller faces at cost of CPU"
            warn={upsampleTimes > 2 ? "Above 2 — very high CPU load per frame" : undefined}
          />
          <SliderField
            label="Recognition Tolerance"
            value={recognitionTol} onChange={v => setRecognitionTol(Math.round(v * 100) / 100)}
            min={0.10} max={0.90} step={0.01}
            format={v => v.toFixed(2)}
            note="face distance threshold for identification — lower = stricter"
            warn={recognitionTol > 0.65 ? "High tolerance — same person may trigger multiple alerts" : undefined}
          />
        </SensGroup>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => refetch()}>Discard</Button>
          <Button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2"
          >
            {updateMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Apply Sensitivity
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── VideoStreamPicker ────────────────────────────────────────────────────────
function VideoStreamPicker() {
  const { data: videos = [], isLoading: loadingList } = trpc.settings.listVideos.useQuery();
  const { data: current, refetch: refetchCurrent } = trpc.settings.currentStreamVideo.useQuery();
  const applyMutation = trpc.settings.applyStreamVideo.useMutation();

  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const pending = selected ?? current ?? null;

  const handleApply = async () => {
    if (!selected) return;
    try {
      const res = await applyMutation.mutateAsync({ filename: selected });
      toast.success(`Stream switched — ${res.streamUrl}`);
      setSelected(null);
      setOpen(false);
      refetchCurrent();
    } catch (err: any) {
      toast.error(`Failed to apply: ${err.message}`);
    }
  };

  return (
    <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-bold flex items-center gap-2">
            <Film className="w-4 h-4 text-yellow-500" />
            Test Stream Video
          </Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Current:{" "}
            <span className="font-mono text-yellow-400">{current ?? "—"}</span>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10"
          onClick={() => setOpen((v) => !v)}
        >
          <FolderOpen className="w-4 h-4" />
          Browse
        </Button>
      </div>

      {open && (
        <div className="space-y-2">
          {loadingList ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading videos…
            </div>
          ) : videos.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No video files found in <span className="font-mono">/videos</span>. Make sure the volume is mounted and the app container was restarted.
            </p>
          ) : (
            <div className="grid gap-1 max-h-56 overflow-y-auto pr-1">
              {videos.map((f) => {
                const isCurrent = f === current;
                const isSelected = f === selected;
                return (
                  <button
                    key={f}
                    onClick={() => setSelected(f)}
                    className={`flex items-center gap-2 rounded px-3 py-2 text-sm text-left transition-colors ${
                      isSelected
                        ? "bg-yellow-500/20 border border-yellow-500/50 text-yellow-300"
                        : isCurrent
                        ? "bg-primary/10 border border-primary/30 text-primary"
                        : "hover:bg-card/80 border border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Film className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-mono flex-1">{f}</span>
                    {isCurrent && !isSelected && (
                      <span className="text-[10px] text-primary font-semibold uppercase">active</span>
                    )}
                    {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-yellow-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}

          {selected && selected !== current && (
            <Button
              size="sm"
              onClick={handleApply}
              disabled={applyMutation.isPending}
              className="gap-2 bg-yellow-500 hover:bg-yellow-600 text-black font-semibold"
            >
              {applyMutation.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <CheckCircle2 className="w-3.5 h-3.5" />}
              Apply — switch to {selected}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── UserTable ────────────────────────────────────────────────────────────────
function UserTable() {
  const { data: users, isLoading, refetch } = trpc.users.list.useQuery();
  const updateRoleMutation = trpc.users.updateRole.useMutation();

  const handleToggleRole = async (userId: number, currentRole: "user" | "admin") => {
    const newRole = currentRole === "user" ? "admin" : "user";
    try {
      await updateRoleMutation.mutateAsync({ id: userId, role: newRole });
      toast.success(`Role updated to ${newRole}`);
      refetch();
    } catch {
      toast.error("Failed to update role");
    }
  };

  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
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
