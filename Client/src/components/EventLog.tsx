import { AlertTriangle, Clock, Trash2 } from 'lucide-react';
import { AlertEvent } from '../types';
import { formatEAR, formatTimestamp, getAlertBadgeColor } from '../utils/format';

interface EventLogProps {
  events: AlertEvent[];
  onClear: () => void;
}

export function EventLog({ events, onClear }: EventLogProps) {
  return (
    <div className="bg-white rounded-xl shadow-lg overflow-hidden">
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-slate-600">
              <Clock size={20} className="text-white" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Event Log</h2>
              <p className="text-xs text-gray-300">{events.length} total events</p>
            </div>
          </div>
          {events.length > 0 && (
            <button
              onClick={onClear}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors"
            >
              <Trash2 size={16} />
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="max-h-96 overflow-y-auto">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400">
            <AlertTriangle size={48} className="mb-4 opacity-50" />
            <p className="text-lg font-medium">No events recorded</p>
            <p className="text-sm mt-2">Alerts will appear here when detected</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {events.map((event) => (
              <div
                key={event.id}
                className="px-6 py-4 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1">
                    <div className={`w-3 h-3 rounded-full mt-1 ${getAlertBadgeColor(event.alertType)}`}></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-sm font-semibold ${
                          event.alertType === 'critical'
                            ? 'text-red-600'
                            : event.alertType === 'warning'
                            ? 'text-amber-600'
                            : 'text-emerald-600'
                        }`}>
                          {event.alertType.toUpperCase()}
                        </span>
                        <span className="text-xs text-gray-400">•</span>
                        <span className="text-xs text-gray-500">
                          {formatTimestamp(event.timestamp)}
                        </span>
                      </div>
                      <div className="text-sm text-gray-700">
                        EAR: <span className="font-mono font-semibold">{formatEAR(event.earValue)}</span>
                        {event.duration > 0 && (
                          <>
                            <span className="text-gray-400 mx-2">•</span>
                            Duration: <span className="font-semibold">{event.duration}s</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
