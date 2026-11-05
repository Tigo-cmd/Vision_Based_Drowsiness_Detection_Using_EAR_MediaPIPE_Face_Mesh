import { AlertState } from '../types';
import { DisplayState, tone } from '../utils/display';

interface Props {
  state: DisplayState;
  alert: AlertState | null;
}

const COPY: Record<DisplayState, { title: string; sub: (a: AlertState | null) => string }> = {
  normal: { title: 'Awake', sub: () => 'Eyes open. Watching for long closures.' },
  warning: {
    title: 'Eyes closing',
    sub: (a) => (a ? `Alarm in ${Math.max(0, a.drowsyTime - a.closedFor).toFixed(1)} s unless the eyes open` : ''),
  },
  critical: { title: 'Drowsy', sub: () => 'Alarm sounding. Supervisor alerted on Telegram.' },
  noface: { title: 'No face', sub: () => 'Camera is running but can’t see a face. Check the angle and light.' },
  idle: { title: 'Not watching', sub: () => 'No camera has sent a frame in the last 5 seconds.' },
  offline: { title: 'Server unreachable', sub: () => 'Retrying. Check the backend is deployed and awake.' },
  loading: { title: 'Connecting', sub: () => 'Reaching the detection server…' },
};

const R = 52;
const C = 2 * Math.PI * R;

export function StatePanel({ state, alert }: Props) {
  const t = tone[state];
  const watching = state === 'normal' || state === 'warning' || state === 'critical';
  const frac = watching && alert ? Math.min(1, alert.closedFor / Math.max(0.1, alert.drowsyTime)) : 0;
  const copy = COPY[state];

  return (
    <section
      aria-live="polite"
      className={`panel relative overflow-hidden transition-colors duration-300 ${t.bg}`}
    >
      {state === 'critical' && <div className="absolute inset-x-0 top-0 h-1 bg-crit animate-flash" />}
      <div className="flex items-center gap-6 p-6">
        <div className="relative h-32 w-32 shrink-0">
          <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
            <circle cx="60" cy="60" r={R} fill="none" strokeWidth="8" className="stroke-black/[0.07]" />
            <circle
              cx="60"
              cy="60"
              r={R}
              fill="none"
              strokeWidth="8"
              strokeLinecap={frac > 0 ? 'round' : 'butt'}
              className={`${state === 'critical' ? 'stroke-crit' : 'stroke-warn'} transition-[stroke-dashoffset] duration-300 ease-out`}
              strokeDasharray={C}
              strokeDashoffset={C * (1 - frac)}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {watching && alert ? (
              <>
                <span className="font-mono text-2xl font-medium tabular">{alert.closedFor.toFixed(1)}</span>
                <span className="text-[11px] text-ink-faint">of {alert.drowsyTime.toFixed(1)} s closed</span>
              </>
            ) : (
              <span className={`h-3 w-3 rounded-full ${t.dot}`} />
            )}
          </div>
        </div>

        <div className="min-w-0">
          <p className="label">Driver</p>
          <h2 key={state} className={`mt-1 text-4xl font-semibold tracking-tight animate-rise ${t.text}`}>
            {copy.title}
          </h2>
          <p className="mt-2 text-sm text-ink-soft">{copy.sub(alert)}</p>
        </div>
      </div>

      <dl className="grid grid-cols-3 border-t border-black/[0.06] text-sm">
        <div className="px-6 py-3">
          <dt className="label">EAR</dt>
          <dd className="mt-0.5 font-mono text-lg tabular">{alert && alert.face ? alert.ear.toFixed(3) : '–'}</dd>
        </div>
        <div className="border-x border-black/[0.06] px-6 py-3">
          <dt className="label">Threshold</dt>
          <dd className="mt-0.5 font-mono text-lg tabular">{alert ? alert.threshold.toFixed(2) : '–'}</dd>
        </div>
        <div className="px-6 py-3">
          <dt className="label">Source</dt>
          <dd className="mt-0.5 truncate text-lg">{alert?.source ?? '–'}</dd>
        </div>
      </dl>
    </section>
  );
}
