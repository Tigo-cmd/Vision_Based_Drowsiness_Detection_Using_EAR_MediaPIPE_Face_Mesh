export function formatEAR(value: number): string {
  return value.toFixed(3);
}

export function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;

  return date.toLocaleString();
}

export function getAlertColor(alertType: 'normal' | 'warning' | 'critical'): string {
  switch (alertType) {
    case 'critical':
      return 'text-red-600 bg-red-50 border-red-200';
    case 'warning':
      return 'text-amber-600 bg-amber-50 border-amber-200';
    default:
      return 'text-emerald-600 bg-emerald-50 border-emerald-200';
  }
}

export function getAlertBadgeColor(alertType: 'normal' | 'warning' | 'critical'): string {
  switch (alertType) {
    case 'critical':
      return 'bg-red-500';
    case 'warning':
      return 'bg-amber-500';
    default:
      return 'bg-emerald-500';
  }
}
