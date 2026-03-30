import { useState, useEffect } from "react";
import { Plus, Leaf, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ChildCard from "../components/ChildCard";
import { api } from "../lib/api";

const KNOWN_CHILDREN = [
  {
    id: "e44129d0-54e6-4dd3-bcc5-a295ad753d52",
    name: "Alex",
    age: 10,
    protectionLevel: "Standard",
    devices: 1,
    screenTime: "2h 15m",
    todaySummary: "Loading data from Meadow...",
  },
];

export default function Overview() {
  const [children, setChildren] = useState(KNOWN_CHILDREN);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newChild, setNewChild] = useState({ name: "", age: "", protectionLevel: "Standard" });
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    Promise.all(
      KNOWN_CHILDREN.map(async (c) => {
        try {
          const data = await api.getChild(c.id);
          return {
            ...c,
            name: data.name,
            age: data.age,
            protectionLevel: data.protection_level || c.protectionLevel,
            todaySummary:
              data.blocked_categories?.length > 0
                ? `${data.blocked_categories.length} content categories blocked · Safe browsing active`
                : "Safe browsing active · No threats detected today",
          };
        } catch {
          return { ...c, todaySummary: "Unable to reach Meadow servers" };
        }
      })
    ).then(setChildren);
  }, []);

  const handleAddChild = async () => {
    if (!newChild.name || !newChild.age) return;
    setAdding(true);
    const created = await api.createChild(newChild.name, parseInt(newChild.age));
    const child = {
      id: created.id,
      name: created.name,
      age: created.age,
      protectionLevel: created.protection_level || newChild.protectionLevel,
      devices: 0,
      screenTime: "0h 00m",
      todaySummary: "No activity recorded yet. Add a device to get started.",
    };
    setChildren([...children, child]);
    setNewChild({ name: "", age: "", protectionLevel: "Standard" });
    setAdding(false);
    setDialogOpen(false);
  };

  return (
    <div>
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground tracking-tight">
            Good morning
          </h1>
          <p className="text-xs font-semibold tracking-widest mt-0.5" style={{color: 'hsl(var(--pink))'}}>MEADOW</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Here's your family's weekly digest
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="rounded-xl gap-2 shadow-none">
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Add child</span>
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add a child profile</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  placeholder="Child's name"
                  className="mt-1.5"
                  value={newChild.name}
                  onChange={(e) => setNewChild({ ...newChild, name: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="age">Age</Label>
                <Input
                  id="age"
                  type="number"
                  placeholder="Age"
                  className="mt-1.5"
                  value={newChild.age}
                  onChange={(e) => setNewChild({ ...newChild, age: e.target.value })}
                />
              </div>
              <div>
                <Label>Protection level</Label>
                <Select
                  value={newChild.protectionLevel}
                  onValueChange={(v) => setNewChild({ ...newChild, protectionLevel: v })}
                >
                  <SelectTrigger className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Strict">Strict</SelectItem>
                    <SelectItem value="Standard">Standard</SelectItem>
                    <SelectItem value="Moderate">Moderate</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button className="w-full rounded-xl" onClick={handleAddChild} disabled={adding}>
                {adding ? "Adding..." : "Add profile"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex items-center gap-3 p-4 rounded-2xl bg-primary/5 border border-primary/10 mb-8">
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Shield className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">All protections active</p>
          <p className="text-xs text-muted-foreground">
            {children.length} profiles monitored · {children.reduce((sum, c) => sum + c.devices, 0)} devices connected
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-5">
        {children.map((child, i) => (
          <ChildCard key={child.id} child={child} index={i} />
        ))}
      </div>
    </div>
  );
}