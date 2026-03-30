import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from "recharts";

const WEEK_DATA = [
  { day: "Mon", hours: 2.5 }, { day: "Tue", hours: 1.8 }, { day: "Wed", hours: 3.1 },
  { day: "Thu", hours: 2.0 }, { day: "Fri", hours: 2.7 }, { day: "Sat", hours: 3.5 },
  { day: "Sun", hours: 2.2 },
];

const MONTH_DATA = [
  { day: "W1", hours: 16.2 }, { day: "W2", hours: 18.5 }, { day: "W3", hours: 14.9 }, { day: "W4", hours: 19.1 },
];

export default function ScreenTimeSummary({ data }) {
  const [period, setPeriod] = useState("week");
  const [activeBar, setActiveBar] = useState(null);
  const chartData = period === "week" ? (data?.weekData || WEEK_DATA) : MONTH_DATA;

  return (
    <div>
      <div className="flex items-end justify-between mb-4">
        <div>
          <p className="text-2xl font-semibold" style={{color: '#1a2744'}}>{data?.todayTotal || "2h 15m"}</p>
          <p className="text-sm text-muted-foreground">today's screen time</p>
        </div>
        <div className="flex rounded-lg overflow-hidden border border-border text-xs font-medium">
          {["week", "month"].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className="px-3 py-1.5 transition-colors"
              style={period === p
                ? { background: '#5ab4d6', color: '#fff' }
                : { background: '#fff', color: '#1a2744' }
              }
            >
              {p === "week" ? "7 days" : "Month"}
            </button>
          ))}
        </div>
      </div>

      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} barSize={28} onMouseLeave={() => setActiveBar(null)}>
            <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#1a2744', opacity: 0.5 }} />
            <YAxis hide />
            <Tooltip
              contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px', fontSize: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
              formatter={(value) => [`${value}h`, "Screen time"]}
              cursor={{ fill: 'rgba(90,180,214,0.06)' }}
            />
            <Bar dataKey="hours" radius={[6, 6, 0, 0]} onMouseEnter={(_, i) => setActiveBar(i)}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={i === activeBar ? '#e85fa0' : '#5ab4d6'} opacity={i === activeBar ? 1 : 0.75} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {activeBar !== null && chartData[activeBar] && (
        <p className="text-xs text-center mt-1" style={{color: '#e85fa0', fontWeight: 500}}>
          {chartData[activeBar].day}: {chartData[activeBar].hours}h screen time
        </p>
      )}
    </div>
  );
}