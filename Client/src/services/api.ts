import { AlertEvent, AlertState, ServerStatus, Settings } from '../types';

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ??
  'https://vision-based-drowsiness-detection-using-ear-mediapipe-face-mesh.fly.dev'
).replace(/\/$/, '');

/**
 * This browser's own id, so its EAR/alert/events never mix with another
 * visitor's or with the shared ESP32-CAM state. The server only isolates
 * ids shaped like this ("browser-..."); anything else (an ESP32, or an old
 * cached frontend sending the literal "browser") shares one state, same as
 * always.
 */
export const CLIENT_ID = (() => {
  const KEY = 'client_id';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = `browser-${crypto.randomUUID()}`;
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return `browser-${crypto.randomUUID()}`; // private mode: not persisted, but still isolated
  }
})();

function withDevice(path: string, device?: string): string {
  if (!device) return path;
  const q = new URLSearchParams({ device });
  return `${path}${path.includes('?') ? '&' : '?'}${q}`;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, { ...init, signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body?.error ?? `HTTP ${res.status}`) as Error & { body?: unknown };
      err.body = body;
      throw err;
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const api = {
  /** @param device Pass CLIENT_ID to read this browser's own isolated state; omit for the shared/hardware state. */
  async alert(device?: string): Promise<AlertState> {
    const a = await request<any>(withDevice('/alert', device));
    return {
      level: a.level ?? (a.drowsy ? 'critical' : 'normal'),
      drowsy: !!a.drowsy,
      closedFor: a.closed_for ?? 0,
      drowsyTime: a.drowsy_time ?? 3,
      face: !!a.face,
      ear: a.ear ?? 0,
      threshold: a.threshold ?? 0.2,
      frame: a.frame ?? 0,
      source: a.source ?? null,
      lastFrameAge: a.last_frame_age ?? null,
      eyes: a.eyes ?? null,
      frameSize: a.frame_size ?? null,
    };
  },

  async status(device?: string): Promise<ServerStatus> {
    const s = await request<any>(withDevice('/status', device));
    return {
      uptime: s.uptime ?? 0,
      cameraConnected: s.camera === 'connected',
      telegram: s.telegram,
      telegramError: s.telegram_last_error ?? null,
      telegramLastSentAt: s.telegram_last_sent_at ?? null,
      devices: (s.devices ?? []).map((d: any) => ({
        id: d.id,
        lastSeenSec: d.last_seen_sec,
        frames: d.frames,
        online: d.online,
      })),
    };
  },

  async events(device?: string): Promise<AlertEvent[]> {
    const data = await request<any>(withDevice('/events', device));
    return (data.events ?? []).map((e: any) => ({
      id: `${e.timestamp}-${e.source ?? ''}`,
      timestamp: e.timestamp,
      ear: e.ear,
      duration: e.duration ?? 0,
      source: e.source ?? 'unknown',
      alertSent: !!e.alert_sent,
    }));
  },

  clearEvents(device?: string): Promise<unknown> {
    return request(withDevice('/events', device), { method: 'DELETE' });
  },

  async settings(): Promise<Settings> {
    const s = await request<any>('/settings');
    return {
      earThreshold: s.ear_threshold,
      drowsyTime: s.drowsy_time,
      telegramCooldown: s.telegram_cooldown,
      telegramEnabled: s.telegram_enabled,
    };
  },

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    await request('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ear_threshold: patch.earThreshold,
        drowsy_time: patch.drowsyTime,
        telegram_cooldown: patch.telegramCooldown,
        telegram_enabled: patch.telegramEnabled,
      }),
    });
  },

  /** Sends one webcam frame for analysis. */
  detect(jpeg: Blob): Promise<unknown> {
    return request('/detect', {
      method: 'POST',
      body: jpeg,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Device-Id': CLIENT_ID },
    });
  },

  async telegramTest(device?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request(withDevice('/telegram/test', device), { method: 'POST' }, 30000);
    } catch (e) {
      const body = (e as { body?: { error?: string } }).body;
      return { ok: false, error: body?.error ?? (e as Error).message };
    }
  },

  /** URL of the latest ESP32-CAM frame; `bust` defeats caching. */
  latestFrameUrl(bust: number, device?: string): string {
    const q = new URLSearchParams({ t: String(bust) });
    if (device) q.set('device', device);
    return `${API_BASE_URL}/frame/latest?${q}`;
  },
};
