import { useState } from "react";
import { TopBar } from "@/components/dashboard/TopBar";
import { KpiCards } from "@/components/dashboard/KpiCards";
import { ZoneStatus } from "@/components/dashboard/ZoneStatus";
import { LiveAlertsFeed } from "@/components/dashboard/LiveAlertsFeed";
import { CameraGrid } from "@/components/dashboard/CameraGrid";
import { SystemHealth } from "@/components/dashboard/SystemHealth";

export default function Dashboard() {
  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#0D1117]">
      <TopBar />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left column — KPIs + Zone status */}
        <div className="w-[280px] flex-shrink-0 flex flex-col border-r border-[#1E293B] overflow-hidden bg-[#0D1117]">
          <KpiCards />
          <ZoneStatus
            selectedZoneId={selectedZoneId}
            onZoneSelect={setSelectedZoneId}
          />
        </div>

        {/* Center column — Live alerts feed */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-[#1E293B] overflow-hidden bg-[#080D14]">
          <LiveAlertsFeed
            selectedZoneId={selectedZoneId}
            onClearZone={() => setSelectedZoneId(null)}
          />
        </div>

        {/* Right column — Camera grid + system health */}
        <div className="w-[320px] flex-shrink-0 flex flex-col overflow-y-auto bg-[#0D1117]">
          <CameraGrid />
          <SystemHealth />
        </div>
      </div>
    </div>
  );
}
