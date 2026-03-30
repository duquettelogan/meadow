import { Link } from "react-router-dom";
import { Monitor, Shield, ChevronRight, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

const avatarColors = [
  { bg: 'rgba(90,180,214,0.12)', color: '#5ab4d6' },
  { bg: 'rgba(232,95,160,0.10)', color: '#e85fa0' },
  { bg: 'rgba(90,180,214,0.08)', color: '#3a90b0' },
  { bg: 'rgba(232,95,160,0.07)', color: '#c0488a' },
];

export default function ChildCard({ child, index }) {
  const avatarStyle = avatarColors[index % avatarColors.length];
  const initial = child.name.charAt(0).toUpperCase();

  return (
    <Link
      to={`/child/${child.id}`}
      className="group block bg-card rounded-2xl border border-border p-5 sm:p-6 hover:border-primary/30 hover:shadow-sm transition-all duration-300"
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3.5">
          <div className="h-11 w-11 rounded-full flex items-center justify-center text-lg font-semibold" style={{background: avatarStyle.bg, color: avatarStyle.color}}>
            {initial}
          </div>
          <div>
            <h3 className="font-semibold text-foreground">{child.name}</h3>
            <p className="text-sm text-muted-foreground">Age {child.age}</p>
          </div>
        </div>
        <ChevronRight className="h-5 w-5 text-muted-foreground/40 group-hover:text-primary transition-colors" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col items-center p-2.5 rounded-xl bg-muted/50">
          <Shield className="h-4 w-4 text-primary mb-1" />
          <span className="text-[11px] font-medium text-muted-foreground">{child.protectionLevel}</span>
        </div>
        <div className="flex flex-col items-center p-2.5 rounded-xl bg-muted/50">
          <Monitor className="h-4 w-4 text-primary mb-1" />
          <span className="text-[11px] font-medium text-muted-foreground">{child.devices} devices</span>
        </div>
        <div className="flex flex-col items-center p-2.5 rounded-xl bg-muted/50">
          <Clock className="h-4 w-4 text-primary mb-1" />
          <span className="text-[11px] font-medium text-muted-foreground">{child.screenTime}</span>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-border/60">
        <p className="text-xs text-muted-foreground leading-relaxed">{child.todaySummary}</p>
      </div>
    </Link>
  );
}