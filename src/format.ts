export const time = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
export const day = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso), today = new Date(), yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
export const when = (iso: string | null | undefined) => `${day(iso)}, ${time(iso)}`;
export const duration = (ms: number) => {
  const minutes = Math.round(ms / 60000);
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};
export const span = (start: string, end: string | null) => `${time(start)} – ${end ? time(end) : 'now'}`;
export const bytes = (n: number) => n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
