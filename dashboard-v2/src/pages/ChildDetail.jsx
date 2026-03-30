import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Shield, Loader2, Globe, Dice6, Zap, MessageSquare, Gamepad2, FlaskConical, Heart, AlertTriangle } from "lucide-react";
import CategoryToggle from "../components/CategoryToggle";
import ScreenTimeSummary from "../components/ScreenTimeSummary";
import DeviceRegistration from "../components/DeviceRegistration";
import { api } from "../lib/api";

const CATEGORY_META = {
  adult:        { name: "Adult Content",   description: "Explicit or mature content",          Icon: Globe },
  gambling:     { name: "Gambling",         description: "Betting and gambling sites",           Icon: Dice6 },
  violence:     { name: "Violence",         description: "Graphic or violent content",           Icon: Zap },
  social_media: { name: "Social Media",     description: "Social networking platforms",          Icon: MessageSquare },
  gaming:       { name: "Online Gaming",    description: "Multiplayer gaming platforms",         Icon: Gamepad2 },
  drugs:        { name: "Drugs & Alcohol",  description: "Substance-related content",            Icon: FlaskConical },
  hate_speech:  { name: "Hate Speech",      description: "Discriminatory or hateful content",   Icon: AlertTriangle },
  self_harm:    { name: "Self Harm",        description: "Content promoting self-harm",          Icon: Heart },
};

export default function ChildDetail() {
  const { id } = useParams();
  const [child, setChild] = useState(null);
  const [categories, setCategories] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.getChild(id), api.getDevices(id).catch(() => [])])
      .then(([data, devs]) => {
        setChild(data);
        setDevices(Array.isArray(devs) ? devs : []);
        const cats = Object.entries(CATEGORY_META).map(([key, meta]) => ({
          id: key,
          ...meta,
          enabled: data.blocked_categories?.includes(key) ?? false,
        }));
        setCategories(cats);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  const handleToggle = async (catId) => {
    const updated = categories.map(c => c.id === catId ? { ...c, enabled: !c.enabled } : c);
    setCategories(updated);
    const blockedCategories = updated.filter(c => c.enabled).map(c => c.id);
    setSaving(true);
    try {
      await api.updatePolicy(id, { blocked_categories: blockedCategories });
    } catch {
      // revert on failure
      setCategories(categories);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !child) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground">{error || "Child profile not found."}</p>
        <Link to="/" className="text-primary text-sm mt-2 inline-block hover:underline">Go back</Link>
      </div>
    );
  }

  const screenTime = {
    todayTotal: "2h 15m",
    weeklyAvg: "2h 30m/day",
    weekData: [
      { day: "Mon", hours: 2.5 }, { day: "Tue", hours: 1.8 }, { day: "Wed", hours: 3.1 },
      { day: "Thu", hours: 2.0 }, { day: "Fri", hours: 2.7 }, { day: "Sat", hours: 3.5 },
      { day: "Sun", hours: 2.2 },
    ],
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" />
          Back to overview
        </Link>
        {saving && <span className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Saving…</span>}
      </div>

      <div className="flex items-center gap-4 mb-8">
        <div className="h-14 w-14 rounded-2xl flex items-center justify-center text-2xl font-semibold" style={{background: 'rgba(232,95,160,0.10)', color: '#e85fa0'}}>
          {child.name.charAt(0)}
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" style={{color: '#1a2744'}}>{child.name}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-sm text-muted-foreground">Age {child.age}</span>
            <span className="text-muted-foreground/30">·</span>
            <div className="flex items-center gap-1">
              <Shield className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm text-primary font-medium capitalize">{child.protection_level}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Content Filters */}
        <section className="bg-card rounded-2xl border border-border p-5 sm:p-6">
          <h2 className="text-base font-semibold mb-1" style={{color: '#1a2744'}}>Content Filters</h2>
          <p className="text-xs text-muted-foreground mb-4">Control what categories are blocked</p>
          <div className="divide-y divide-border/60">
            {categories.map((cat) => (
              <CategoryToggle key={cat.id} category={cat} enabled={cat.enabled} onToggle={handleToggle} />
            ))}
          </div>
        </section>

        {/* Safety Settings */}
        <section className="bg-card rounded-2xl border border-border p-5 sm:p-6">
          <h2 className="text-base font-semibold mb-1" style={{color: '#1a2744'}}>Safety Settings</h2>
          <p className="text-xs text-muted-foreground mb-4">Current protection configuration</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-border/60">
              <div>
                <span className="text-sm font-medium text-foreground">Safe Search</span>
                <p className="text-xs text-muted-foreground">Force safe results across search engines</p>
              </div>
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${child.safe_search_enforce ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                {child.safe_search_enforce ? "On" : "Off"}
              </span>
            </div>
            <div className="flex items-center justify-between py-2">
              <div>
                <span className="text-sm font-medium text-foreground">Restricted Mode</span>
                <p className="text-xs text-muted-foreground">Enforce safe content across video platforms</p>
              </div>
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${child.youtube_restrict ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                {child.youtube_restrict ? "On" : "Off"}
              </span>
            </div>
          </div>
        </section>

        {/* Registered Devices */}
        <section className="bg-card rounded-2xl border border-border p-5 sm:p-6">
          <h2 className="text-base font-semibold mb-1" style={{color: '#1a2744'}}>Registered Devices</h2>
          <p className="text-xs text-muted-foreground mb-4">Devices under this child's profile</p>
          <div className="space-y-2 mb-3">
            {devices.length > 0 ? (
              devices.map((d, i) => (
                <div key={d.id || i} className="flex items-center gap-3 py-2.5 px-3 rounded-xl bg-muted/40">
                  <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                    <span className="text-sm">{d.platform === 'ios' || d.platform === 'android' ? '📱' : d.platform === 'macos' || d.platform === 'windows' ? '💻' : '📱'}</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-foreground capitalize">{d.platform || "Device"}</p>
                    <p className="text-xs text-muted-foreground">{d.last_seen ? `Last seen ${d.last_seen}` : d.device_token?.slice(0, 16) + '…'}</p>
                  </div>
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground text-center py-2">No devices registered yet</p>
            )}
          </div>
          <DeviceRegistration childId={id} onDeviceAdded={(d) => setDevices(prev => [...prev, d])} />
        </section>

        {/* Screen Time */}
        <section className="bg-card rounded-2xl border border-border p-5 sm:p-6">
          <h2 className="text-base font-semibold mb-1" style={{color: '#1a2744'}}>Screen Time</h2>
          <p className="text-xs text-muted-foreground mb-4">This week's usage overview</p>
          <ScreenTimeSummary data={screenTime} />
        </section>
      </div>
    </div>
  );
}