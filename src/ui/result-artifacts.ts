import path from "node:path";
import type { QueryResultHtmlArtifact } from "../types/index.js";

const GENERIC_ARTIFACT_LINE_PATTERN = /^(?<label>[^:：\n]{1,80}[:：])\s*(?<target>.+)$/u;

function isArtifactTarget(value: string): boolean {
  return /^file:\/\//iu.test(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

export function isDirectArtifactAddressLine(line: string): boolean {
  return /^(Open full table in a browser:|HTML file:|Open the same cached rows as CSV:|CSV file:)/i.test(line.trim());
}

export function isGenericArtifactReferenceLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (isArtifactTarget(trimmed)) {
    return true;
  }

  const match = trimmed.match(GENERIC_ARTIFACT_LINE_PATTERN);
  const target = match?.groups?.target?.trim();
  return Boolean(target && isArtifactTarget(target));
}

export function stripArtifactReferenceLines(text: string): string {
  const retainedLines = text.split("\n").filter((line) => !isGenericArtifactReferenceLine(line));
  return retainedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildResultArtifactDisplayText(htmlArtifact: QueryResultHtmlArtifact | null | undefined): string | null {
  if (!htmlArtifact) {
    return null;
  }

  return [`HTML view: ${htmlArtifact.fileUrl}`, `CSV file: ${htmlArtifact.csvFileUrl}`].join("\n");
}
