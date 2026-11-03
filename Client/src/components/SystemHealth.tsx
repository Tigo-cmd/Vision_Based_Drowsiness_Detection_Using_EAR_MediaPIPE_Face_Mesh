import { useState } from 'react';
import { Activity, CheckCircle, Cpu, Send, Video, XCircle } from 'lucide-react';
import { DeviceInfo, TelegramState } from '../types';
import { api } from '../services/api';

interface SystemHealthProps {
  cameraActive: boolean;
  telegramState: TelegramState;
  telegramError: string | null;
  devices: DeviceInfo[];
  lastUpdate: string;
}

const TELEGRAM_LABELS: Record<TelegramState, string> = {
  configured: 'Ready',
  not_configured: 'Token not set on server',
  disabled: 'Turned off in settings',
  error: 'Last send failed',
};

export function SystemHealth({ cameraActive, telegramState, telegramError, devices, lastUpdate }: SystemHealthProps) {
  const timeSinceUpdate = Date.now() - new Date(lastUpdate).getTime();
  const isHealthy = timeSinceUpdate < 5000;
  const telegramOk = telegramState === 'configured';
  const hardware = devices.filter((d) => d.id !== 'browser');

  const [testState, setTestState] = useState<'idle' | 'sending' | 'ok' | 'failed'>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  const runTelegramTest = async () => {
    setTestState('sending');
    setTestError(null);
    const res = await api.sendTelegramTest();
    setTestState(res.ok ? 'ok' : 'failed');
    if (!res.ok) setTestError(res.error ?? 'Unknown error');
  };

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
              <p className="text-xs text-gray-500">{cameraActive ? 'Frames arriving' : 'No frames in the last 5s'}</p>
            </div>
          </div>
          {cameraActive ? (
            <CheckCircle size={20} className="text-emerald-600" />
          ) : (
            <XCircle size={20} className="text-gray-400" />
          )}
        </div>

        <div className="p-4 bg-gray-50 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Send size={20} className={telegramOk ? 'text-emerald-600' : 'text-gray-400'} />
              <div>
                <p className="text-sm font-medium text-gray-700">Telegram Bot</p>
                <p className={`text-xs ${telegramState === 'error' ? 'text-red-600' : 'text-gray-500'}`}>
                  {TELEGRAM_LABELS[telegramState] ?? telegramState}
                </p>
              </div>
            </div>
            <button
              onClick={runTelegramTest}
              disabled={testState === 'sending' || telegramState === 'not_configured'}
              className="text-xs font-medium px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-white disabled:opacity-50"
            >
              {testState === 'sending' ? 'Sending…' : 'Send test'}
            </button>
          </div>
          {testState === 'ok' && <p className="text-xs text-emerald-700 mt-2">Test message delivered.</p>}
          {testState === 'failed' && <p className="text-xs text-red-600 mt-2 break-words">{testError}</p>}
          {testState === 'idle' && telegramState === 'error' && telegramError && (
            <p className="text-xs text-red-600 mt-2 break-words">{telegramError}</p>
          )}
        </div>

        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
          <div className="flex items-center gap-3">
            <Cpu size={20} className={hardware.some((d) => d.online) ? 'text-emerald-600' : 'text-gray-400'} />
            <div>
              <p className="text-sm font-medium text-gray-700">ESP32-CAM</p>
              <p className="text-xs text-gray-500">
                {hardware.length === 0
                  ? 'No device has connected yet'
                  : hardware
                      .map((d) => `${d.id}: ${d.online ? 'online' : `last seen ${Math.round(d.lastSeenSec)}s ago`}`)
                      .join(' · ')}
              </p>
            </div>
          </div>
          {hardware.some((d) => d.online) ? (
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
