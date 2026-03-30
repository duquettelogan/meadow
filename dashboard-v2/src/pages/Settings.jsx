import { useState } from "react";
import { User, CreditCard, Bell, Shield, ChevronRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default function Settings() {
  const [notifications, setNotifications] = useState({
    pushAlerts: true,
    emailDigest: true,
    weeklyReport: true,
    instantHigh: true,
  });

  const toggleNotification = (key) => {
    setNotifications(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl sm:text-3xl font-semibold text-foreground tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">Manage your family account</p>
      </div>

      <div className="space-y-6 max-w-2xl">
        {/* Family Account */}
        <section className="bg-card rounded-2xl border border-border p-5 sm:p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <User className="h-5 w-5 text-primary" />
            </div>
            <h2 className="text-base font-semibold text-foreground">Family Account</h2>
          </div>
          <div className="space-y-4">
            <div>
              <Label htmlFor="familyName" className="text-sm">Family name</Label>
              <Input id="familyName" defaultValue="The Johnsons" className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="email" className="text-sm">Primary email</Label>
              <Input id="email" defaultValue="sarah@johnson.family" className="mt-1.5" />
            </div>
            <Button variant="outline" className="rounded-xl shadow-none">Save changes</Button>
          </div>
        </section>

        {/* Subscription */}
        <section className="bg-card rounded-2xl border border-border p-5 sm:p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <CreditCard className="h-5 w-5 text-primary" />
            </div>
            <h2 className="text-base font-semibold text-foreground">Subscription</h2>
          </div>
          <div className="flex items-center justify-between p-4 rounded-xl bg-primary/5 border border-primary/10">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-foreground">Meadow Family Plan</p>
                <span className="text-[10px] font-medium bg-primary text-primary-foreground px-2 py-0.5 rounded-full">
                  Active
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Up to 5 child profiles · Unlimited devices</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-semibold text-foreground">$9.99</p>
              <p className="text-xs text-muted-foreground">/month</p>
            </div>
          </div>
          <div className="mt-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-primary" />
              <span className="text-sm text-muted-foreground">Real-time content filtering</span>
            </div>
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-primary" />
              <span className="text-sm text-muted-foreground">Weekly digest reports</span>
            </div>
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-primary" />
              <span className="text-sm text-muted-foreground">Instant high-severity alerts</span>
            </div>
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-primary" />
              <span className="text-sm text-muted-foreground">Screen time tracking</span>
            </div>
          </div>
          <Separator className="my-4" />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Next billing date: April 15, 2026</p>
            <Button variant="ghost" className="text-sm text-muted-foreground h-auto p-0 hover:text-foreground">
              Manage billing <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        </section>

        {/* Notifications */}
        <section className="bg-card rounded-2xl border border-border p-5 sm:p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <Bell className="h-5 w-5 text-primary" />
            </div>
            <h2 className="text-base font-semibold text-foreground">Notifications</h2>
          </div>
          <div className="space-y-1 divide-y divide-border/60">
            <div className="flex items-center justify-between py-3.5">
              <div>
                <p className="text-sm font-medium text-foreground">Push notifications</p>
                <p className="text-xs text-muted-foreground">Get notified on your phone</p>
              </div>
              <Switch
                checked={notifications.pushAlerts}
                onCheckedChange={() => toggleNotification("pushAlerts")}
              />
            </div>
            <div className="flex items-center justify-between py-3.5">
              <div>
                <p className="text-sm font-medium text-foreground">Email digest</p>
                <p className="text-xs text-muted-foreground">Daily summary sent to your inbox</p>
              </div>
              <Switch
                checked={notifications.emailDigest}
                onCheckedChange={() => toggleNotification("emailDigest")}
              />
            </div>
            <div className="flex items-center justify-between py-3.5">
              <div>
                <p className="text-sm font-medium text-foreground">Weekly report</p>
                <p className="text-xs text-muted-foreground">Detailed weekly activity overview</p>
              </div>
              <Switch
                checked={notifications.weeklyReport}
                onCheckedChange={() => toggleNotification("weeklyReport")}
              />
            </div>
            <div className="flex items-center justify-between py-3.5">
              <div>
                <p className="text-sm font-medium text-foreground">Instant high-severity alerts</p>
                <p className="text-xs text-muted-foreground">Immediate notification for critical events</p>
              </div>
              <Switch
                checked={notifications.instantHigh}
                onCheckedChange={() => toggleNotification("instantHigh")}
              />
            </div>
          </div>
        </section>

        {/* Privacy */}
        <section className="bg-card rounded-2xl border border-border p-5 sm:p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <Shield className="h-5 w-5 text-primary" />
            </div>
            <h2 className="text-base font-semibold text-foreground">Privacy & Data</h2>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Meadow takes your family's privacy seriously. All browsing data is encrypted
            and never shared with third parties. Activity logs are automatically deleted
            after 30 days.
          </p>
          <div className="flex gap-3 mt-4">
            <Button variant="outline" className="rounded-xl shadow-none text-sm">
              Export data
            </Button>
            <Button variant="ghost" className="rounded-xl text-sm text-destructive hover:text-destructive hover:bg-destructive/10">
              Delete account
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}