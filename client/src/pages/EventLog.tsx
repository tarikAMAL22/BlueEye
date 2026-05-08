import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, Search, RefreshCw } from "lucide-react";

export default function EventLog() {
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);

  const { data: eventsData, isLoading, refetch } = trpc.events.list.useQuery(
    { limit: pageSize, offset: page * pageSize },
    { refetchInterval: isAutoRefresh ? 5000 : false }
  );

  // Determine threat level based on confidence
  const getThreatLevel = (confidence: number): string => {
    if (confidence >= 0.9) return "critical";
    if (confidence >= 0.75) return "high";
    if (confidence >= 0.6) return "medium";
    return "low";
  };

  const threatLevelColor = (level: string) => {
    switch (level) {
      case "low":
        return "threat-low";
      case "medium":
        return "threat-medium";
      case "high":
        return "threat-high";
      case "critical":
        return "threat-critical";
      default:
        return "threat-medium";
    }
  };

  const handleExportCSV = () => {
    if (!eventsData?.events) return;

    const headers = ["ID", "Person ID", "Camera ID", "Zone ID", "Confidence", "Event Type", "Threat Level", "Timestamp"];
    const rows = eventsData.events.map((event: any) => [
      event.id,
      event.personId || "Unknown",
      event.cameraId,
      event.zoneId,
      event.confidence,
      event.eventType,
      getThreatLevel(parseFloat(event.confidence as any)),
      new Date(event.timestamp).toLocaleString(),
    ]);

    const csv = [headers, ...rows].map((row) => row.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `event-log-${new Date().toISOString()}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const filteredEvents = eventsData?.events?.filter((event: any) =>
    searchTerm === "" ||
    String(event.id).includes(searchTerm) ||
    String(event.personId).includes(searchTerm) ||
    String(event.cameraId).includes(searchTerm)
  ) || [];

  return (
    <div className="space-y-6 p-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-primary">Event Log</h1>
          <p className="text-muted-foreground">Historical record of all recognition events</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={isAutoRefresh ? "default" : "outline"}
            onClick={() => setIsAutoRefresh(!isAutoRefresh)}
            className={isAutoRefresh ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isAutoRefresh ? "animate-spin" : ""}`} />
            {isAutoRefresh ? "Auto-refresh ON" : "Auto-refresh OFF"}
          </Button>
          <Button
            onClick={handleExportCSV}
            className="gap-2 bg-secondary text-secondary-foreground hover:bg-secondary/90"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <Card className="glow-card bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle>Event History</CardTitle>
          <CardDescription>Search and filter all recognition events</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Search Bar */}
          <div className="relative">
            <Search className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by ID, person, or camera..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPage(0);
              }}
              className="pl-10 bg-input border-border"
            />
          </div>

          {/* Events Table */}
          {isLoading ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50">
                    <TableHead><Skeleton className="h-4 w-8" /></TableHead>
                    <TableHead><Skeleton className="h-4 w-20" /></TableHead>
                    <TableHead><Skeleton className="h-4 w-20" /></TableHead>
                    <TableHead><Skeleton className="h-4 w-16" /></TableHead>
                    <TableHead><Skeleton className="h-4 w-20" /></TableHead>
                    <TableHead><Skeleton className="h-4 w-24" /></TableHead>
                    <TableHead><Skeleton className="h-4 w-16" /></TableHead>
                    <TableHead><Skeleton className="h-4 w-32" /></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                    <TableRow key={i} className="border-border/50">
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((j) => (
                        <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : filteredEvents.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50">
                    <TableHead>ID</TableHead>
                    <TableHead>Person</TableHead>
                    <TableHead>Camera</TableHead>
                    <TableHead>Zone</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Threat Level</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Timestamp</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEvents.map((event: any) => {
                    const threatLevel = getThreatLevel(parseFloat(event.confidence as any));
                    return (
                      <TableRow key={event.id} className="border-border/50 hover:bg-accent/5">
                        <TableCell className="font-medium data-value">#{event.id}</TableCell>
                        <TableCell className="data-value">
                          {event.personId ? `#${event.personId}` : "Unknown"}
                        </TableCell>
                        <TableCell className="data-value">#{event.cameraId}</TableCell>
                        <TableCell className="data-value">#{event.zoneId}</TableCell>
                        <TableCell className="data-value text-primary">{event.confidence}%</TableCell>
                        <TableCell>
                          <Badge className={`${threatLevelColor(threatLevel)}`}>
                            {threatLevel.toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {event.eventType}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground data-value">
                          {new Date(event.timestamp).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No events found matching your search.
            </div>
          )}

          {/* Pagination */}
          {!isLoading && (eventsData?.events?.length ?? 0) > 0 && (
            <div className="flex justify-between items-center pt-4 border-t border-border/50">
              <p className="text-sm text-muted-foreground">
                Page {page + 1} • Showing {filteredEvents.length} of {eventsData?.total || 0} events
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setPage(page + 1)}
                  disabled={(eventsData?.events?.length ?? 0) < pageSize}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
