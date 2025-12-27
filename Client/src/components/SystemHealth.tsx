import { Activity, CheckCircle, Send, Video, XCircle } from 'lucide-react';

interface SystemHealthProps {
  cameraActive: boolean;
  telegramConnected: boolean;
  lastUpdate: string;
}

export function SystemHealth({ cameraActive, telegramConnected, lastUpdate }: SystemHealthProps) {
  const timeSinceUpdate = Date.now() - new Date(lastUpdate).getTime();
  const isHealthy = timeSinceUpdate < 5000;

  return (
    <div className="bg-white rounded-xl shadow-lg overflow-hidden">
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-slate-600">
            <Activity size={20} className="text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">System Health</h2>
            <p className="text-xs text-gray-300">Component status</p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
          <div className="flex items-center gap-3">
            <Video size={20} className={cameraActive ? 'text-emerald-600' : 'text-gray-400'} />
            <div>
              <p className="text-sm font-medium text-gray-700">Camera Feed</p>
              <p className="text-xs text-gray-500">Video input device</p>
            </div>
          </div>
          {cameraActive ? (
            <CheckCircle size={20} className="text-emerald-600" />
          ) : (
            <XCircle size={20} className="text-gray-400" />
          )}
        </div>

        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
          <div className="flex items-center gap-3">
            <Send size={20} className={telegramConnected ? 'text-emerald-600' : 'text-gray-400'} />
            <div>
              <p className="text-sm font-medium text-gray-700">Telegram Bot</p>
              <p className="text-xs text-gray-500">Notification service</p>
            </div>
          </div>
          {telegramConnected ? (
            <CheckCircle size={20} className="text-emerald-600" />
          ) : (
            <XCircle size={20} className="text-gray-400" />
          )}
        </div>

        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
          <div className="flex items-center gap-3">
            <Activity size={20} className={isHealthy ? 'text-emerald-600' : 'text-amber-600'} />
            <div>
              <p className="text-sm font-medium text-gray-700">Detection System</p>
              <p className="text-xs text-gray-500">Drowsiness monitoring</p>
            </div>
          </div>
          {isHealthy ? (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
              <span className="text-xs font-medium text-emerald-600">Active</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-amber-500 rounded-full"></div>
              <span className="text-xs font-medium text-amber-600">Delayed</span>
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-gray-200">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Last Update</span>
            <span className="font-mono">{new Date(lastUpdate).toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
