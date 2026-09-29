import { useEffect, useRef, useState } from "react";

/** Pixel width of an element, kept current with a ResizeObserver, so an SVG
 * figure can be drawn at its real size and keep 12 px text at 12 px on a
 * 390 px screen. Falls back to `fallback` where layout is unavailable
 * (jsdom, first paint). */
export function useContainerWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
}
