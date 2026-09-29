import { useRef, useState, type ReactNode } from "react";
import Method from "./Method";

interface MethodProps {
  algorithm: string | null;
  algorithmNote?: string;
  detectionDate?: string | null;
  explanation: string;
  /** Hide the "Methods & runs" link until that page exists (Phase 8). */
  linkToMethods?: boolean;
}

interface CsvData {
  filename: string;
  headers: string[];
  rows: (string | number)[][];
}

interface Props {
  title: string;
  subtitle?: string;
  caption: string;
  svg: ReactNode;
  tableView: ReactNode;
  method?: MethodProps;
  csv?: CsvData;
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

/** The one memorable visual element: a hairline-framed figure with a
 * caption naming the topic scope, corpus size and sources, a "View as
 * table" toggle (every figure's numbers are reachable as a table), and
 * SVG/CSV export. design-system.md §1 and §4. */
export default function Figure({ title, subtitle, caption, svg, tableView, method, csv }: Props) {
  const [showTable, setShowTable] = useState(false);
  const svgHost = useRef<HTMLDivElement>(null);

  const downloadSvg = () => {
    const el = svgHost.current?.querySelector("svg");
    if (!el) return;
    const xml = new XMLSerializer().serializeToString(el);
    download(`${title.replace(/\s+/g, "-").toLowerCase()}.svg`, xml, "image/svg+xml");
  };
  const downloadCsv = () => {
    if (!csv) return;
    download(csv.filename, toCsv(csv.headers, csv.rows), "text/csv");
  };

  return (
    <figure className="border border-rule-strong bg-sheet p-4 print:break-inside-avoid">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-serif text-base font-semibold leading-snug">{title}</h3>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        <div className="flex gap-3 text-sm">
          <button type="button" onClick={() => setShowTable((v) => !v)} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
            {showTable ? "View as figure" : "View as table"}
          </button>
          <button type="button" onClick={downloadSvg} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
            Download SVG
          </button>
          {csv && (
            <button type="button" onClick={downloadCsv} className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
              Download CSV
            </button>
          )}
        </div>
      </div>
      {/* The SVG stays mounted (sr-only, aria-hidden) in table view so
          "Download SVG" still works; the inactive table is fully hidden, not
          sr-only, so it never becomes an invisible focusable scroll region.
          The "View as table" toggle is how every reader reaches the numbers. */}
      <div ref={svgHost} className={showTable ? "sr-only" : "overflow-x-auto"} aria-hidden={showTable || undefined}>
        {svg}
      </div>
      <div hidden={!showTable}>{tableView}</div>
      <figcaption className="mt-2 text-sm text-muted print:block">{caption}</figcaption>
      {method && <Method {...method} />}
    </figure>
  );
}
