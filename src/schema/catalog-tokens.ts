/**
 * Normalize free-form text for catalog indexing while preserving both whole identifiers and split terms.
 */
export function tokenizeCatalogText(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]+/g, " ")
    .toLowerCase();
  const asciiTokens = normalized.match(/[a-z0-9]+/g) ?? [];
  const preservedIdentifiers = Array.from(
    new Set(
      value
        .toLowerCase()
        .match(/[a-z0-9]+(?:[_\-.][a-z0-9]+)+/g) ?? [],
    ),
  );
  const cjkTokens = extractCjkTokens(value);

  return [...asciiTokens, ...preservedIdentifiers, ...cjkTokens].filter(Boolean);
}

/**
 * Deduplicate tokens while preserving order for search result reporting and tags.
 */
export function uniqueTokens(tokens: readonly string[]): string[] {
  return Array.from(new Set(tokens.filter(Boolean)));
}

/**
 * Extract CJK chunks as both whole words and overlapping bigrams for better partial matching.
 */
function extractCjkTokens(value: string): string[] {
  const tokens: string[] = [];
  const chunks = value.match(/[\p{Script=Han}]+/gu) ?? [];

  for (const chunk of chunks) {
    const characters = Array.from(chunk);
    if (!characters.length) {
      continue;
    }

    tokens.push(chunk);
    if (characters.length === 1) {
      tokens.push(characters[0]);
      continue;
    }

    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.push(`${characters[index]}${characters[index + 1]}`);
    }
  }

  return tokens;
}

/**
 * Build stable, bounded local tags from table names, aliases, comments, and column names.
 */
export function buildLocalSearchTags(inputs: readonly string[], maxTags = 8): string[] {
  return uniqueTokens(inputs.flatMap((value) => tokenizeCatalogText(value))).slice(0, Math.max(1, maxTags));
}
