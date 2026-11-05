import { useState } from 'react';
import { AlertEvent } from '../types';
import { fmtAgo, fmtTime } from '../utils/display';

interface Props {
  events: AlertEvent[];
  onClear: () => Promise<void>;
}

export function EventLog({ events, onClear }: Props) {
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="panel flex min-h-0 flex-col">
      <header className="flex items-baseline justify-between px-5 pt-4 pb-3">
        <div>
          <h2 className="font-semibold">Drowsy events</h2>
          <p className="text-sm text-ink-soft">
            {events.length === 0
              ? 'None yet.'
              : `${events.length} logged, latest ${fmtAgo(events[0].timestamp)}.`}
          </p>
        </div>
        {events.length > 0 &&
          (confirming ? (
            <span className="flex items-center gap-1 text-sm">
              <span className="text-ink-soft">Clear all?</span>
              <button
                className="btn-ghost text-crit"
                onClick={async () => {
                  await onClear();
                  setConfirming(false);
                }}
              >
                Clear
              </button>
              <button className="btn-ghost" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button className="btn-ghost" onClick={() => setConfirming(true)}>
              Clear
            </button>
          ))}
      </header>

      {events.length === 0 ? (
        <p className="border-t border-line px-5 py-8 text-center text-sm text-ink-faint">
          When the eyes stay closed past the alert duration, the event shows up here with how long it lasted.
        </p>
      ) : (
        <div className="max-h-80 overflow-auto border-t border-line">
          <table className="w-full whitespace-nowrap text-sm">
            <thead className="sticky top-0 bg-panel text-left">
              <tr className="border-b border-line">
                <th className="label px-5 py-2 font-medium max-sm:px-3">Time</th>
                <th className="label px-3 py-2 text-right font-medium">Closed</th>
                <th className="label px-3 py-2 text-right font-medium">EAR</th>
                <th className="label hidden px-3 py-2 font-medium sm:table-cell">Camera</th>
                <th className="label px-5 py-2 font-medium">Telegram</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={e.id} className={`border-b border-line/60 ${i === 0 ? 'animate-rise' : ''}`}>
                  <td className="px-5 py-2 font-mono tabular max-sm:px-3">{fmtTime(e.timestamp)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular">
                    {e.duration ? `${e.duration.toFixed(1)} s` : '–'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular">{e.ear.toFixed(3)}</td>
                  <td className="hidden px-3 py-2 text-ink-soft sm:table-cell">{e.source}</td>
                  <td className="px-5 py-2">
                    {e.alertSent ? (
                      <span className="text-ok">Sent</span>
                    ) : (
                      <span className="text-ink-faint">Not sent</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
