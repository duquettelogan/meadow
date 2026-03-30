import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { Bell, CheckCheck, ShieldOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format, parseISO } from "date-fns";

const CHILD_ID = "e44129d0-54e6-4dd3-bcc5-a295ad753d52";

const CATEGORY_LABELS = {
  adult: "Adult Content",
  gambling: "Gambling",
  violence: "Violence",
  social_media: "Social Media",
  gaming: "Gaming",
  drugs: "Drugs & Alcohol",
  hate_speech: "Hate Speech",
  self_harm: "Self Harm",
};

function formatTimestamp(isoString) {
  if (!isoString) return "";
  try {
    return format(parseISO(isoString), "MMM d, h:mm a");
  } catch {
    return isoString;
  }
}

function AlertCard({ alert, onDismiss }) {
  return (
    <div className="flex items-start gap-4 bg-card border border-border rounded-2xl p-4 sm:p-5">
      <div className="h-9 w-9 rounded-xl bg-destructive/8 flex items-center justify-center shrink-0 mt-0.5">
        <ShieldOff className="h-4 w-4 text-destructive" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-foreground truncate">{alert.domain}</p>
            {alert.reason && (
              <p className="text-sm text-muted-foreground mt-0.5 leading-snug">{alert.reason}</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground -mt-1 -mr-1"
            onClick={() => onDismiss(alert.id || alert.domain)}
          >
            <span className="text-lg leading-none">×</span>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-2.5">
          {alert.category && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-md bg-primary/8 text-primary">
              {CATEGORY_LABELS[alert.category] || alert.category}
            </span>
          )}
          {alert.verdict && alert.verdict !== "blocked" && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-md bg-muted text-muted-foreground">
              {alert.verdict}
            </span>
          )}
          {alert.resolved_at && (
            <span className="text-xs text-muted-foreground">{formatTimestamp(alert.resolved_at)}</span>
          )}
          {alert.latency_ms && (
            <span className="text-xs text-muted-foreground/60">{alert.latency_ms}ms</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Alerts() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(new Set());

  const fetchAlerts = () => {
    return api.getAlerts(CHILD_ID)
      .then((data) => {
        if (Array.isArray(data)) setAlerts(data);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchAlerts().finally(() => setLoading(false));
    const timer = setInterval(fetchAlerts, 30000);
    return () => clearInterval(timer);
  }, []);

  const handleDismiss = (id) => setDismissed(prev => new Set([...prev, id]));
  const handleDismissAll = () => setDismissed(new Set(alerts.map(a => a.id || a.domain)));

  const visible = alerts.filter(a => !dismissed.has(a.id || a.domain));

  return (
    <div>
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground tracking-tight">Alerts</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {loading ? "Loading…" : visible.length > 0 ? `${visible.length} blocked domains` : "No alerts — all clear"}
          </p>
        </div>
        {visible.length > 0 && (
          <Button variant="outline" className="rounded-xl gap-2 text-sm shadow-none" onClick={handleDismissAll}>
            <CheckCheck className="h-4 w-4" />
            <span className="hidden sm:inline">Dismiss all</span>
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-20">
          <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Bell className="h-7 w-7 text-primary" />
          </div>
          <p className="text-lg font-medium text-foreground">No alerts</p>
          <p className="text-sm text-muted-foreground mt-1">Everything looks calm. We'll notify you if something comes up.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((alert, i) => (
            <AlertCard key={alert.id || alert.domain || i} alert={alert} onDismiss={handleDismiss} />
          ))}
        </div>
      )}
    </div>
  );
}