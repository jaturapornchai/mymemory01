'use client';
import { useEffect, useRef, useState, type RefObject } from 'react';

/** Content-box size of an element, updated by ResizeObserver. */
export function useSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize((s) => (s.width === Math.round(width) && s.height === Math.round(height) ? s : { width: Math.round(width), height: Math.round(height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Re-renders every `ms` so relative times ("2m ago") stay fresh. Returns unix seconds. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Eases a number toward `target` (count-up). Instant when `instant` or reduced motion. */
export function useCountUp(target: number, instant: boolean, ms = 900): number {
  const [value, setValue] = useState(instant ? target : 0);
  const from = useRef(instant ? target : 0);
  // instant: adjust during render (React re-runs this component before committing), not from an effect, which would
  // cost a second commit per change, i.e. per replay frame that moves a stat
  if (instant && value !== target) setValue(target);
  useEffect(() => {
    if (instant) {
      from.current = target;
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - start) / ms)); // the first rAF stamp can precede `start`: no undershoot
      const v = origin + (target - origin) * (1 - Math.pow(1 - k, 3));
      from.current = v;
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, instant, ms]);
  return value;
}

/**
 * Rendered and not visibility:hidden (an ancestor's included): a focus target the user can see. Not checkVisibility():
 * Safari < 17.4 lacks it (TypeError → the whole app crashed), Chrome < 121 ignores its visibilityProperty.
 */
export function shown(el: Element | null | undefined): el is HTMLElement {
  return !!el && el !== document.body && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
}
