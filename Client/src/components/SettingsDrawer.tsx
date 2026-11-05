import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Settings } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings | null;
  onSave: (s: Settings) => Promise<void>;
  soundOn: boolean;
  onSoundChange: (on: boolean) => void;
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  digits,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  digits: number;
  onChange: (v: number) => void;
}) {
  const id = label.replace(/\s/g, '-').toLowerCase();
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span className="font-mono text-sm tabular">
          {value.toFixed(digits)}
          {unit}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-2 w-full"
      />
      <p className="mt-1 text-xs text-ink-faint">{hint}</p>
    </div>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-ink-faint">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-ink' : 'bg-line'}`}
      >
        <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
    </label>
  );
}

export function SettingsDrawer({ open, onClose, settings, onSave, soundOn, onSoundChange }: Props) {
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [saving, setSaving] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // While closed, mirror the server's values; once open, edits are kept until Save or Reset.
  useEffect(() => {
    if (!open) setDraft(settings);
  }, [open, settings]);

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const dirty = !!draft && !!settings && JSON.stringify(draft) !== JSON.stringify(settings);

  return (
    <div className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-ink/20 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
      />
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-label="Settings"
        className={`absolute right-0 top-0 flex h-full w-full max-w-sm flex-col border-l border-line bg-panel outline-none transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-semibold">Settings</h2>
          <button className="btn-ghost -mr-2 px-2" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </header>

        {!draft ? (
          <p className="p-5 text-sm text-ink-soft">Loading settings from the server&hellip;</p>
        ) : (
          <div className="flex-1 space-y-7 overflow-auto p-5">
            <p className="label">Detection (saved on the server)</p>
            <Slider
              label="EAR threshold"
              hint="Below this the eyes count as closed. Lower = needs more closure. You can also drag the line on the chart."
              value={draft.earThreshold}
              min={0.1}
              max={0.35}
              step={0.005}
              unit=""
              digits={3}
              onChange={(v) => setDraft({ ...draft, earThreshold: v })}
            />
            <Slider
              label="Alert duration"
              hint="How long the eyes must stay closed before the alarm. The warning starts at half of this."
              value={draft.drowsyTime}
              min={1}
              max={10}
              step={0.5}
              unit=" s"
              digits={1}
              onChange={(v) => setDraft({ ...draft, drowsyTime: v })}
            />
            <Slider
              label="Telegram repeat"
              hint="While an alert lasts, send another Telegram message at most this often."
              value={draft.telegramCooldown}
              min={10}
              max={300}
              step={10}
              unit=" s"
              digits={0}
              onChange={(v) => setDraft({ ...draft, telegramCooldown: v })}
            />
            <Toggle
              label="Telegram alerts"
              hint="Send a message with a photo when the driver is drowsy."
              on={draft.telegramEnabled}
              onChange={(v) => setDraft({ ...draft, telegramEnabled: v })}
            />

            <p className="label border-t border-line pt-6">This browser</p>
            <Toggle
              label="Alarm sound"
              hint="Beep here too: slow for a warning, fast when drowsy. Shortcut: M."
              on={soundOn}
              onChange={onSoundChange}
            />
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button className="btn-ghost" onClick={() => setDraft(settings)} disabled={!dirty || saving}>
            Reset
          </button>
          <button
            className="btn-primary"
            disabled={!dirty || saving}
            onClick={async () => {
              if (!draft) return;
              setSaving(true);
              await onSave(draft);
              setSaving(false);
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </aside>
    </div>
  );
}
