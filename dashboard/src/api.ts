import axios from 'axios';

const API_BASE = 'https://meadow-production.up.railway.app';

const api = axios.create({ baseURL: API_BASE });

export async function getFamily(familyId: string) {
  const res = await api.get(`/api/v1/families/${familyId}`);
  return res.data;
}

export async function getChild(childId: string) {
  const res = await api.get(`/api/v1/children/${childId}`);
  return res.data;
}

export async function createChild(familyId: string, name: string, age: number) {
  const res = await api.post(`/api/v1/families/${familyId}/children`, { name, age });
  return res.data;
}

export async function analyzeUrl(url: string, deviceToken: string) {
  const res = await api.post(`/api/v1/analyze`, { url, device_token: deviceToken });
  return res.data;
}

export async function resolveUrl(domain: string, deviceToken: string) {
  const res = await api.post(`/api/v1/resolve`, { domain, device_token: deviceToken });
  return res.data;
}
