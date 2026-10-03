'use client';
import { useSyncExternalStore } from 'react';
import { THEME, THEME_KEY, type Theme } from '../components/brain/style';

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const current = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** The theme lives on html[data-theme] (set before paint, so no wrong-theme flash); this mirrors it. 'dark' on the server. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current, () => 'dark');
}

export function setTheme(t: Theme): void {
  const html = document.documentElement;
  // controls with a hover fade (120 ms) would lag the panels: flip everything in the same frame
  html.classList.add('theme-flip');
  requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('theme-flip')));
  html.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME[t].bg);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* storage blocked (private mode): the choice lasts this visit */
  }
  listeners.forEach((l) => l());
}
