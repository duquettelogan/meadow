import { X, AlertTriangle, ShieldAlert, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const severityConfig = {
  high: { color: "bg-red-50 border-red-100", icon: ShieldAlert, iconColor: "text-red-500" },
  medium: { color: "bg-amber-50 border-amber-100", icon: AlertTriangle, iconColor: "text-amber-500" },
  low: { color: "bg-primary/5 border-primary/10", icon: Clock, iconColor: "text-primary" },
  critical: { color: "border-pink/20", icon: ShieldAlert, iconColor: "text-pink" },
};

export default function AlertItem({ alert, onDismiss }) {
  const config = severityConfig[alert.severity] || severityConfig.low;
  const Icon = config.icon;

  return (
    <div className={cn("rounded-xl border p-4 sm:p-5 transition-all duration-300", config.color)}>
      <div className="flex items-start gap-3.5">
        <div className="mt-0.5">
          <Icon className={cn("h-5 w-5", config.iconColor)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">{alert.childName}</p>
              <p className="text-sm text-foreground/80 mt-0.5">{alert.description}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => onDismiss(alert.id)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-2 mt-2.5">
            <span className="text-xs font-medium text-muted-foreground bg-background/60 px-2 py-0.5 rounded-md">
              {alert.domain}
            </span>
            <span className="text-xs text-muted-foreground">{alert.timestamp}</span>
          </div>
        </div>
      </div>
    </div>
  );
}