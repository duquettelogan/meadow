import { Smartphone, Laptop, Tablet, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

const deviceIcons = {
  phone: Smartphone,
  laptop: Laptop,
  tablet: Tablet,
};

export default function DeviceItem({ device }) {
  const Icon = deviceIcons[device.type] || Smartphone;
  const isOnline = device.status === "online";

  return (
    <div className="flex items-center justify-between py-3 px-1">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{device.name}</p>
          <p className="text-xs text-muted-foreground">{device.lastActive}</p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {isOnline ? (
          <Wifi className="h-3.5 w-3.5 text-primary" />
        ) : (
          <WifiOff className="h-3.5 w-3.5 text-muted-foreground/50" />
        )}
        <span className={cn(
          "text-xs font-medium",
          isOnline ? "text-primary" : "text-muted-foreground/60"
        )}>
          {isOnline ? "Online" : "Offline"}
        </span>
      </div>
    </div>
  );
}