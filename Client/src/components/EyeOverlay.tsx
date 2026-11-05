import { AlertState } from '../types';
import { DisplayState } from '../utils/display';

interface Props {
  alert: AlertState | null;
  state: DisplayState;
  /** Mirror horizontally to match a mirrored (selfie) video. */
  mirrored: boolean;
}

const STROKE: Partial<Record<DisplayState, string>> = {
  normal: '#3ccf7a',
  warning: '#f2a516',
  critical: '#f0453c',
};

/**
 * Draws the 12 EAR landmarks over the video: the eye outline (p1..p6), the two
 * vertical distances (p2-p6, p3-p5) and the horizontal one (p1-p4) that the
 * eye aspect ratio is computed from.
 *
 * The SVG uses the analysed frame's own size as its viewBox with
 * "xMidYMid slice", which crops exactly like the video's object-cover, so
 * the points line up whatever the panel's shape.
 */
export function EyeOverlay({ alert, state, mirrored }: Props) {
  if (!alert?.eyes || !alert.frameSize || alert.lastFrameAge == null || alert.lastFrameAge > 1.5) return null;
  const [fw, fh] = alert.frameSize;
  const u = fw / 640; // stroke unit, so marks look the same at any resolution
  const colour = STROKE[state] ?? '#3ccf7a';

  return (
    <svg
      viewBox={`0 0 ${fw} ${fh}`}
      preserveAspectRatio="xMidYMid slice"
      className={`pointer-events-none absolute inset-0 h-full w-full ${mirrored ? '-scale-x-100' : ''}`}
      aria-hidden
    >
      {(Object.entries(alert.eyes) as [string, [number, number][]][]).map(([side, pts]) => {
        const p = pts.map(([x, y]) => [x * fw, y * fh] as const);
        const line = (a: number, b: number, stroke: string) => (
          <line
            x1={p[a][0]}
            y1={p[a][1]}
            x2={p[b][0]}
            y2={p[b][1]}
            stroke={stroke}
            strokeWidth={1.2 * u}
            strokeLinecap="round"
          />
        );
        return (
          <g key={side} className="transition-opacity duration-200">
            <polygon
              points={p.map(([x, y]) => `${x},${y}`).join(' ')}
              fill={colour}
              fillOpacity={0.12}
              stroke={colour}
              strokeWidth={1.4 * u}
              strokeLinejoin="round"
            />
            {line(1, 5, '#ffd23f')}
            {line(2, 4, '#ffd23f')}
            {line(0, 3, '#4fc3ff')}
            {p.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={2.6 * u} fill="#fff" stroke={colour} strokeWidth={1.2 * u} />
            ))}
          </g>
        );
      })}
    </svg>
  );
}
