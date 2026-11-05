import { AlertState, Level } from '../types';

/** What the dashboard shows, combining driver state with whether anything is being watched. */
export type DisplayState = Level | 'noface' | 'idle' | 'offline' | 'loading';

export function displayState(alert: AlertState | null, online: boolean | null, stale: boolean): DisplayState {
  if (online === false) return 'offline';
  if (!alert || online === null) return 'loading';
  if (stale) return 'idle';
  if (alert.level !== 'normal') return alert.level;
  if (!alert.face) return 'noface';
  return 'normal';
}

/** Tailwind classes per state. Colour is reserved for driver state. */
export const tone: Record<DisplayState, { text: string; bg: string; ring: string; dot: string; border: string }> = {
  normal: { text: 'text-ok', bg: 'bg-ok-bg', ring: 'stroke-ok', dot: 'bg-ok', border: 'border-ok' },
  warning: { text: 'text-warn', bg: 'bg-warn-bg', ring: 'stroke-warn', dot: 'bg-warn', border: 'border-warn' },
  critical: { text: 'text-crit', bg: 'bg-crit-bg', ring: 'stroke-crit', dot: 'bg-crit', border: 'border-crit' },
  noface: { text: 'text-idle', bg: 'bg-idle-bg', ring: 'stroke-idle', dot: 'bg-idle', border: 'border-transparent' },
  idle: { text: 'text-idle', bg: 'bg-idle-bg', ring: 'stroke-idle', dot: 'bg-idle', border: 'border-transparent' },
  offline: { text: 'text-crit', bg: 'bg-idle-bg', ring: 'stroke-idle', dot: 'bg-crit', border: 'border-transparent' },
  loading: { text: 'text-idle', bg: 'bg-idle-bg', ring: 'stroke-idle', dot: 'bg-idle', border: 'border-transparent' },
};

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
