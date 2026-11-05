import { useEffect, useRef } from 'react';
import { Level } from '../types';

/**
 * Beeps in the browser to match the hardware buzzer:
 * slow single beeps for a warning, fast beeps when critical.
 * Browsers only allow sound after a click, so the AudioContext is created
 * lazily and resumed on the first user gesture.
 */
export function useAlarm(level: Level | null, enabled: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const unlock = () => {
      if (!ctxRef.current) ctxRef.current = new AudioContext();
      ctxRef.current.resume();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    const ctx = ctxRef.current;
    if (!enabled || !ctx || !level || level === 'normal') return;

    const beep = (freq: number, ms: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + ms / 1000 + 0.02);
    };

    const critical = level === 'critical';
    beep(critical ? 1760 : 880, critical ? 120 : 80);
    const id = setInterval(() => beep(critical ? 1760 : 880, critical ? 120 : 80), critical ? 220 : 650);
    return () => clearInterval(id);
  }, [level, enabled]);
}
