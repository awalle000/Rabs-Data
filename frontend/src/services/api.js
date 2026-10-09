import axios from 'axios';
import { local } from '../utils/storage.js';

export const TOKEN_KEY = 'maridata_token';

export const getApiBaseUrl = () => {
  const raw = (import.meta.env.VITE_API_URL || 'http://localhost:5000').trim();
  const normalized = raw.replace(/\/+$/, '');
  return normalized.endsWith('/api') ? normalized : `${normalized}/api`;
};

const api = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

// The token is sent when it exists, but guests never need one.
api.interceptors.request.use((config) => {
  const token = local.get(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || '';
    if (error.response?.status === 401 && local.get(TOKEN_KEY) && !url.includes('/auth/login')) {
      local.remove(TOKEN_KEY);
      window.dispatchEvent(new Event('auth:expired'));
    }
    return Promise.reject(error);
  }
);

export default api;