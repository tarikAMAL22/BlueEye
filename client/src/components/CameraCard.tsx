import { Video, AlertCircle, MapPin, Wifi } from "lucide-react";

interface CameraSummary {
  id: number;
  name: string;
  location: string | null;
  zoneId: number | null;
  status: string;
  openAlerts?: number;
  activeAlerts: number;
  lastSnapshot: string | null;
}

interface Props {
  camera: CameraSummary;
  zoneName: string;
  isSelected: boolean;
  onClick: () => void;
  onLive: () => void;
}

export function CameraCard({ camera, zoneName, isSelected, onClick, onLive }: Props) {
  const isOnline = camera.status === "online";
  const openAlerts = camera.openAlerts ?? camera.activeAlerts;

  return (
    <div
      onClick={onClick}
      className={`relative flex flex-col rounded-xl border cursor-pointer transition-all duration-200 overflow-hidden group
        ${isSelected
          ? "border-[#06b6d4] bg-[#06b6d4]/10 shadow-[0_0_12px_rgba(6,182,212,0.25)]"
          : "border-[#1E293B] bg-[#080D14] hover:border-[#2D3748]"
        }`}
    >
      {/* Snapshot / placeholder */}
      <div className="relative aspect-video w-full bg-[#0D1117] overflow-hidden">
        {camera.lastSnapshot ? (
          <img
            src={camera.lastSnapshot}
            alt={camera.name}
            className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Video className="w-6 h-6 text-[#2D3748]" />
          </div>
        )}

        {/* Online indicator */}
        <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? "bg-emerald-400" : "bg-red-400"}`} />
          <span className="text-[8px] font-mono text-[#94A3B8] uppercase">{camera.status}</span>
        </div>

        {/* Open alerts badge — always visible, red pulse if > 0, green if clear */}
        <div className={`absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-mono font-bold text-white ${
          openAlerts > 0 ? "bg-red-500/90 animate-pulse" : "bg-emerald-600/80"
        }`}>
          <AlertCircle className="w-2.5 h-2.5" />
          {openAlerts}
        </div>

        {/* LIVE button — always visible */}
        <button
          onClick={(e) => { e.stopPropagation(); onLive(); }}
          className="absolute bottom-1.5 right-1.5 flex items-center gap-1 px-2 py-0.5 rounded
            bg-[#ec4899]/80 hover:bg-[#ec4899] text-white text-[8px] font-mono font-bold"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
          LIVE
        </button>
      </div>

      {/* Info */}
      <div className="px-2.5 py-2 space-y-0.5">
        <p className="text-[11px] font-mono font-bold text-[#E2E8F0] truncate">{camera.name}</p>
        <div className="flex items-center gap-1 text-[9px] font-mono text-[#64748B]">
          <MapPin className="w-2.5 h-2.5" />
          <span className="truncate">{zoneName}{camera.location ? ` · ${camera.location}` : ""}</span>
        </div>
      </div>
    </div>
  );
}
