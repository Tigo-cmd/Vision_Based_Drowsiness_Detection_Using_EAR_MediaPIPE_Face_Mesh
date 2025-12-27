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

export interface SystemStatus {
  cameraActive: boolean;
  telegramConnected: boolean;
  currentEAR: number;
  alertState: 'normal' | 'warning' | 'critical';
  lastUpdate: string;
}
