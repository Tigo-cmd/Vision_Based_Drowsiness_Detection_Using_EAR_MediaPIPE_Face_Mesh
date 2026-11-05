export interface ToastMsg {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

export function Toasts({ items }: { items: ToastMsg[] }) {
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={`animate-rise rounded-md px-4 py-2 text-sm text-white shadow-lg ${t.kind === 'ok' ? 'bg-ink' : 'bg-crit'}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
