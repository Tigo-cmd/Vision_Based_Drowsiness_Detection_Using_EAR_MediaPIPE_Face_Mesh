import { Settings, Save } from 'lucide-react';
import { useState } from 'react';
import { SystemSettings } from '../types';

interface SettingsPanelProps {
  settings: SystemSettings;
  onSave: (settings: SystemSettings) => void;
}

export function SettingsPanel({ settings, onSave }: SettingsPanelProps) {
  const [localSettings, setLocalSettings] = useState(settings);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    await onSave(localSettings);
    setTimeout(() => setIsSaving(false), 500);
  };

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(localSettings);

  return (
    <div className="bg-white rounded-xl shadow-lg overflow-hidden">
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-slate-600">
            <Settings size={20} className="text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">System Settings</h2>
            <p className="text-xs text-gray-300">Configure detection thresholds</p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            EAR Threshold
          </label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0.15"
              max="0.35"
              step="0.01"
              value={localSettings.earThreshold}
              onChange={(e) =>
                setLocalSettings({ ...localSettings, earThreshold: parseFloat(e.target.value) })
              }
              className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-slate-600"
            />
            <span className="text-lg font-mono font-semibold text-gray-700 w-16 text-right">
              {localSettings.earThreshold.toFixed(2)}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Lower values = more sensitive detection
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Alert Duration Threshold (seconds)
          </label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="1"
              max="10"
              step="1"
              value={localSettings.alertDurationThreshold}
              onChange={(e) =>
                setLocalSettings({
                  ...localSettings,
                  alertDurationThreshold: parseInt(e.target.value),
                })
              }
              className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-slate-600"
            />
            <span className="text-lg font-mono font-semibold text-gray-700 w-16 text-right">
              {localSettings.alertDurationThreshold}s
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Consecutive seconds below threshold before alerting
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Notification Cooldown (seconds)
          </label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="10"
              max="300"
              step="10"
              value={localSettings.notificationCooldown}
              onChange={(e) =>
                setLocalSettings({
                  ...localSettings,
                  notificationCooldown: parseInt(e.target.value),
                })
              }
              className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-slate-600"
            />
            <span className="text-lg font-mono font-semibold text-gray-700 w-16 text-right">
              {localSettings.notificationCooldown}s
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Minimum time between repeated notifications
          </p>
        </div>

        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
          <div>
            <p className="text-sm font-medium text-gray-700">Telegram Notifications</p>
            <p className="text-xs text-gray-500 mt-1">Send alerts to Telegram</p>
          </div>
          <button
            onClick={() =>
              setLocalSettings({
                ...localSettings,
                telegramEnabled: !localSettings.telegramEnabled,
              })
            }
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              localSettings.telegramEnabled ? 'bg-emerald-500' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                localSettings.telegramEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {hasChanges && (
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-slate-700 hover:bg-slate-800 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            <Save size={18} />
            {isSaving ? 'Saving...' : 'Save Settings'}
          </button>
        )}
      </div>
    </div>
  );
}
