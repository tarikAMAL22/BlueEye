import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Activity, Users, Camera } from "lucide-react";

const PAGE_SIZE = 100;

export default function MotionsPage() {
  const [page, setPage] = useState(0);

  const { data, isLoading, refetch, isFetching } = trpc.motions.list.useQuery(
    { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    { refetchInterval: 10000 }
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Événements de mouvement</h1>
          <p className="text-muted-foreground text-sm">{total} événements au total</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Rafraîchir
        </Button>
      </div>

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
                  <TableHead>Snapshot</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m: any) => (
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
                      {m.frameSnapshotUrl ? (
                        <img
                          src={m.frameSnapshotUrl}
                          alt="snapshot"
                          className="w-16 h-10 object-cover rounded border border-border/40"
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
    </div>
  );
}
