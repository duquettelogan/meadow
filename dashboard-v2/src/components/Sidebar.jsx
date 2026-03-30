import { Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Bell, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { label: "Overview", path: "/", icon: LayoutDashboard },
  { label: "Alerts", path: "/alerts", icon: Bell },
  { label: "Settings", path: "/settings", icon: Settings },
];

export default function Sidebar() {
  const location = useLocation();

  return (
    <aside className="hidden lg:flex flex-col w-64 min-h-screen bg-sidebar border-r border-sidebar-border px-4 py-6">
      <Link to="/" className="flex items-center gap-2.5 px-3 mb-10">
        <img
          src="https://media.base44.com/images/public/69c7442c6719753dcba83a7e/c4886cf3b_DQsecLogoFinalFiles-01.png"
          alt="DQSec Meadow"
          className="h-9 w-auto object-contain"
        />
      </Link>

      <nav className="flex flex-col gap-1.5 flex-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path || 
            (item.path !== "/" && location.pathname.startsWith(item.path));
          const Icon = item.icon;

          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-sidebar-accent text-sidebar-primary"
                  : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 py-4 rounded-xl border" style={{background: 'rgba(90,180,214,0.08)', borderColor: 'rgba(90,180,214,0.18)'}}>
        <div className="flex items-center gap-2 mb-0.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 inline-block"></span>
          <p className="text-xs font-semibold" style={{color: '#5ab4d6'}}>All systems healthy</p>
        </div>
        <p className="text-xs pl-3.5" style={{color: 'rgba(210,225,240,0.5)'}}>Protection active on all devices</p>
      </div>
    </aside>
  );
}