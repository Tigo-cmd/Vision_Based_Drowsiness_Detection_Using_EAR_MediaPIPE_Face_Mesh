import { AlertEvent, AlertState, ServerStatus, Settings } from '../types';

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ??
  'https://vision-based-drowsiness-detection-using-ear-mediapipe-face-mesh.fly.dev'
).replace(/\/$/, '');

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
  async alert(): Promise<AlertState> {
    const a = await request<any>('/alert');
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

  async status(): Promise<ServerStatus> {
    const s = await request<any>('/status');
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

  async events(): Promise<AlertEvent[]> {
    const data = await request<any>('/events');
    return (data.events ?? []).map((e: any) => ({
      id: `${e.timestamp}-${e.source ?? ''}`,
      timestamp: e.timestamp,
      ear: e.ear,
      duration: e.duration ?? 0,
      source: e.source ?? 'unknown',
      alertSent: !!e.alert_sent,
    }));
  },

  clearEvents(): Promise<unknown> {
    return request('/events', { method: 'DELETE' });
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
      headers: { 'Content-Type': 'application/octet-stream', 'X-Device-Id': 'browser' },
    });
  },

  async telegramTest(): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request('/telegram/test', { method: 'POST' }, 30000);
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
