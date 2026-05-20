import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartTooltip, ResponsiveContainer,
} from "recharts";
import { ArrowLeft, CheckCircle2, XCircle, Clock, MapPin, Camera } from "lucide-react";

const ACCENT = "#00F5FF";
const BORDER  = "#1E2D40";
const BG_CARD = "#0D1421";

const ZONE_COLORS = [
  "#00F5FF", "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
  "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F", "#85C1E9",
];

function fmtTime(d: string | Date) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDwell(secs: number | null) {
  if (secs === null) return "ongoing";
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
function fmtDate(d: string | Date) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function PersonTimeline() {
  const params   = useParams<{ id: string }>();
  const personId = Number(params.id);
  const [, setLocation] = useLocation();

  const today   = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(weekAgo);
  const [endDate,   setEndDate]   = useState(today);

  const { data: person }   = trpc.persons.getById.useQuery({ id: personId });
  const { data: timeline, isLoading, refetch } = trpc.personAnalytics.timeline.useQuery(
    { personId, startDate, endDate },
    { enabled: !!personId },
  );

  // Unique zones for color mapping
  const zoneColorMap = new Map<number, string>();
  timeline?.forEach(ev => {
    if (!zoneColorMap.has(ev.zoneId)) {
      zoneColorMap.set(ev.zoneId, ZONE_COLORS[zoneColorMap.size % ZONE_COLORS.length]);
    }
  });

  // Dwell bar chart data
  const dwellByZone: Record<string, number> = {};
  timeline?.forEach(ev => {
    const name = ev.zoneName ?? `Zone ${ev.zoneId}`;
    dwellByZone[name] = (dwellByZone[name] ?? 0) + (ev.dwellSeconds ?? 0);
  });
  const barData = Object.entries(dwellByZone).map(([name, secs]) => ({
    name, minutes: Math.round(secs / 60),
  }));

  return (
    <div className="h-full overflow-y-auto p-6" style={{ background: "#0A0E1A" }}>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost" size="icon"
            onClick={() => setLocation(`/persons/${personId}`)}
            style={{ color: ACCENT }}
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: ACCENT }}>
              {person?.name ?? "Person"} — Zone Timeline
            </h1>
            <p className="text-sm text-muted-foreground">Chronological zone journey</p>
          </div>
        </div>

        {/* Date filter */}
        <Card style={{ background: BG_CARD, borderColor: BORDER }}>
          <CardContent className="p-4 flex flex-wrap gap-4 items-end">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground uppercase tracking-widest">Start</Label>
              <Input
                type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                style={{ background: "#0A0E1A", borderColor: BORDER, colorScheme: "dark", width: 160 }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground uppercase tracking-widest">End</Label>
              <Input
                type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                style={{ background: "#0A0E1A", borderColor: BORDER, colorScheme: "dark", width: 160 }}
              />
            </div>
            <Button size="sm" onClick={() => refetch()} style={{ borderColor: ACCENT, color: ACCENT }} variant="outline">
              Refresh
            </Button>
          </CardContent>
        </Card>

        {isLoading && <Skeleton className="h-40 w-full" />}

        {timeline && timeline.length > 0 && (
          <>
            {/* Horizontal scrollable timeline */}
            <Card style={{ background: BG_CARD, borderColor: BORDER }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                  Zone Journey
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto pb-3">
                  <div className="flex items-center gap-2 min-w-max">
                    {timeline.map((ev, i) => {
                      const color = zoneColorMap.get(ev.zoneId) ?? ACCENT;
                      return (
                        <div key={ev.id} className="flex items-center gap-2">
                          {i > 0 && (
                            <div className="w-8 h-0.5 flex-shrink-0" style={{ background: BORDER }} />
                          )}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className="flex flex-col items-center gap-1 p-3 rounded-lg border cursor-default"
                                style={{ background: "#0A0E1A", borderColor: color + "55", minWidth: 110 }}
                              >
                                <div className="flex items-center gap-1">
                                  {ev.accessGranted
                                    ? <CheckCircle2 className="w-3 h-3" style={{ color: "#22c55e" }} />
                                    : <XCircle className="w-3 h-3 text-red-500" />
                                  }
                                  <Badge className="text-xs px-1.5 py-0" style={{ background: color + "22", color, borderColor: color + "44" }}>
                                    {ev.zoneName ?? `Zone ${ev.zoneId}`}
                                  </Badge>
                                </div>
                                <p className="font-mono text-xs text-muted-foreground">{fmtTime(ev.entryTime)}</p>
                                <p className="font-mono text-xs font-bold" style={{ color }}>
                                  {fmtDwell(ev.dwellSeconds)}
                                </p>
                                <p className="text-[10px] text-muted-foreground truncate max-w-[100px]">
                                  {ev.cameraName}
                                </p>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent style={{ background: BG_CARD, borderColor: BORDER }}>
                              <div className="space-y-1 text-xs font-mono">
                                <p><span className="text-muted-foreground">Entry:</span> {new Date(ev.entryTime).toLocaleString()}</p>
                                {ev.exitTime && <p><span className="text-muted-foreground">Exit:</span> {new Date(ev.exitTime).toLocaleString()}</p>}
                                <p><span className="text-muted-foreground">Camera:</span> {ev.cameraName}</p>
                                <p><span className="text-muted-foreground">Access:</span> {ev.accessGranted ? "✅ Allowed" : "🚫 Denied"}</p>
                                {ev.globalTrackId && <p className="text-[10px] text-muted-foreground">Track: {ev.globalTrackId.slice(0, 8)}…</p>}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Time-in-zone bar chart */}
            <Card style={{ background: BG_CARD, borderColor: BORDER }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                  Time in Zone (minutes)
                </CardTitle>
              </CardHeader>
              <CardContent className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1E2D40" />
                    <XAxis dataKey="name" tick={{ fill: "#8899AA", fontSize: 11 }} />
                    <YAxis tick={{ fill: "#8899AA", fontSize: 11 }} />
                    <RechartTooltip contentStyle={{ background: BG_CARD, border: `1px solid ${BORDER}`, borderRadius: 8 }} />
                    <Bar dataKey="minutes" fill={ACCENT} radius={[3, 3, 0, 0]} opacity={0.85} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Event table */}
            <Card style={{ background: BG_CARD, borderColor: BORDER }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                  All Zone Events ({timeline.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                        {["Date", "Zone", "Camera", "Entry", "Exit", "Dwell", "Access"].map(h => (
                          <th key={h} className="px-4 py-2 text-left text-xs text-muted-foreground uppercase tracking-widest">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {timeline.map(ev => {
                        const color = zoneColorMap.get(ev.zoneId) ?? ACCENT;
                        return (
                          <tr key={ev.id} style={{ borderBottom: `1px solid ${BORDER}20` }} className="hover:bg-white/5">
                            <td className="px-4 py-2 text-xs text-muted-foreground">{fmtDate(ev.entryTime)}</td>
                            <td className="px-4 py-2">
                              <Badge style={{ background: color + "22", color, borderColor: color + "44" }} className="text-xs">
                                {ev.zoneName ?? `Zone ${ev.zoneId}`}
                              </Badge>
                            </td>
                            <td className="px-4 py-2 text-xs text-muted-foreground">{ev.cameraName}</td>
                            <td className="px-4 py-2 font-mono text-xs">{fmtTime(ev.entryTime)}</td>
                            <td className="px-4 py-2 font-mono text-xs">{ev.exitTime ? fmtTime(ev.exitTime) : "—"}</td>
                            <td className="px-4 py-2 font-mono text-xs" style={{ color: ACCENT }}>{fmtDwell(ev.dwellSeconds)}</td>
                            <td className="px-4 py-2">
                              {ev.accessGranted
                                ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                                : <XCircle className="w-4 h-4 text-red-500" />}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {!isLoading && timeline?.length === 0 && (
          <div className="text-center text-muted-foreground py-20 text-sm">
            No zone visits found for this period.
          </div>
        )}
      </div>
    </div>
  );
}
