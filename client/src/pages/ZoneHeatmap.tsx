import { useParams, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { ArrowLeft, Users } from "lucide-react";

const ACCENT = "#00F5FF";
const BORDER  = "#1E2D40";
const BG_CARD = "#0D1421";

function lerp(t: number) {
  const r = Math.round(0 + t * 0);
  const g = Math.round(245 * t);
  const b = Math.round(255 * t);
  return `rgba(${r},${g},${b},${0.15 + t * 0.75})`;
}

export default function ZoneHeatmap() {
  const params = useParams<{ id: string }>();
  const zoneId = Number(params.id);
  const [, setLocation] = useLocation();
  const [period, setPeriod] = useState<"daily" | "weekly" | "monthly">("weekly");

  const { data: zone }  = trpc.zones.getById.useQuery({ id: zoneId });
  const { data, isLoading } = trpc.zoneAnalytics.heatmap.useQuery(
    { zoneId, period },
    { enabled: !!zoneId, refetchInterval: 60_000 },
  );

  const maxVisits = Math.max(1, ...(data?.hourly ?? []).map(h => h.visitCount));

  return (
    <div className="h-full overflow-y-auto p-6" style={{ background: "#0A0E1A" }}>
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost" size="icon"
            onClick={() => setLocation("/zones")}
            style={{ color: ACCENT }}
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: ACCENT }}>
              {zone?.name ?? "Zone"} — Heatmap
            </h1>
            <p className="text-sm text-muted-foreground">Hourly visit density analysis</p>
          </div>
          <div className="ml-auto">
            <Tabs value={period} onValueChange={v => setPeriod(v as any)}>
              <TabsList style={{ background: "#0A0E1A" }}>
                <TabsTrigger value="daily">24h</TabsTrigger>
                <TabsTrigger value="weekly">7d</TabsTrigger>
                <TabsTrigger value="monthly">30d</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {isLoading && <Skeleton className="h-72 w-full" />}

        {data && (
          <>
            {/* 24-hour bar chart */}
            <Card style={{ background: BG_CARD, borderColor: BORDER }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                  Visit Count by Hour
                </CardTitle>
              </CardHeader>
              <CardContent className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.hourly} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1E2D40" />
                    <XAxis
                      dataKey="hour"
                      tickFormatter={h => `${h}:00`}
                      tick={{ fill: "#8899AA", fontSize: 10 }}
                    />
                    <YAxis tick={{ fill: "#8899AA", fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ background: BG_CARD, border: `1px solid ${BORDER}`, borderRadius: 8 }}
                      labelFormatter={h => `${h}:00 – ${Number(h) + 1}:00`}
                      formatter={(v: any, name: string) => [v, name === "visitCount" ? "Visits" : "Avg Dwell (s)"]}
                    />
                    <Bar dataKey="visitCount" radius={[3, 3, 0, 0]}>
                      {data.hourly.map((entry, i) => (
                        <Cell key={i} fill={lerp(entry.visitCount / maxVisits)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Week-view heatmap grid: hour × day (for weekly period) */}
            <Card style={{ background: BG_CARD, borderColor: BORDER }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                  Hourly Density Grid
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <div className="grid" style={{ gridTemplateColumns: "3rem repeat(24, 1fr)", gap: 3, minWidth: 600 }}>
                    <div />
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={h} className="text-center text-[10px] text-muted-foreground">{h}</div>
                    ))}
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => (
                      <>
                        <div key={day + "_label"} className="text-[10px] text-muted-foreground flex items-center">{day}</div>
                        {data.hourly.map((h, hi) => (
                          <div
                            key={`${day}_${hi}`}
                            className="rounded-sm aspect-square"
                            style={{
                              background: lerp(h.visitCount / maxVisits),
                              minHeight: 14,
                            }}
                            title={`${day} ${h.hour}:00 — ${h.visitCount} visits`}
                          />
                        ))}
                      </>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Note: grid uses hourly aggregates — day-of-week breakdown requires extended data collection.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Avg dwell bar chart */}
            <Card style={{ background: BG_CARD, borderColor: BORDER }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                  Avg Dwell by Hour (seconds)
                </CardTitle>
              </CardHeader>
              <CardContent className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.hourly} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1E2D40" />
                    <XAxis dataKey="hour" tickFormatter={h => `${h}h`} tick={{ fill: "#8899AA", fontSize: 10 }} />
                    <YAxis tick={{ fill: "#8899AA", fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: BG_CARD, border: `1px solid ${BORDER}`, borderRadius: 8 }} />
                    <Bar dataKey="avgDwell" fill="#4ECDC4" radius={[3, 3, 0, 0]} opacity={0.85} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Top visitors */}
            {data.topVisitors.length > 0 && (
              <Card style={{ background: BG_CARD, borderColor: BORDER }}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                    <Users className="w-4 h-4" /> Top Visitors
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                          <th className="px-4 py-2 text-left text-xs text-muted-foreground uppercase tracking-widest">#</th>
                          <th className="px-4 py-2 text-left text-xs text-muted-foreground uppercase tracking-widest">Person</th>
                          <th className="px-4 py-2 text-left text-xs text-muted-foreground uppercase tracking-widest">Visits</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.topVisitors.map((v, i) => (
                          <tr key={v.personId} style={{ borderBottom: `1px solid ${BORDER}20` }} className="hover:bg-white/5">
                            <td className="px-4 py-2 text-muted-foreground font-mono text-xs">#{i + 1}</td>
                            <td className="px-4 py-2 font-medium">{v.name ?? `Unknown #${v.personId}`}</td>
                            <td className="px-4 py-2 font-mono" style={{ color: ACCENT }}>{v.visits}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
