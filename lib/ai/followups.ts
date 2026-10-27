// ─────────────────────────────────────────────────────────────────────────────
// Suggested next questions, carried at the end of an answer.
//
// The model is asked to finish every answer with a fenced block:
//
//   ```followups
//   - How does this compare with last quarter?
//   - Which customers are the most overdue?
//   ```
//
// Carried in the answer rather than asked for separately, because a second
// call to the model would cost the customer credits for three short lines.
// The server strips the block before storing the answer; the browser hides it
// while the answer is still streaming in.
//
// Shared by both sides, so no imports.
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK = /```[ \t]*follow-?ups?[ \t]*\r?\n([\s\S]*?)(?:```|$)/i;
const MARKER = 'followups';

/** The answer without its follow-up block, and the questions in it (at most three). */
export function splitFollowups(text: string): { body: string; followups: string[] } {
  const m = BLOCK.exec(text);
  if (!m) return { body: text.trim(), followups: [] };

  const followups = m[1]
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length >= 4 && l.length <= 160)
    .slice(0, 3);

  const body = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  return { body, followups };
}

/**
 * What to show of an answer that is still arriving.
 *
 * Cuts from the start of a follow-up block — including one only partly
 * received, where the text so far ends in "```fol" — so the block never
 * flickers onto the screen before the finished answer replaces it.
 */
export function visibleWhileStreaming(text: string): string {
  const full = text.search(/```[ \t]*follow/i);
  if (full >= 0) return text.slice(0, full).trimEnd();

  const fence = text.lastIndexOf('```');
  if (fence >= 0) {
    const tail = text.slice(fence + 3).trim().toLowerCase();
    if (!tail.includes('\n') && MARKER.startsWith(tail)) return text.slice(0, fence).trimEnd();
  }
  return text;
}
