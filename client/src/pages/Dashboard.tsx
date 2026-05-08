import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";
import { AlertCircle, Camera, Shield, Users, TrendingUp, Video } from "lucide-react";
import { HlsPlayer } from "@/components/HlsPlayer";
import { Badge } from "@/components/ui/badge";

export default function Dashboard() {
  const mediamtxUrl = import.meta.env.VITE_MEDIAMTX_URL || "http://localhost:8888";
  const { data: stats, isLoading: isLoadingStats } = trpc.dashboard.stats.useQuery(undefined, { refetchInterval: 10000 });
  const { data: cameras, isLoading: isLoadingCameras } = trpc.cameras.list.useQuery(undefined, { refetchInterval: 30000 });
  const { data: recentEvents } = trpc.events.list.useQuery({ limit: 5, offset: 0 }, { refetchInterval: 10000 });

  const activeCameras = cameras?.filter(c => c.status === "online") || [];

  const getStreamName = (rtspUrl: string) => {
    try {
      const url = new URL(rtspUrl);
      return url.pathname.replace(/^\/+/, '');
    } catch {
      return rtspUrl.split('/').pop() || '';
    }
  };

  const getRelativeTime = (timestamp: Date | string) => {
    const diff = Date.now() - new Date(timestamp).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  // Mock data for charts
  const sparklineData = [
    { time: "00:00", value: 12 },
    { time: "04:00", value: 18 },
    { time: "08:00", value: 25 },
    { time: "12:00", value: 32 },
    { time: "16:00", value: 28 },
    { time: "20:00", value: 35 },
    { time: "23:59", value: 30 },
  ];

  const activityData = [
    { hour: "0", alerts: 2, recognitions: 5 },
    { hour: "4", alerts: 3, recognitions: 8 },
    { hour: "8", alerts: 5, recognitions: 12 },
    { hour: "12", alerts: 8, recognitions: 15 },
    { hour: "16", alerts: 6, recognitions: 10 },
    { hour: "20", alerts: 4, recognitions: 7 },
  ];

  if (isLoadingStats || isLoadingCameras) {
    return <div className="p-8 text-center flex flex-col items-center justify-center min-h-[400px]">
      <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
      <p className="text-muted-foreground animate-pulse">Initializing security protocols...</p>
    </div>;
  }

  return (
    <div className="space-y-8 p-8">
      {/* Header */}
      <div>
        <h1 className="text-4xl font-bold text-primary mb-2">Dashboard</h1>
        <p className="text-muted-foreground">Real-time security monitoring and analytics</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Total Cameras */}
        <Card className="glow-card bg-card/50 backdrop-blur">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Camera className="w-4 h-4 text-primary" />
              Total Cameras
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold data-value text-primary">{stats?.totalCameras || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats?.activeCameras || 0} online
            </p>
          </CardContent>
        </Card>

        {/* Active Zones */}
        <Card className="glow-card bg-card/50 backdrop-blur">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Shield className="w-4 h-4 text-secondary" />
              Active Zones
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold data-value text-secondary">{stats?.totalZones || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Security zones</p>
          </CardContent>
        </Card>

        {/* Recognized Faces Today */}
        <Card className="glow-card bg-card/50 backdrop-blur">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="w-4 h-4 text-green-400" />
              Recognized Today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold data-value text-green-400">{stats?.todayRecognitions || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Known individuals</p>
          </CardContent>
        </Card>

        {/* Unknown Detections */}
        <Card className="glow-card bg-card/50 backdrop-blur">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-yellow-400" />
              Unknown Detections
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold data-value text-yellow-400">{stats?.unknownDetections || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Unidentified faces</p>
          </CardContent>
        </Card>

        {/* Alert Rate */}
        <Card className="glow-card bg-card/50 backdrop-blur">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-red-500" />
              Active Alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold data-value text-red-500">{stats?.activeAlerts || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Pending action</p>
          </CardContent>
        </Card>

        {/* Blacklist Detections */}
        <Card className="glow-card bg-card/50 backdrop-blur border-red-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-600" />
              Blacklist Hits
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold data-value text-red-600">{(stats as any)?.blacklistDetections || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Today's threats</p>
          </CardContent>
        </Card>
      </div>

      {/* Security Status Banner */}
      <div className={`p-4 rounded-lg border flex items-center justify-between backdrop-blur-sm ${
        (stats?.activeAlerts || 0) > 0 
          ? "bg-red-500/10 border-red-500/30 text-red-400" 
          : "bg-green-500/10 border-green-500/30 text-green-400"
      }`}>
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full animate-pulse ${
            (stats?.activeAlerts || 0) > 0 ? "bg-red-500" : "bg-green-500"
          }`} />
          <span className="font-bold tracking-wide uppercase text-sm">
            System Status: {(stats?.activeAlerts || 0) > 0 ? "Threats Detected" : "Operational / Secure"}
          </span>
        </div>
        <div className="text-xs opacity-70 flex gap-4">
          <span>AI Engine: Running (Optimized)</span>
          <span>Storage: 12.4 GB / 100 GB</span>
        </div>
      </div>

      {/* Live Camera Feeds (WebRTC) */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-primary mb-4 flex items-center gap-2">
          <Video className="w-5 h-5" />
          Live Surveillance Feeds
        </h2>
        {activeCameras.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {activeCameras.map((cam: any) => {
              const streamName = getStreamName(cam.rtspUrl);
              const hlsUrl = `/hls-proxy/${streamName}/index.m3u8`;
              return (
                <Card key={cam.id} className="glow-card bg-card/50 backdrop-blur overflow-hidden group">
                  <div className="relative aspect-video bg-black overflow-hidden border-b border-border/50">
                    <HlsPlayer streamUrl={hlsUrl} />
                    
                    {/* Overlay metadata that hides on hover for better view */}
                    <div className="absolute top-2 left-2 right-2 flex justify-between pointer-events-none opacity-80 group-hover:opacity-10 transition-opacity z-10">
                      <div className="bg-black/60 backdrop-blur-sm px-2 py-1 rounded text-xs font-mono text-white flex gap-2 items-center">
                        <div className="status-pulse w-2 h-2 rounded-full bg-red-500" />
                        LIVE
                      </div>
                      <div className="bg-black/60 backdrop-blur-sm px-2 py-1 rounded text-xs font-mono text-white">
                        {cam.name}
                      </div>
                    </div>
                  </div>
                  <CardContent className="p-3 bg-black/40">
                    <div className="flex justify-between items-center text-xs text-muted-foreground">
                      <span>Stream: {streamName}</span>
                      <span>{cam.location || "Unknown Location"}</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card className="border-dashed border-2 bg-transparent text-center p-8">
            <Video className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
            <h3 className="text-lg font-medium text-muted-foreground">No Active Cameras Available</h3>
            <p className="text-sm text-muted-foreground mt-1">Configure and enable cameras in Camera Management to view live feeds.</p>
          </Card>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Activity Trend */}
        <Card className="glow-card bg-card/50 backdrop-blur">
          <CardHeader>
            <CardTitle>Activity Trend</CardTitle>
            <CardDescription>Alerts and recognitions over time</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={activityData}>
                <defs>
                  <linearGradient id="colorAlerts" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#FF00AA" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#FF00AA" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorRecognitions" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00F5FF" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#00F5FF" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2A2F45" />
                <XAxis dataKey="hour" stroke="#8A92B2" />
                <YAxis stroke="#8A92B2" />
                <Tooltip 
                  contentStyle={{ backgroundColor: "#1A1F35", border: "1px solid #2A2F45" }}
                  labelStyle={{ color: "#E0E8FF" }}
                />
                <Area type="monotone" dataKey="alerts" stroke="#FF00AA" fillOpacity={1} fill="url(#colorAlerts)" />
                <Area type="monotone" dataKey="recognitions" stroke="#00F5FF" fillOpacity={1} fill="url(#colorRecognitions)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* System Health */}
        <Card className="glow-card bg-card/50 backdrop-blur">
          <CardHeader>
            <CardTitle>System Health</CardTitle>
            <CardDescription>Camera status distribution</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={[
                { status: "Online", count: stats?.activeCameras || 0 },
                { status: "Offline", count: (stats?.totalCameras || 0) - (stats?.activeCameras || 0) },
              ]}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2A2F45" />
                <XAxis dataKey="status" stroke="#8A92B2" />
                <YAxis stroke="#8A92B2" />
                <Tooltip 
                  contentStyle={{ backgroundColor: "#1A1F35", border: "1px solid #2A2F45" }}
                  labelStyle={{ color: "#E0E8FF" }}
                />
                <Bar dataKey="count" fill="#00F5FF" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity - Real Data */}
      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest detection events • auto-refreshes every 10s</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {recentEvents?.events && recentEvents.events.length > 0 ? (
              recentEvents.events.map((event: any) => (
                <div key={event.id} className={`flex items-center justify-between p-3 rounded border transition-colors ${
                  event.person?.isBlacklisted || event.eventType === "alert" 
                    ? "bg-red-500/5 border-red-500/30 hover:border-red-500/50" 
                    : "bg-card/30 border-border/50 hover:border-primary/50"
                }`}>
                  <div className="flex items-center gap-3">
                    {event.person?.photoUrl || event.faceSnapshotUrl ? (
                      <img 
                        src={event.person?.photoUrl || event.faceSnapshotUrl} 
                        alt="Face" 
                        className={`w-10 h-10 rounded-full object-cover border ${
                          event.person?.isBlacklisted ? "border-red-500" : "border-border/50"
                        }`} 
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center border border-border/50">
                        <Users className="w-4 h-4 text-muted-foreground" />
                      </div>
                    )}
                    <div>
                      <p className="text-sm font-medium flex items-center gap-2">
                        {event.person?.name || (event.personId ? `Person #${event.personId}` : "Unknown")}
                        {event.person?.isBlacklisted && (
                          <Badge variant="destructive" className="text-[9px] h-3.5 px-1 animate-pulse">BLACKLISTED</Badge>
                        )}
                        {event.alertMetadata?.multiFaceDetected && (
                          <Badge variant="destructive" className="text-[9px] h-3.5 px-1 animate-pulse bg-red-600">⚠️ MULTIPLE FACES</Badge>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Camera #{event.cameraId} • Zone #{event.zoneId} • {event.confidence}% match
                        <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase font-bold ${
                          event.eventType === "recognized" || event.eventType === "recognition" ? "bg-green-400/10 text-green-400" :
                          event.eventType === "alert" || event.person?.isBlacklisted || event.alertMetadata?.multiFaceDetected ? "bg-red-500/20 text-red-400" :
                          "bg-yellow-400/10 text-yellow-400"
                        }`}>{event.eventType}</span>
                      </p>
                      
                      {/* Secondary Analysis Info */}
                      {event.alertMetadata?.detectedPersons && event.alertMetadata.detectedPersons.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          <span className="text-[9px] uppercase text-muted-foreground w-full">Also detected:</span>
                          {event.alertMetadata.detectedPersons.map((p: any, idx: number) => (
                            <Badge key={idx} variant="outline" className="text-[9px] py-0 px-1 border-primary/30 text-primary/80">
                              {p.name} ({p.confidence}%)
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <span className="text-[10px] text-muted-foreground data-value shrink-0 font-mono">
                    {getRelativeTime(event.timestamp)}
                  </span>
                </div>
              ))
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No recent events. The system is monitoring...</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
