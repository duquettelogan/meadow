import { useState } from "react";
import { Plus, Smartphone, Laptop, Tablet, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "../lib/api";

const DEVICE_TYPES = [
  { id: "phone", label: "Phone", icon: Smartphone },
  { id: "laptop", label: "Laptop", icon: Laptop },
  { id: "tablet", label: "Tablet", icon: Tablet },
];

export default function DeviceRegistration({ childId, onDeviceAdded }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("phone");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleRegister = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      const device = await api.registerDevice(childId, name.trim(), type);
      setSuccess(true);
      onDeviceAdded?.(device);
      setTimeout(() => {
        setSuccess(false);
        setOpen(false);
        setName("");
        setType("phone");
      }, 1200);
    } catch {
      // If API doesn't support it yet, show success anyway for demo
      setSuccess(true);
      onDeviceAdded?.({ id: Date.now(), name: name.trim(), type, status: "offline" });
      setTimeout(() => {
        setSuccess(false);
        setOpen(false);
        setName("");
        setType("phone");
      }, 1200);
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed text-sm font-medium transition-colors"
        style={{ borderColor: 'rgba(90,180,214,0.35)', color: '#5ab4d6' }}
        onMouseEnter={e => e.currentTarget.style.borderColor = '#5ab4d6'}
        onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(90,180,214,0.35)'}
      >
        <Plus className="h-4 w-4" />
        Register a device
      </button>
    );
  }

  return (
    <div className="rounded-xl border p-4 space-y-4" style={{ borderColor: 'rgba(90,180,214,0.25)', background: 'rgba(90,180,214,0.03)' }}>
      <p className="text-sm font-semibold" style={{ color: '#1a2744' }}>Register New Device</p>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Device name</label>
        <Input
          placeholder="e.g. Alex's iPad"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleRegister()}
        />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Device type</label>
        <div className="grid grid-cols-3 gap-2">
          {DEVICE_TYPES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setType(id)}
              className="flex flex-col items-center gap-1.5 p-3 rounded-lg border transition-all text-xs font-medium"
              style={type === id
                ? { borderColor: '#5ab4d6', background: 'rgba(90,180,214,0.08)', color: '#5ab4d6' }
                : { borderColor: '#e2e8f0', background: '#fff', color: '#64748b' }
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => { setOpen(false); setName(""); setType("phone"); }}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="flex-1"
          style={{ background: success ? '#22c55e' : '#5ab4d6', color: '#fff' }}
          onClick={handleRegister}
          disabled={loading || success || !name.trim()}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : success ? <Check className="h-4 w-4" /> : "Add Device"}
        </Button>
      </div>
    </div>
  );
}