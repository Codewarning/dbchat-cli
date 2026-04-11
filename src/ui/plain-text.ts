// Helpers for stripping markup from model output before it hits the terminal.
/**
 * Remove fenced code block markers while keeping the block contents.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```(?:[^\n`]*)\n?/g, "");
}

/**
 * Normalize common Markdown patterns into plain terminal-safe text.
 */
export function normalizeCliText(text: string): string {
  // Remove the most common Markdown constructs while preserving the original wording.
  return stripCodeFences(text)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*>\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
