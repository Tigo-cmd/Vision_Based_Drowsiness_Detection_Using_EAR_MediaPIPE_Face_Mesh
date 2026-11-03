import { AlertEvent, DeviceInfo, SystemSettings, SystemStatus } from '../types';

const API_BASE_URL = 'https://vision-based-drowsiness-detection-using-ear-mediapipe-face-mesh.fly.dev/'
const STORAGE_KEYS = {
  SETTINGS: 'system_settings',
};

const DEFAULT_SETTINGS: SystemSettings = {
  earThreshold: 0.20,
  alertDurationThreshold: 3,
  telegramEnabled: true,
  notificationCooldown: 60,
};

class RealAPI {
  async getStatus(): Promise<SystemStatus> {
    try {
      const [statusRes, earRes, alertRes] = await Promise.all([
        fetch(`${API_BASE_URL}status`),
        fetch(`${API_BASE_URL}ear`),
        fetch(`${API_BASE_URL}alert`),
      ]);

      const status = await statusRes.json();
      const ear = await earRes.json();
      const alert = await alertRes.json();

      // The backend decides the level from how long the eyes have been closed.
      const alertState: 'normal' | 'warning' | 'critical' =
        alert.level ?? (alert.drowsy ? 'critical' : 'normal');

      const devices: DeviceInfo[] = (status.devices ?? []).map((d: any) => ({
        id: d.id,
        lastSeenSec: d.last_seen_sec,
        frames: d.frames,
        online: d.online,
      }));

      return {
        cameraActive: status.camera === 'connected',
        telegramConnected: status.telegram === 'configured',
        telegramState: status.telegram,
        telegramError: status.telegram_last_error ?? null,
        devices,
        closedFor: alert.closed_for ?? 0,
        currentEAR: ear.ear,
        alertState,
        lastUpdate: new Date().toISOString(),
      };
    } catch (error) {
      console.error('API Error:', error);
      return {
        cameraActive: false,
        telegramConnected: false,
        telegramState: 'error',
        telegramError: 'Backend unreachable',
        devices: [],
        closedFor: 0,
        currentEAR: 0,
        alertState: 'normal',
        lastUpdate: new Date().toISOString(),
      };
    }
  }

  async getCurrentEAR(): Promise<number> {
    try {
      const response = await fetch(`${API_BASE_URL}ear`);
      const data = await response.json();
      return data.ear;
    } catch (error) {
      console.error('EAR API Error:', error);
      return 0;
    }
  }

  async getAlertState(): Promise<'normal' | 'warning' | 'critical'> {
    try {
      const response = await fetch(`${API_BASE_URL}alert`);
      const data = await response.json();

      return data.level ?? (data.drowsy ? 'critical' : 'normal');
    } catch (error) {
      console.error('Alert API Error:', error);
      return 'normal';
    }
  }

  async getEvents(): Promise<AlertEvent[]> {
    try {
      const response = await fetch(`${API_BASE_URL}events`);
      const data = await response.json();

      return data.events.map((event: any) => ({
        // Stable key so the list doesn't remount every poll
        id: `${event.timestamp}-${event.source ?? ''}`,
        earValue: event.ear,
        alertType: event.type || (event.alert_sent ? 'critical' : 'warning'),
        timestamp: event.timestamp,
        duration: event.duration ?? 0,
      }));
    } catch (error) {
      console.error('Events API Error:', error);
      return [];
    }
  }

  // NEW: Send frame to backend for detection
  async detectFrame(imageBlob: Blob): Promise<{ drowsy: boolean; confidence: number } | null> {
    try {
      const response = await fetch(`${API_BASE_URL}detect`, {
        method: 'POST',
        body: imageBlob,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Device-Id': 'browser',
        },
      });

      if (!response.ok) {
        throw new Error(`Detection failed: ${response.status}`);
      }

      const data = await response.json();
      return {
        drowsy: data.drowsy,
        confidence: data.confidence,
      };
    } catch (error) {
      console.error('Detection API Error:', error);
      return null;
    }
  }

  getSettings(): SystemSettings {
    const stored = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!stored) {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(DEFAULT_SETTINGS));
      return DEFAULT_SETTINGS;
    }
    return JSON.parse(stored);
  }

  async updateSettings(settings: Partial<SystemSettings>): Promise<SystemSettings> {
    try {
      const response = await fetch(`${API_BASE_URL}settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ear_threshold: settings.earThreshold,
          drowsy_time: settings.alertDurationThreshold,
          telegram_cooldown: settings.notificationCooldown,
          telegram_enabled: settings.telegramEnabled,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update settings');
      }

      const current = this.getSettings();
      const updated = { ...current, ...settings };
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(updated));
      return updated;
    } catch (error) {
      console.error('Settings update error:', error);
      const current = this.getSettings();
      const updated = { ...current, ...settings };
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(updated));
      return updated;
    }
  }

  async clearEvents(): Promise<void> {
    try {
      await fetch(`${API_BASE_URL}events`, { method: 'DELETE' });
    } catch (error) {
      console.error('Clear events error:', error);
    }
  }

  async sendTelegramTest(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch(`${API_BASE_URL}telegram/test`, { method: 'POST' });
      return await response.json();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  startSimulation() {
    console.log('Connected to real backend - simulation not needed');
  }

  stopSimulation() {
    console.log('Disconnected from backend');
  }
}

export const api = new RealAPI();
