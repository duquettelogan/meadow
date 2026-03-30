import { Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Bell, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { label: "Overview", path: "/", icon: LayoutDashboard },
  { label: "Alerts", path: "/alerts", icon: Bell },
  { label: "Settings", path: "/settings", icon: Settings },
];

export default function MobileNav() {
  const location = useLocation();

  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-border px-2 py-2 flex justify-around">
      {navItems.map((item) => {
        const isActive = location.pathname === item.path ||
          (item.path !== "/" && location.pathname.startsWith(item.path));
        const Icon = item.icon;

        return (
          <Link
            key={item.path}
            to={item.path}
            className={cn(
              "flex flex-col items-center gap-1 px-4 py-1.5 rounded-lg transition-colors",
              isActive
                ? "text-primary"
                : "text-muted-foreground"
            )}
          >
            <Icon className="h-5 w-5" />
            <span className="text-[10px] font-medium">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}