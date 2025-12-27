import { LucideIcon } from 'lucide-react';

interface StatusCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  status?: 'normal' | 'warning' | 'critical';
  subtitle?: string;
}

export function StatusCard({ title, value, icon: Icon, status = 'normal', subtitle }: StatusCardProps) {
  const statusColors = {
    normal: 'border-emerald-200 bg-emerald-50',
    warning: 'border-amber-200 bg-amber-50',
    critical: 'border-red-200 bg-red-50',
  };

  const textColors = {
    normal: 'text-emerald-700',
    warning: 'text-amber-700',
    critical: 'text-red-700',
  };

  const iconColors = {
    normal: 'text-emerald-600',
    warning: 'text-amber-600',
    critical: 'text-red-600',
  };

  return (
    <div className={`border-2 rounded-xl p-6 transition-all duration-300 ${statusColors[status]}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-600 mb-1">{title}</p>
          <p className={`text-3xl font-bold ${textColors[status]} mb-1`}>{value}</p>
          {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
        </div>
        <div className={`p-3 rounded-lg bg-white ${iconColors[status]}`}>
          <Icon size={24} />
        </div>
      </div>
    </div>
  );
}
