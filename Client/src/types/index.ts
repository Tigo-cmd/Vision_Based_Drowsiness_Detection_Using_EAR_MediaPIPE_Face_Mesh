export type Level = 'normal' | 'warning' | 'critical';

/** GET /alert: the live state, updated after every analysed frame. */
export interface AlertState {
  level: Level;
  drowsy: boolean;
  closedFor: number;
  drowsyTime: number;
  face: boolean;
  ear: number;
  threshold: number;
  frame: number;
  source: string | null;
  /** Seconds since the last frame from any camera; null if none yet. */
  lastFrameAge: number | null;
}

export interface DeviceInfo {
  id: string;
  lastSeenSec: number;
  frames: number;
  online: boolean;
}

export type TelegramState = 'configured' | 'not_configured' | 'disabled' | 'error';

/** GET /status */
export interface ServerStatus {
  uptime: number;
  cameraConnected: boolean;
  telegram: TelegramState;
  telegramError: string | null;
  telegramLastSentAt: string | null;
  devices: DeviceInfo[];
}

export interface AlertEvent {
  id: string;
  timestamp: string;
  ear: number;
  duration: number;
  source: string;
  alertSent: boolean;
}

export interface Settings {
  earThreshold: number;
  drowsyTime: number;
  telegramCooldown: number;
  telegramEnabled: boolean;
}

/** One point on the EAR chart. */
export interface Sample {
  t: number;
  ear: number | null; // null when no face
  level: Level;
}
