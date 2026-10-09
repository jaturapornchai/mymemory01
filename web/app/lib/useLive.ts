'use client';
import { useEffect, useState } from 'react';
import { LiveFeed, callEvents } from './live';
import type { BrainStore } from './store';

/**
 * The local viewer's live feed (lib/live.ts), only while the graph says `local`: the public site never requests
 * /live.json. Each fresh call lights the 3D map at once (store.flash); `available` flips when /live.json first answers,
 * and from then on it owns search/recall light (the feed's minute buckets only join the history).
 */
export function useLive(store: BrainStore, local: boolean) {
  const [available, setAvailable] = useState(false);
  const [feed] = useState(() => new LiveFeed(() => {
    store.liveOwns = true;
    setAvailable(true);
  }));

  useEffect(() => {
    if (!local) return;
    const off = feed.on((c, fresh) => {
      if (fresh) store.flash.push(...callEvents(c));
    });
    feed.start();
    return () => {
      off();
      feed.stop();
    };
  }, [feed, store, local]);

  return { feed, available };
}
