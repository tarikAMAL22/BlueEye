import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Activity, Users, Camera, Film, AlertTriangle } from "lucide-react";

const PAGE_SIZE = 100;

type Tab = 'all' | 'face' | 'body';

const TABS = [
  { key: 'all' as Tab,  label: 'Motion Detection',    icon: '⬛' },
  { key: 'face' as Tab, label: 'Person Face Detected', icon: '👤' },
  { key: 'body' as Tab, label: 'Person Body Detected', icon: '🚶' },
];

export default function MotionsPage() {
  const [page, setPage]           = useState(0);
  const [tab, setTab]             = useState<Tab>('all');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const { data: stats } = trpc.motions.stats.useQuery({ hours: 24 }, { refetchInterval: 30000 });

  const { data, isLoading, refetch, isFetching } = trpc.motions.list.useQuery(
    { limit: PAGE_SIZE, offset: page * PAGE_SIZE, tab },
    { refetchInterval: 10000 }
  );

  const rows  = data?.rows  ?? [];
  const total = data?.total ?? 0;

  const handleTabChange = (t: Tab) => {
    setTab(t);
    setPage(0);
  };

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-wide">Événements de mouvement</h1>
          <p className="text-muted-foreground text-sm">{total} événements — 24 dernières heures</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Rafraîchir
        </Button>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-cyan-900/40 bg-[#0A0E1A]">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-cyan-900/30">
              <Film className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-widest">Total</p>
              <p className="text-2xl font-bold font-mono text-cyan-400">{stats?.total ?? 0}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-red-900/40 bg-[#0A0E1A]">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-900/30">
              <Users className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-widest">Multi-Person</p>
              <p className="text-2xl font-bold font-mono text-red-400">{stats?.multiPerson ?? 0}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-orange-900/40 bg-[#0A0E1A]">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-orange-900/30">
              <AlertTriangle className="w-5 h-5 text-orange-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-widest">With Alert</p>
              <p className="text-2xl font-bold font-mono text-orange-400">{stats?.withAlert ?? 0}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => handleTabChange(t.key)}
            className={`px-4 py-2 rounded text-sm font-mono transition-colors flex items-center gap-2
              ${tab === t.key
                ? 'bg-cyan-900/60 text-cyan-300 border border-cyan-700'
                : 'text-gray-500 hover:text-gray-300 border border-transparent'}`}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
            <span className="ml-1 text-xs opacity-60">
              {t.key === 'all'  ? (stats?.total      ?? 0) :
               t.key === 'face' ? (stats?.withFace   ?? 0) :
                                  (stats?.withBody   ?? 0)}
            </span>
          </button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Détections MOG2
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Activity className="w-10 h-10 mx-auto mb-2 opacity-20" />
              <p>Aucun événement de mouvement enregistré.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date/Heure</TableHead>
                  <TableHead><Camera className="w-3.5 h-3.5 inline mr-1" />Caméra</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead><Users className="w-3.5 h-3.5 inline mr-1" />Personnes</TableHead>
                  <TableHead>Surface mouvement</TableHead>
                  <TableHead>Snapshots</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m: any) => {
                  const frames = [m.frameSnapshotUrl, m.frame2Url, m.frame3Url].filter(Boolean);
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {new Date(m.detectedAt).toLocaleString("fr-FR")}
                      </TableCell>
                      <TableCell>{m.cameraName ?? `#${m.cameraId}`}</TableCell>
                      <TableCell>{m.zoneName ?? `#${m.zoneId}`}</TableCell>
                      <TableCell>
                        <span className={`font-semibold ${m.personsDetected > 0 ? "text-primary" : "text-muted-foreground"}`}>
                          {m.personsDetected}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {m.motionArea.toLocaleString()} px²
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {frames.map((url: string, i: number) => (
                            <div
                              key={i}
                              className="relative cursor-pointer group"
                              onClick={() => setPreviewUrl(url)}
                            >
                              <img
                                src={url}
                                alt={`frame ${i + 1}`}
                                className="w-16 h-10 object-cover rounded border border-border/40 group-hover:border-cyan-500/60 transition-colors"
                              />
                              <span className="absolute bottom-0.5 right-0.5 text-[9px] font-mono bg-black/70 text-cyan-400 px-0.5 rounded leading-tight">
                                F{i + 1}
                              </span>
                            </div>
                          ))}
                          {frames.length === 0 && (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Page {page + 1} / {Math.ceil(total / PAGE_SIZE)}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              Précédent
            </Button>
            <Button variant="outline" size="sm" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(p => p + 1)}>
              Suivant
            </Button>
          </div>
        </div>
      )}

      {/* Preview modal */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setPreviewUrl(null)}
        >
          <img
            src={previewUrl}
            alt="preview"
            className="max-w-3xl max-h-[80vh] rounded-lg border border-cyan-700/40 shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
