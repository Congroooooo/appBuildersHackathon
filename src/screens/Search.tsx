import { useEffect, useRef, useState } from 'react';
import { Search as SearchIcon, CornerDownLeft, Sparkles, Type } from 'lucide-react';
import { call } from '../api';
import type { AppContext } from '../App';
import type { SearchResponse } from '../types';
import { when } from '../format';

export function SearchPage({ ctx, initialQuery }: { ctx: AppContext; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const search = async (text = query) => {
    if (!text.trim()) return;
    setSearching(true);
    const result = await ctx.run(() => call<SearchResponse>('search', { query: text }));
    setSearching(false);
    if (result) setResponse(result);
  };
  // Arriving from the command palette runs the query straight away.
  const started = useRef(false);
  useEffect(() => { if (initialQuery && !started.current) { started.current = true; void search(initialQuery); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="page">
      <h1 id="main-heading" tabIndex={-1}>Find a session by what you were doing</h1>
      <div className="palette">
        <div className="palette-input">
          <SearchIcon size={18} aria-hidden="true" className="muted" />
          <label htmlFor="search-input" className="sr-only">Describe the work you're looking for</label>
          <input id="search-input" autoFocus value={query} maxLength={300} placeholder="e.g. auth redirect bug, checkout flow research…" onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void search(); }} />
          <span className="palette-hint">Search <kbd><CornerDownLeft size={11} /></kbd></span>
        </div>
        <div className="palette-body" aria-live="polite">
          {searching ? <><p className="palette-section searching"><Sparkles size={13} aria-hidden="true" className="accent pulse" /> Embedding your query on this device…</p><div className="skeleton" aria-hidden="true"><i /><i /><i /></div></>
            : !response ? <p className="palette-empty">Your query is embedded locally with {ctx.snapshot.settings.embeddingModel} and compared with your saved sessions. Nothing leaves this laptop.</p>
            : <>
              <p className="palette-section">{response.results.length} result{response.results.length === 1 ? '' : 's'} · {response.mode === 'semantic' ? 'semantic match' : `keyword match${response.error ? ' (local embeddings unavailable)' : ''}`}</p>
              {response.results.length === 0 ? <p className="palette-empty">No sessions match “{response.query}”.</p> : (
                <ul className="palette-list">
                  {response.results.map(r => (
                    <li key={r.sessionId}>
                      <button className="palette-row" onClick={() => ctx.navigate({ page: r.session.status === 'ended' ? 'session' : 'live', sessionId: r.sessionId })}>
                        {r.mode === 'semantic' ? <Sparkles size={15} aria-hidden="true" className="accent" /> : <Type size={15} aria-hidden="true" className="muted" />}
                        <span className="palette-main"><strong>{r.summaryTitle ?? r.session.title}</strong><span className="palette-snippet">{r.snippet}</span></span>
                        <span className="palette-type">{when(r.session.startedAt)}{r.mode === 'semantic' && <> · {Math.round(r.score * 100)}%<span className="score" aria-hidden="true"><i style={{ width: `${Math.round(Math.max(0, Math.min(1, r.score)) * 100)}%` }} /></span></>}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>}
        </div>
        <div className="palette-foot"><span>Open session <kbd><CornerDownLeft size={11} /></kbd></span><span>Command palette <kbd>Ctrl</kbd><kbd>K</kbd></span></div>
      </div>
    </div>
  );
}
