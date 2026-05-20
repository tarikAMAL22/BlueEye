import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { BarChart2, Clock, Users, TrendingUp, Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const ACCENT = "#00F5FF";
const BG_CARD = "#0D1421";
const BORDER  = "#1E2D40";

function StatCard({ icon: Icon, label, value, sub }: { icon: any; label: string; value: string | number; sub?: string }) {
  return (
    <Card className="border" style={{ background: BG_CARD, borderColor: BORDER }}>
      <CardContent className="p-4 flex items-start gap-3">
        <div className="p-2 rounded" style={{ background: "#00F5FF15" }}>
          <Icon className="w-4 h-4" style={{ color: ACCENT }} />
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-widest">{label}</p>
          <p className="font-mono text-xl font-bold" style={{ color: ACCENT }}>{value}</p>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function fmtDwell(secs: number) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function exportCsv(data: any, period: string) {
  if (!data) return;
  const rows = [
    ["Period", "Total Visits", "Total Dwell (s)", "Avg Dwell (s)", "Unique Persons"],
    [
      data.periods?.join("|") ?? "",
      data.totalVisits,
      data.totalDwellSeconds,
      data.avgDwellSeconds,
      data.uniquePersons,
    ],
    [],
    ["Zone", "Visits", "Total Dwell (s)"],
    ...(data.zoneBreakdown ?? []).map((z: any) => [z.zoneName ?? z.zoneId, z.visitCount, z.totalDwellSec]),
  ];
  const csv  = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `blueeye_report_${period}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Reports() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const [period,     setPeriod]     = useState<"daily" | "weekly" | "monthly">("daily");
  const [entityType, setEntityType] = useState<"person" | "zone">("zone");
  const [startDate,  setStartDate]  = useState(weekAgo);
  const [endDate,    setEndDate]    = useState(today);
  const [enabled,    setEnabled]    = useState(false);

  const { data, isLoading, refetch } = trpc.reports.generate.useQuery(
    { period, entityType, startDate, endDate },
    { enabled, staleTime: 60_000 },
  );

  const { data: zones } = trpc.zones.list.useQuery();

  const chartData = (data?.zoneBreakdown ?? []).map((z: any) => ({
    name:      z.zoneName ?? `Zone ${z.zoneId}`,
    visits:    z.visitCount,
    dwellMins: Math.round(z.totalDwellSec / 60),
  }));

  return (
    <div className="h-full overflow-y-auto p-6" style={{ background: "#0A0E1A" }}>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: ACCENT }}>
              Analytics Reports
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">Zone visit statistics and dwell analysis</p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm" variant="outline"
              onClick={() => { setEnabled(true); refetch(); toast.info("Generating report…"); }}
              style={{ borderColor: ACCENT, color: ACCENT }}
            >
              <RefreshCw className="w-4 h-4 mr-2" /> Generate
            </Button>
            <Button
              size="sm" variant="outline"
              onClick={() => exportCsv(data, period)}
              disabled={!data}
              style={{ borderColor: BORDER }}
            >
              <Download className="w-4 h-4 mr-2" /> Export CSV
            </Button>
          </div>
        </div>

        {/* Filters */}
        <Card style={{ background: BG_CARD, borderColor: BORDER }}>
          <CardContent className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground uppercase tracking-widest">Period</Label>
              <Tabs value={period} onValueChange={v => setPeriod(v as any)}>
                <TabsList className="w-full" style={{ background: "#0A0E1A" }}>
                  <TabsTrigger value="daily"   className="flex-1 text-xs">Daily</TabsTrigger>
                  <TabsTrigger value="weekly"  className="flex-1 text-xs">Weekly</TabsTrigger>
                  <TabsTrigger value="monthly" className="flex-1 text-xs">Monthly</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground uppercase tracking-widest">Entity</Label>
              <Select value={entityType} onValueChange={v => setEntityType(v as any)}>
                <SelectTrigger style={{ background: "#0A0E1A", borderColor: BORDER }}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: "#0D1421" }}>
                  <SelectItem value="zone">All Zones</SelectItem>
                  <SelectItem value="person">All Persons</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground uppercase tracking-widest">Start Date</Label>
              <Input
                type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                style={{ background: "#0A0E1A", borderColor: BORDER, colorScheme: "dark" }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground uppercase tracking-widest">End Date</Label>
              <Input
                type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                style={{ background: "#0A0E1A", borderColor: BORDER, colorScheme: "dark" }}
              />
            </div>
          </CardContent>
        </Card>

        {/* KPI cards */}
        {isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
          </div>
        )}
        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard icon={BarChart2} label="Total Visits"      value={data.totalVisits} />
              <StatCard icon={Clock}    label="Avg Dwell"          value={fmtDwell(data.avgDwellSeconds)} sub={`${fmtDwell(data.totalDwellSeconds)} total`} />
              <StatCard icon={Users}    label="Unique Persons"     value={data.uniquePersons} />
              <StatCard icon={TrendingUp} label="Peak Hour"        value={data.peakHour !== null ? `${data.peakHour}:00` : "—"} />
            </div>

            {/* Area chart — visits over time */}
            <Card style={{ background: BG_CARD, borderColor: BORDER }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                  Visits per Zone
                </CardTitle>
              </CardHeader>
              <CardContent className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="visitGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={ACCENT} stopOpacity={0.25} />
                        <stop offset="95%" stopColor={ACCENT} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1E2D40" />
                    <XAxis dataKey="name" tick={{ fill: "#8899AA", fontSize: 11 }} />
                    <YAxis tick={{ fill: "#8899AA", fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: "#0D1421", border: `1px solid ${BORDER}`, borderRadius: 8 }} />
                    <Area type="monotone" dataKey="visits" stroke={ACCENT} fill="url(#visitGrad)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Bar chart — avg dwell per zone */}
            <Card style={{ background: BG_CARD, borderColor: BORDER }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                  Avg Dwell by Zone (minutes)
                </CardTitle>
              </CardHeader>
              <CardContent className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1E2D40" />
                    <XAxis dataKey="name" tick={{ fill: "#8899AA", fontSize: 11 }} />
                    <YAxis tick={{ fill: "#8899AA", fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: "#0D1421", border: `1px solid ${BORDER}`, borderRadius: 8 }} />
                    <Bar dataKey="dwellMins" fill={ACCENT} radius={[3, 3, 0, 0]} opacity={0.85} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Zone breakdown table */}
            <Card style={{ background: BG_CARD, borderColor: BORDER }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Zone Breakdown</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                        {["Zone", "Visits", "Total Dwell", "Avg Dwell"].map(h => (
                          <th key={h} className="px-4 py-2 text-left text-xs text-muted-foreground uppercase tracking-widest">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.zoneBreakdown.map((z: any) => (
                        <tr key={z.zoneId} style={{ borderBottom: `1px solid ${BORDER}20` }} className="hover:bg-white/5">
                          <td className="px-4 py-2 font-medium">{z.zoneName ?? `Zone ${z.zoneId}`}</td>
                          <td className="px-4 py-2 font-mono" style={{ color: ACCENT }}>{z.visitCount}</td>
                          <td className="px-4 py-2 font-mono">{fmtDwell(z.totalDwellSec)}</td>
                          <td className="px-4 py-2 font-mono">{z.visitCount > 0 ? fmtDwell(Math.round(z.totalDwellSec / z.visitCount)) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
        {!isLoading && !data && (
          <div className="text-center text-muted-foreground py-20 text-sm">
            Configure filters above and click <span style={{ color: ACCENT }}>Generate</span> to load report data.
          </div>
        )}
      </div>
    </div>
  );
}
