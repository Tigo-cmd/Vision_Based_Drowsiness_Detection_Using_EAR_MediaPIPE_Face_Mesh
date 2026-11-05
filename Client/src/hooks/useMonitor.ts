import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { AlertEvent, AlertState, Sample, ServerStatus } from '../types';

const ALERT_EVERY_MS = 300;
const SLOW_EVERY_MS = 2000;
const HISTORY_MS = 90_000;

/**
 * Polls the server: the live alert state often, status and events less often.
 * Each poll waits for the previous one, so a slow server never gets a pile-up.
 */
export function useMonitor() {
  const [alert, setAlert] = useState<AlertState | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const lastFrame = useRef<number>(-1);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      const t0 = performance.now();
      try {
        const a = await api.alert();
        if (stopped) return;
        setAlert(a);
        setOnline(true);
        setLatencyMs(Math.round(performance.now() - t0));
        if (a.frame !== lastFrame.current) {
          lastFrame.current = a.frame;
          const now = Date.now();
          setHistory((h) => {
            const next = h.filter((s) => now - s.t < HISTORY_MS);
            next.push({ t: now, ear: a.face ? a.ear : null, level: a.level });
            return next;
          });
        }
      } catch {
        if (!stopped) setOnline(false);
      }
      if (!stopped) timer = setTimeout(tick, ALERT_EVERY_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const refreshSlow = useCallback(async () => {
    const [s, e] = await Promise.allSettled([api.status(), api.events()]);
    if (s.status === 'fulfilled') setStatus(s.value);
    if (e.status === 'fulfilled') setEvents(e.value);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refreshSlow();
      if (!stopped) timer = setTimeout(tick, SLOW_EVERY_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refreshSlow]);

  // No frame for a few seconds means nothing is being watched right now.
  const stale = alert?.lastFrameAge == null || alert.lastFrameAge > 5;

  return { alert, status, events, online, latencyMs, history, stale, refreshSlow, setEvents };
}
