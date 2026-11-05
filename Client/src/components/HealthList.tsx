import { useState } from 'react';
import { api } from '../services/api';
import { ServerStatus } from '../types';
import { fmtAgo, fmtUptime } from '../utils/display';

interface Props {
  status: ServerStatus | null;
  online: boolean | null;
  latencyMs: number | null;
  lastFrameAge: number | null;
  onToast: (msg: string, kind?: 'ok' | 'err') => void;
}

const TELEGRAM_TEXT = {
  configured: 'Ready',
  not_configured: 'Token not set on the server',
  disabled: 'Turned off in settings',
  error: 'Last send failed',
} as const;

function Row({ ok, label, value, children }: { ok: boolean | null; label: string; value: string; children?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${ok === null ? 'bg-line' : ok ? 'bg-ok' : 'bg-crit'}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="truncate text-sm text-ink-soft">{value}</p>
      </div>
      {children}
    </li>
  );
}

export function HealthList({ status, online, latencyMs, lastFrameAge, onToast }: Props) {
  const [testing, setTesting] = useState(false);
  const cams = status?.devices ?? [];
  const live = cams.filter((d) => d.online);

  const test = async () => {
    setTesting(true);
    const res = await api.telegramTest();
    setTesting(false);
    onToast(res.ok ? 'Test message sent to Telegram' : `Telegram: ${res.error ?? 'failed'}`, res.ok ? 'ok' : 'err');
  };

  return (
    <section className="panel">
      <h2 className="px-5 pt-4 pb-2 font-semibold">System</h2>
      <ul className="divide-y divide-line border-t border-line">
        <Row
          ok={online}
          label="Server"
          value={
            online === false
              ? 'Unreachable'
              : status
                ? `Up ${fmtUptime(status.uptime)} · ${latencyMs ?? '–'} ms`
                : 'Connecting…'
          }
        />
        <Row
          ok={status ? live.length > 0 : null}
          label="Cameras"
          value={
            live.length
              ? live.map((d) => d.id).join(', ') +
                (lastFrameAge != null ? ` · last frame ${lastFrameAge.toFixed(1)} s ago` : '')
              : cams.length
                ? `None sending. Last: ${cams.map((d) => `${d.id} ${Math.round(d.lastSeenSec)} s ago`).join(', ')}`
                : 'None has connected yet'
          }
        />
        <Row
          ok={status ? status.telegram === 'configured' : null}
          label="Telegram"
          value={
            status
              ? status.telegram === 'error' && status.telegramError
                ? status.telegramError
                : status.telegramLastSentAt
                  ? `${TELEGRAM_TEXT[status.telegram]} · last sent ${fmtAgo(status.telegramLastSentAt)}`
                  : TELEGRAM_TEXT[status.telegram] ?? status.telegram
              : '–'
          }
        >
          <button className="btn-outline" onClick={test} disabled={testing || status?.telegram === 'not_configured'}>
            {testing ? 'Sending…' : 'Send test'}
          </button>
        </Row>
      </ul>
    </section>
  );
}
