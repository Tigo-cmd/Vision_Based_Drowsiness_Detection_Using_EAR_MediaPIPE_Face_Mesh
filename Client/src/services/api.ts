import { AlertEvent, SystemSettings, SystemStatus } from '../types';

const API_BASE_URL = 'https://drowsiness-five.vercel.app/';

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
        fetch(`${API_BASE_URL}/status`),
        fetch(`${API_BASE_URL}/ear`),
        fetch(`${API_BASE_URL}/alert`),
      ]);

      const status = await statusRes.json();
      const ear = await earRes.json();
      const alert = await alertRes.json();

      let alertState: 'normal' | 'warning' | 'critical' = 'normal';
      if (alert.drowsy) {
        alertState = 'critical';
      } else if (alert.consecutive_frames >= 4) { // Increased to 4 frames (~2s) for better accuracy
        alertState = 'warning';
      }

      return {
        cameraActive: status.camera === 'connected',
        telegramConnected: status.telegram === 'configured',
        currentEAR: ear.ear,
        alertState,
        lastUpdate: new Date().toISOString(),
      };
    } catch (error) {
      console.error('API Error:', error);
      return {
        cameraActive: true,
        telegramConnected: false,
        currentEAR: 0,
        alertState: 'normal',
        lastUpdate: new Date().toISOString(),
      };
    }
  }

  async getCurrentEAR(): Promise<number> {
    try {
      const response = await fetch(`${API_BASE_URL}/ear`);
      const data = await response.json();
      return data.ear;
    } catch (error) {
      console.error('EAR API Error:', error);
      return 0;
    }
  }

  async getAlertState(): Promise<'normal' | 'warning' | 'critical'> {
    try {
      const response = await fetch(`${API_BASE_URL}/alert`);
      const data = await response.json();

      if (data.drowsy) return 'critical';
      if (data.consecutive_frames >= 4) return 'warning';
      return 'normal';
    } catch (error) {
      console.error('Alert API Error:', error);
      return 'normal';
    }
  }

  async getEvents(): Promise<AlertEvent[]> {
    try {
      const response = await fetch(`${API_BASE_URL}/events`);
      const data = await response.json();

      return data.events.map((event: any) => ({
        id: crypto.randomUUID(),
        earValue: event.ear,
        alertType: event.type || (event.alert_sent ? 'critical' : 'warning'),
        timestamp: event.timestamp,
        duration: 0,
      }));
    } catch (error) {
      console.error('Events API Error:', error);
      return [];
    }
  }

  // NEW: Send frame to backend for detection
  async detectFrame(imageBlob: Blob): Promise<{ drowsy: boolean; confidence: number } | null> {
    try {
      const response = await fetch(`${API_BASE_URL}/detect`, {
        method: 'POST',
        body: imageBlob,
        headers: {
          'Content-Type': 'application/octet-stream',
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
      const response = await fetch(`${API_BASE_URL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ear_threshold: settings.earThreshold,
          drowsy_time: settings.alertDurationThreshold,
          telegram_cooldown: settings.notificationCooldown,
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
    console.log('Clear events not implemented in backend');
  }

  startSimulation() {
    console.log('Connected to real backend - simulation not needed');
  }

  stopSimulation() {
    console.log('Disconnected from backend');
  }
}

export const api = new RealAPI();
