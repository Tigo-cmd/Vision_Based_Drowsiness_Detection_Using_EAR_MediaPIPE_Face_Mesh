import { useEffect, useState } from 'react';
import { Eye, AlertCircle, TrendingDown } from 'lucide-react';
import { CameraFeed } from './components/CameraFeed';
import { StatusCard } from './components/StatusCard';
import { EventLog } from './components/EventLog';
import { SettingsPanel } from './components/SettingsPanel';
import { SystemHealth } from './components/SystemHealth';
import { api } from './services/api';
import { AlertEvent, SystemSettings, SystemStatus } from './types';
import { formatEAR } from './utils/format';

function App() {
  const [status, setStatus] = useState<SystemStatus>({
    cameraActive: false,
    telegramConnected: false,
    currentEAR: 0,
    alertState: 'normal',
    lastUpdate: new Date().toISOString(),
  });
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [settings, setSettings] = useState<SystemSettings>(api.getSettings());
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    api.startSimulation();

    const interval = setInterval(async () => {
      const newStatus = await api.getStatus();
      setStatus(newStatus);

      const newEvents = await api.getEvents();
      setEvents(newEvents);
    }, 500);

    return () => {
      clearInterval(interval);
      api.stopSimulation();
    };
  }, []);

  const handleSaveSettings = async (newSettings: SystemSettings) => {
    const updated = await api.updateSettings(newSettings);
    setSettings(updated);
  };

  const handleClearEvents = async () => {
    await api.clearEvents();
    setEvents([]);
  };

  const getAlertStatus = (): 'normal' | 'warning' | 'critical' => {
    // Note: status.alertState from API is more accurate as it uses consecutive frames
    return status.alertState;
  };

  const alertStatus = getAlertStatus();

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="bg-gradient-to-r from-slate-900 to-slate-800 shadow-xl">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-slate-700 rounded-xl">
                <Eye size={32} className="text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">
                  Driver Drowsiness Monitor
                </h1>
                <p className="text-gray-300 text-sm">Real-time alertness detection system</p>
              </div>
            </div>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${showSettings
                ? 'bg-slate-600 text-white'
                : 'bg-white text-slate-800 hover:bg-gray-100'
                }`}
            >
              {showSettings ? 'Hide Settings' : 'Settings'}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          <StatusCard
            title="Eye Aspect Ratio"
            value={formatEAR(status.currentEAR)}
            icon={Eye}
            status={alertStatus}
            subtitle={`Threshold: ${settings.earThreshold.toFixed(2)}`}
          />
          <StatusCard
            title="Alert Status"
            value={status.alertState.toUpperCase()}
            icon={AlertCircle}
            status={status.alertState}
            subtitle={status.alertState === 'normal' ? 'Driver alert' : 'Attention required'}
          />
          <StatusCard
            title="Recent Alerts"
            value={events.length}
            icon={TrendingDown}
            status={events.length > 10 ? 'warning' : 'normal'}
            subtitle="Total events logged"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <CameraFeed alertState={status.alertState} />
            <EventLog events={events} onClear={handleClearEvents} />
          </div>

          <div className="space-y-6">
            <SystemHealth
              cameraActive={status.cameraActive}
              telegramConnected={status.telegramConnected}
              lastUpdate={status.lastUpdate}
            />
            {showSettings && (
              <SettingsPanel settings={settings} onSave={handleSaveSettings} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
