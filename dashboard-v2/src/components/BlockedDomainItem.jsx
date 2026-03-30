import { ShieldOff } from "lucide-react";

export default function BlockedDomainItem({ domain }) {
  return (
    <div className="flex items-center justify-between py-3 px-1">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-red-50 flex items-center justify-center">
          <ShieldOff className="h-4 w-4 text-red-400" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{domain.url}</p>
          <p className="text-xs text-muted-foreground">{domain.category}</p>
        </div>
      </div>
      <span className="text-xs text-muted-foreground">{domain.time}</span>
    </div>
  );
}