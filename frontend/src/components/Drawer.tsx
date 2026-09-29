import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Right-side entity-peek drawer (design-system.md §3): focus-trapped,
 * Escape closes, focus returns to whatever opened it. */
export default function Drawer({ open, onClose, title, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<Element | null>(null);

  useEffect(() => {
    if (open) {
      trigger.current = document.activeElement;
      const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    } else {
      (trigger.current as HTMLElement | null)?.focus?.();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const [first, last] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <aside
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-30 overflow-y-auto bg-paper p-5 shadow-lg lg:sticky lg:top-[52px] lg:z-auto lg:max-h-[calc(100vh-64px)] lg:w-[420px] lg:border-l lg:border-rule lg:bg-sheet"
    >
      <button type="button" onClick={onClose} className="mb-3 rounded-sm border border-rule-strong bg-sheet px-3 py-1 text-sm hover:bg-accent-soft">
        Close
      </button>
      {children}
    </aside>
  );
}
