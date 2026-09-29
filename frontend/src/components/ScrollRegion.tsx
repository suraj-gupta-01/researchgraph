import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  /** Accessible name, announced when the region takes focus. */
  label: string;
  className?: string;
  /** Render as <pre> for code blocks. */
  as?: "div" | "pre";
  children: ReactNode;
}

/** A horizontally scrollable container (wide table, SQL text) that keyboard
 * users can scroll: when -- and only when -- its content overflows, it
 * becomes a focusable, labelled region, so arrow keys scroll it (WCAG 2.1.1;
 * axe "scrollable-region-focusable"). A table that fits adds no tab stop. */
export default function ScrollRegion({ label, className = "", as = "div", children }: Props) {
  const ref = useRef<HTMLElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  const props = {
    className: `overflow-x-auto ${className}`,
    ...(overflowing ? { tabIndex: 0, role: "region", "aria-label": `${label} (scrolls sideways)` } : {}),
  };
  return as === "pre" ? (
    <pre ref={(el) => { ref.current = el; }} {...props}>{children}</pre>
  ) : (
    <div ref={(el) => { ref.current = el; }} {...props}>{children}</div>
  );
}
