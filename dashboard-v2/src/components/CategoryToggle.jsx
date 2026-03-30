import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export default function CategoryToggle({ category, enabled, onToggle }) {
  return (
    <div className="flex items-center justify-between py-3.5 px-1">
      <div className="flex items-center gap-3">
        <div className={cn(
          "h-8 w-8 rounded-lg flex items-center justify-center",
          enabled ? "bg-primary/10" : "bg-muted"
        )}>
          <category.Icon className={cn("h-4 w-4", enabled ? "text-primary" : "text-muted-foreground/50")} />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{category.name}</p>
          <p className="text-xs text-muted-foreground">{category.description}</p>
        </div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={() => onToggle(category.id)}
        style={enabled ? { '--switch-bg': '#5ab4d6' } : {}}
        className={enabled ? '[&>[data-state=checked]]:bg-[#5ab4d6]' : ''}
      />
    </div>
  );
}