import { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function NotFound({ message }: { message?: string }) {
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  return (
    <div className="max-w-xl py-10">
      <h1 className="font-serif text-2xl font-semibold">{message ?? "Page not found"}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Search a topic instead, or use the directories in the left rail to browse papers, authors, institutions, venues and topics directly.
      </p>
      <form
        role="search"
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) navigate(`/explore?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <label className="sr-only" htmlFor="notfound-q">
          Search a research topic
        </label>
        <input
          id="notfound-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a research topic"
          className="min-w-0 flex-1 rounded-sm border border-rule-strong bg-sheet px-3 py-2 text-base placeholder:text-faint"
        />
        <button type="submit" className="rounded-sm bg-accent px-4 py-2 font-medium text-white hover:bg-ink">
          Search
        </button>
      </form>
    </div>
  );
}
