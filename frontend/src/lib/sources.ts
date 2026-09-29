/** Link from a paper's provenance row to that source's own record page,
 * where the paper can be read. Only https URLs on the source's own host are
 * produced, so a malformed id renders as plain text, never as a link.
 * OpenAlex records are stored as their full work URL
 * (`https://openalex.org/W123`), Semantic Scholar ones as the bare paperId. */
export function sourceRecordUrl(source: string, recordId: string): string | null {
  const id = recordId.trim();
  if (source === "openalex") {
    const m = /^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i.exec(id);
    return m ? `https://openalex.org/${m[1].toUpperCase()}` : null;
  }
  if (source === "semantic_scholar") {
    return /^[0-9a-f]{40}$/i.test(id) ? `https://www.semanticscholar.org/paper/${id.toLowerCase()}` : null;
  }
  return null;
}
