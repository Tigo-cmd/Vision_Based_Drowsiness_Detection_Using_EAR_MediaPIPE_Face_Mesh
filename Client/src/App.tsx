import { useCallback, useEffect, useState } from 'react';
import { Settings as Gear, Volume2, VolumeX } from 'lucide-react';
import { CameraPanel, Source } from './components/CameraPanel';
import { EarChart } from './components/EarChart';
import { EventLog } from './components/EventLog';
import { HealthList } from './components/HealthList';
import { SettingsDrawer } from './components/SettingsDrawer';
import { StatePanel } from './components/StatePanel';
import { ToastMsg, Toasts } from './components/Toast';
import { useAlarm } from './hooks/useAlarm';
import { useMonitor } from './hooks/useMonitor';
import { api } from './services/api';
import { Settings } from './types';
import { displayState, tone } from './utils/display';

const TITLES = {
  normal: 'Awake',
  warning: 'Eyes closing',
  critical: 'DROWSY',
  noface: 'No face',
  idle: 'Not watching',
  offline: 'Offline',
  loading: 'Connecting',
} as const;

function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: ignore */
  }
}

export default function App() {
  const { alert, status, events, online, latencyMs, history, stale, refreshSlow, setEvents } = useMonitor();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [source, setSource] = useState<Source>(() => readPref('source', 'browser'));
  const [running, setRunning] = useState(false);
  const [soundOn, setSoundOn] = useState<boolean>(() => readPref('sound', true));
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [pendingThreshold, setPendingThreshold] = useState<number | null>(null);

  const state = displayState(alert, online, stale);
  useAlarm(alert && !stale ? alert.level : null, soundOn);

  const toast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
  }, [online]);

  useEffect(() => writePref('source', source), [source]);
  useEffect(() => writePref('sound', soundOn), [soundOn]);
  useEffect(() => {
    document.title = `${TITLES[state]} · Drowsiness Monitor`;
  }, [state]);

  // Stop the webcam when switching to the ESP32 view.
  useEffect(() => {
    if (source === 'esp32') setRunning(false);
  }, [source]);

  const saveSettings = useCallback(
    async (next: Settings) => {
      try {
        await api.saveSettings(next);
        setSettings(next);
        toast('Settings saved');
      } catch {
        toast('Could not save settings', 'err');
      }
    },
    [toast],
  );

  const setThreshold = useCallback(
    async (v: number) => {
      setPendingThreshold(v);
      setSettings((s) => (s ? { ...s, earThreshold: v } : s));
      try {
        await api.saveSettings({ earThreshold: v });
        toast(`Threshold set to ${v.toFixed(3)}`);
      } catch {
        toast('Could not save the threshold', 'err');
        setPendingThreshold(null);
      }
    },
    [toast],
  );

  // Clear the optimistic value once the server reports it.
  useEffect(() => {
    if (pendingThreshold != null && alert && Math.abs(alert.threshold - pendingThreshold) < 0.0005) {
      setPendingThreshold(null);
    }
  }, [alert, pendingThreshold]);

  const openSettings = useCallback(() => {
    api.settings().then(setSettings).catch(() => {});
    setDrawer(true);
  }, []);

  // Keyboard: Space start/stop, M sound, comma settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, [role="slider"], [role="dialog"]') || e.metaKey || e.ctrlKey) return;
      if (e.code === 'Space' && source === 'browser' && el.tagName !== 'BUTTON') {
        e.preventDefault();
        setRunning((r) => !r);
      } else if (e.key === 'm' || e.key === 'M') {
        setSoundOn((s) => !s);
      } else if (e.key === ',') {
        openSettings();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [source, openSettings]);

  const threshold = pendingThreshold ?? alert?.threshold ?? settings?.earThreshold ?? 0.2;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1360px] items-center gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
              <rect width="32" height="32" rx="7" className="fill-ink" />
              <path d="M5 16c3-5 7-7.5 11-7.5S24 11 27 16c-3 5-7 7.5-11 7.5S8 21 5 16z" fill="none" stroke="#f6f5f1" strokeWidth="2" />
              <path
                d="M11 16.5h10"
                stroke="#f6f5f1"
                strokeWidth="2.4"
                strokeLinecap="round"
                className={state === 'normal' ? 'opacity-0' : ''}
              />
              {state === 'normal' && <circle cx="16" cy="16" r="3.2" fill="#f6f5f1" />}
            </svg>
            <div className="leading-tight">
              <p className="font-semibold">Drowsiness Monitor</p>
              <p className="text-xs text-ink-faint">Eye aspect ratio, live</p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <span className="hidden items-center gap-2 rounded-full border border-line px-3 py-1 text-xs sm:flex">
              <span className={`h-1.5 w-1.5 rounded-full ${tone[state].dot} ${state === 'critical' ? 'animate-flash' : ''}`} />
              {online === false ? 'Server offline' : stale ? 'No camera' : 'Live'}
            </span>
            <button
              className="btn-ghost px-2"
              onClick={() => setSoundOn((s) => !s)}
              aria-label={soundOn ? 'Mute alarm sound (M)' : 'Turn alarm sound on (M)'}
              title={soundOn ? 'Mute alarm sound (M)' : 'Turn alarm sound on (M)'}
            >
              {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            <button className="btn-ghost px-2" onClick={openSettings} aria-label="Settings (,)" title="Settings (,)">
              <Gear size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1360px] gap-4 px-4 py-5 sm:px-6 lg:grid-cols-12 lg:gap-5">
        <div className="min-w-0 lg:col-span-7">
          <CameraPanel
            source={source}
            onSourceChange={setSource}
            running={running}
            onRunningChange={setRunning}
            state={state}
            devices={status?.devices ?? []}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-5 lg:gap-5">
          <StatePanel state={state} alert={alert} />
          <HealthList
            status={status}
            online={online}
            latencyMs={latencyMs}
            lastFrameAge={alert?.lastFrameAge ?? null}
            onToast={toast}
          />
        </div>
        <div className="min-w-0 lg:col-span-12">
          <EarChart history={history} threshold={threshold} onThresholdChange={setThreshold} />
        </div>
        <div className="min-w-0 lg:col-span-12">
          <EventLog
            events={events}
            onClear={async () => {
              await api.clearEvents().catch(() => toast('Could not clear events', 'err'));
              setEvents([]);
              refreshSlow();
            }}
          />
        </div>
      </main>

      <footer className="mx-auto max-w-[1360px] px-4 pb-8 text-xs text-ink-faint sm:px-6">
        <span className="kbd">Space</span> start/stop camera &nbsp; <span className="kbd">M</span> alarm sound &nbsp;{' '}
        <span className="kbd">,</span> settings
      </footer>

      <SettingsDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        settings={settings}
        onSave={saveSettings}
        soundOn={soundOn}
        onSoundChange={setSoundOn}
      />
      <Toasts items={toasts} />
    </div>
  );
}
