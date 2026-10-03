'use client';
import { useEffect, useState } from 'react';
import { isBrain, type Brain } from './brain';
import { BrainStore } from './store';

// Build-time. Empty = same-origin static snapshot only.
const DATA_URL = (process.env.NEXT_PUBLIC_DATA_URL ?? '').replace(/\/+$/, '');

export type DataStatus = 'loading' | 'live' | 'snapshot' | 'error';

async function getBrain(url: string): Promise<Brain> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const j: unknown = await r.json();
  if (!isBrain(j)) throw new Error(`${url}: not a brain export`);
  return j;
}

/**
 * Loads graph.json, optionally merges a newer ${DATA_URL}/graph.json, then polls feed.json
 * (10 s; 2 s when the graph is `local`). A missing/failed feed is silent: status falls back to 'snapshot'.
 * `rev` bumps on node/link changes, `tick` on every merge (stats/events too).
 */
export function useBrainData() {
  const [store] = useState(() => new BrainStore());
  const [rev, setRev] = useState(0);
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<DataStatus>('loading');

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0; // a static snapshot has no feed.json: back off instead of 404-ing every 10 s
    const apply = (b: Brain, kind: 'graph' | 'feed') => {
      store.merge(b, kind);
      setRev(store.rev);
      setTick((t) => t + 1);
    };

    const poll = async () => {
      if (!document.hidden) {
        try {
          apply(await getBrain(`${DATA_URL || '.'}/feed.json?t=${Date.now()}`), 'feed');
          failures = 0;
          if (!stopped) setStatus('live');
        } catch {
          failures++;
          if (!stopped) setStatus('snapshot'); // no feed: keep going on the snapshot
        }
      }
      if (!stopped) timer = setTimeout(poll, (store.mode === 'local' ? 2000 : 10000) * Math.min(6, 2 ** failures));
    };

    (async () => {
      try {
        apply(await getBrain('graph.json'), 'graph');
      } catch {
        if (!stopped) setStatus('error');
        return;
      }
      if (DATA_URL) {
        try {
          const g = await getBrain(`${DATA_URL}/graph.json?t=${Date.now()}`);
          if (!stopped && g.at > store.at) apply(g, 'graph');
        } catch {
          /* snapshot stays */
        }
      }
      if (!stopped) setStatus('snapshot');
      void poll();
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [store]);

  return { store, rev, tick, status };
}
