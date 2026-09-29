interface Props {
  analysis: string;
  command: string;
  prerequisite?: string;
}

/** Empty state for an analysis that has not run yet (communities, trends,
 * bridges, convergence). Names the exact command and, where one exists, the
 * required run order — api-coverage.md §3: "communities → influence;
 * trends → convergence." */
export default function NotComputed({ analysis, command, prerequisite }: Props) {
  return (
    <div className="max-w-xl border border-dashed border-rule-strong bg-sheet px-5 py-6">
      <p className="font-serif text-lg font-semibold leading-snug">{analysis} has not been computed yet</p>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        {prerequisite ? <>Run {prerequisite} first, then run </> : <>Run </>}
        <code className="font-mono text-[13px]">{command}</code> to compute it.
      </p>
    </div>
  );
}
