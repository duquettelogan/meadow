import { base44 } from '@/api/base44Client';

const FAMILY_ID = "04f29e94-a5c8-4792-af1f-b785dc860302";

async function call(action, params = {}) {
  const res = await base44.functions.invoke('meadowProxy', { action, ...params });
  if (!res.data.ok) throw new Error(`Meadow API error ${res.data.status}`);
  return res.data.data;
}

export const api = {
  FAMILY_ID,
  getFamily: () => call('getFamily'),
  getChild: (childId) => call('getChild', { childId }),
  createChild: (name, age) => call('createChild', { name, age }),
  getAlerts: (childId) => call('getAlerts', { childId }),
  getDevices: (childId) => call('getDevices', { childId }),
  updatePolicy: (childId, policy) => call('updatePolicy', { childId, policy }),
  registerDevice: (childId, deviceName, deviceType) => call('registerDevice', { childId, deviceName, deviceType }),
};