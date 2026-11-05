import { useEffect, useRef, useState } from 'react';
import { Camera, Cpu, ScanEye, Play, Square } from 'lucide-react';
import { api } from '../services/api';
import { AlertState, DeviceInfo } from '../types';
import { DisplayState, tone } from '../utils/display';
import { EyeOverlay } from './EyeOverlay';

export type Source = 'browser' | 'esp32';

interface Props {
  source: Source;
  onSourceChange: (s: Source) => void;
  running: boolean;
  onRunningChange: (r: boolean) => void;
  state: DisplayState;
  devices: DeviceInfo[];
  alert: AlertState | null;
  landmarks: boolean;
  onLandmarksChange: (on: boolean) => void;
}

const FRAME_EVERY_MS = 500;

export function CameraPanel({
  source,
  onSourceChange,
  running,
  onRunningChange,
  state,
  devices,
  alert,
  landmarks,
  onLandmarksChange,
}: Props) {
  const hardware = devices.filter((d) => d.id !== 'browser');
  const espOnline = hardware.some((d) => d.online);
  // The alert data is already scoped to whichever camera is selected (the
  // browser's own isolated session, or the shared ESP32-CAM state), so this
  // just checks a frame has actually come in yet.
  const pointsMatch = !!alert?.source;

  return (
    <section className="panel overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div role="tablist" aria-label="Camera source" className="flex rounded-md bg-paper p-0.5">
          {(
            [
              ['browser', 'This browser', Camera],
              ['esp32', 'ESP32-CAM', Cpu],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={source === id}
              onClick={() => onSourceChange(id)}
              className={`flex items-center gap-1.5 rounded px-3 py-1 text-sm transition-colors ${
                source === id ? 'bg-panel font-medium text-ink shadow-panel' : 'text-ink-soft hover:text-ink'
              }`}
            >
              <Icon size={14} />
              {label}
              {id === 'esp32' && (
                <span className={`ml-0.5 h-1.5 w-1.5 rounded-full ${espOnline ? 'bg-ok' : 'bg-line'}`} />
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => onLandmarksChange(!landmarks)}
            aria-pressed={landmarks}
            className={`btn ${landmarks ? 'bg-paper text-ink' : 'text-ink-faint hover:text-ink'}`}
            title="Show the eye landmarks (L)"
          >
            <ScanEye size={15} />
            <span className="hidden sm:inline">Landmarks</span>
          </button>
          {source === 'browser' && (
            <button
              onClick={() => onRunningChange(!running)}
              className={running ? 'btn-outline' : 'btn-primary'}
              title="Space"
            >
              {running ? <Square size={14} /> : <Play size={14} />}
              {running ? 'Stop' : 'Start'}
            </button>
          )}
        </div>
      </header>

      <div className={`relative aspect-video bg-ink border-4 transition-colors duration-300 ${tone[state].border}`}>
        {source === 'browser' ? (
          <BrowserCamera running={running} />
        ) : (
          <Esp32View online={espOnline} device={hardware.find((d) => d.online)?.id} />
        )}
        {landmarks && pointsMatch && (source === 'esp32' || running) && (
          <EyeOverlay alert={alert} state={state} mirrored={source === 'browser'} />
        )}
        {landmarks && pointsMatch && alert?.eyes && (source === 'esp32' || running) && (
          <div className="pointer-events-none absolute bottom-3 right-3 flex gap-3 rounded bg-black/60 px-2 py-1 text-[11px] text-white">
            <span className="flex items-center gap-1">
              <span className="h-0.5 w-3 bg-[#ffd23f]" /> vertical
            </span>
            <span className="flex items-center gap-1">
              <span className="h-0.5 w-3 bg-[#4fc3ff]" /> horizontal
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function BrowserCamera({ running }: { running: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);

  // Ask for the webcam only while running, and release it on stop.
  useEffect(() => {
    if (!running) return;
    const el = video.current;
    let stream: MediaStream | null = null;
    let cancelled = false;
    setError(null);
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: 640, height: 480 }, audio: false })
      .then(async (s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (el) {
          el.srcObject = s;
          await el.play().catch(() => {});
        }
      })
      .catch((e: Error) => setError(e.name === 'NotAllowedError' ? 'Camera permission was refused.' : e.message));
    if (!navigator.mediaDevices) setError('This browser has no camera access (it needs HTTPS).');
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      if (el) el.srcObject = null;
    };
  }, [running]);

  // Send a frame every 500 ms, never more than one in flight.
  useEffect(() => {
    if (!running) return;
    let busy = false;
    let sent = 0;
    const started = performance.now();
    const id = setInterval(() => {
      const v = video.current;
      const c = canvas.current;
      if (busy || !v || !c || v.readyState < 2) return;
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d')?.drawImage(v, 0, 0);
      busy = true;
      c.toBlob(
        (blob) => {
          if (!blob) return void (busy = false);
          api
            .detect(blob)
            .catch(() => {})
            .finally(() => {
              busy = false;
              sent++;
              setFps(sent / ((performance.now() - started) / 1000));
            });
        },
        'image/jpeg',
        0.8,
      );
    }, FRAME_EVERY_MS);
    return () => {
      clearInterval(id);
      setFps(0);
    };
  }, [running]);

  return (
    <>
      <canvas ref={canvas} className="hidden" />
      <video
        ref={video}
        muted
        playsInline
        className={`h-full w-full -scale-x-100 object-cover transition-opacity duration-500 ${running && !error ? 'opacity-100' : 'opacity-0'}`}
      />
      {running && !error && (
        <span className="absolute bottom-3 left-3 rounded bg-black/60 px-2 py-0.5 font-mono text-[11px] text-white tabular">
          {fps.toFixed(1)} frames/s sent
        </span>
      )}
      {!running && (
        <Overlay
          title="Camera off"
          body="Press Start (or Space) to use this computer's webcam as the camera."
        />
      )}
      {error && <Overlay title="No camera" body={error} />}
    </>
  );
}

function Esp32View({ online, device }: { online: boolean; device?: string }) {
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!online) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [online]);

  if (!online) {
    return (
      <Overlay
        title="ESP32-CAM not connected"
        body="Power the camera board and wait for its red LED to stay on. It appears here within a few seconds."
      />
    );
  }
  return (
    <>
      <img
        src={api.latestFrameUrl(tick, device)}
        alt="Latest frame from the ESP32-CAM"
        onLoad={() => setLoaded(true)}
        className="h-full w-full object-cover"
      />
      {!loaded && <Overlay title="Waiting for a frame" body="" />}
      <span className="absolute bottom-3 left-3 rounded bg-black/60 px-2 py-0.5 font-mono text-[11px] text-white">
        {device}
      </span>
    </>
  );
}

function Overlay({ title, body }: { title: string; body: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
      <p className="font-medium text-paper">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-paper/60">{body}</p>}
    </div>
  );
}
