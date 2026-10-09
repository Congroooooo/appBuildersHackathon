import { History as HistoryIcon } from 'lucide-react';
import type { AppContext } from '../App';
import { SessionRow } from './Resume';
import { Empty } from '../components';
import { day } from '../format';

export function HistoryPage({ ctx }: { ctx: AppContext }) {
  const { snapshot, navigate } = ctx;
  const groups = new Map<string, typeof snapshot.sessions>();
  for (const s of snapshot.sessions) { const key = day(s.startedAt); groups.set(key, [...(groups.get(key) ?? []), s]); }
  return (
    <div className="page">
      <h1 id="main-heading" tabIndex={-1}>Your work memory</h1>
      <p className="lead">Every session you recorded, newest first. Open one to inspect its evidence, correct the recap or delete it.</p>
      {snapshot.sessions.length === 0 ? <Empty icon={<HistoryIcon size={20} aria-hidden="true" />} title="No sessions yet"><p className="muted">Start one from Resume or Live session.</p></Empty>
        : [...groups.entries()].map(([label, sessions]) => (
          <section key={label} className="section" aria-label={label}>
            <h2 className="section-title">{label}</h2>
            <div className="rows">{sessions.map(s => <SessionRow key={s.id} session={s} onOpen={() => navigate({ page: s.status === 'ended' ? 'session' : 'live', sessionId: s.id })} />)}</div>
          </section>
        ))}
    </div>
  );
}
