import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const BASE_URL = "https://meadow-production.up.railway.app";
const FAMILY_ID = "04f29e94-a5c8-4792-af1f-b785dc860302";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { action, childId, name, age, deviceName, deviceType, policy } = body;

    let url, options = { headers: { "Content-Type": "application/json" } };

    if (action === "getFamily") {
      url = `${BASE_URL}/api/v1/families/${FAMILY_ID}`;
    } else if (action === "getChild") {
      url = `${BASE_URL}/api/v1/children/${childId}`;
    } else if (action === "createChild") {
      url = `${BASE_URL}/api/v1/families/${FAMILY_ID}/children`;
      options = { ...options, method: "POST", body: JSON.stringify({ name, age }) };
    } else if (action === "getAlerts") {
      url = `${BASE_URL}/api/v1/children/${childId}/alerts`;
    } else if (action === "getDevices") {
      url = `${BASE_URL}/api/v1/children/${childId}/devices`;
    } else if (action === "registerDevice") {
      url = `${BASE_URL}/api/v1/children/${childId}/devices`;
      options = { ...options, method: "POST", body: JSON.stringify({ name: deviceName, type: deviceType, device_token: `device-${Date.now()}` }) };
    } else if (action === "updatePolicy") {
      url = `${BASE_URL}/api/v1/children/${childId}/policy`;
      options = { ...options, method: "PATCH", body: JSON.stringify(policy) };
    } else {
      return Response.json({ error: "Unknown action" }, { status: 400 });
    }

    const res = await fetch(url, options);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    return Response.json({ ok: res.ok, status: res.status, data });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});