export interface AlertEvent {
  id: string;
  earValue: number;
  alertType: 'normal' | 'warning' | 'critical';
  timestamp: string;
  duration: number;
}

export interface SystemSettings {
  earThreshold: number;
  alertDurationThreshold: number;
  telegramEnabled: boolean;
  notificationCooldown: number;
}

export interface DeviceInfo {
  id: string;
  lastSeenSec: number;
  frames: number;
  online: boolean;
}

export type TelegramState = 'configured' | 'not_configured' | 'disabled' | 'error';

export interface SystemStatus {
  cameraActive: boolean;
  telegramConnected: boolean;
  telegramState: TelegramState;
  telegramError: string | null;
  devices: DeviceInfo[];
  closedFor: number;
  currentEAR: number;
  alertState: 'normal' | 'warning' | 'critical';
  lastUpdate: string;
}
