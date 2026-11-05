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
  /** The 6 EAR landmarks per eye (p1..p6), normalised 0..1; null without a face. */
  eyes: EyePoints | null;
  /** Width and height of the analysed frame, in pixels. */
  frameSize: [number, number] | null;
}

export interface EyePoints {
  left: [number, number][];
  right: [number, number][];
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
