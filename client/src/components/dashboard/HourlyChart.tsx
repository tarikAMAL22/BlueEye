import { trpc } from "@/lib/trpc";
import {
  BarChart,
  Bar,
  XAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

export function HourlyChart() {
  const { data } = trpc.dashboard.hourlyActivity.useQuery(undefined, {
    refetchInterval: 60000,
  });

  const chartData = (data ?? []).map((d) => ({
    h: d.hour % 3 === 0 ? `${String(d.hour).padStart(2, "0")}h` : "",
    recognized: d.recognized,
    unknown: d.unknown,
  }));

  return (
    <div className="px-3 pb-3 flex-shrink-0">
      <div className="text-[9px] font-mono text-[#64748B] tracking-widest mb-1">
        24H ACTIVITY
      </div>
      <ResponsiveContainer width="100%" height={90}>
        <BarChart data={chartData} barSize={6} barGap={1}>
          <XAxis
            dataKey="h"
            tick={{ fontSize: 8, fill: "#64748B", fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: "#0D1117",
              border: "1px solid #1E293B",
              borderRadius: 4,
              fontSize: 10,
              fontFamily: "monospace",
              color: "#E2E8F0",
            }}
            cursor={{ fill: "#1E293B40" }}
            formatter={(value: number, name: string) => [
              value,
              name === "recognized" ? "Reconnu" : "Inconnu",
            ]}
          />
          <Bar dataKey="recognized" stackId="a" fill="#00F5FF" radius={[0, 0, 0, 0]} />
          <Bar dataKey="unknown" stackId="a" fill="#F97316" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
