import { z } from "zod";
import type { LlmConfig, TableSchema } from "../types/index.js";
import { LlmClient } from "../llm/client.js";
import type { LlmMessageParam } from "../llm/types.js";

export const TABLE_ANALYSIS_BATCH_SIZE = 12;

const tableMetadataSchema = z.object({
  description: z.string().min(1).max(220),
  tags: z.array(z.string().min(1).max(40)).min(3).max(8),
});
const batchTableMetadataSchema = z.array(
  z.object({
    tableName: z.string().min(1),
    description: z.string().min(1).max(220),
    tags: z.array(z.string().min(1).max(40)).min(3).max(8),
  }),
);

function clipWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstObjectIndex = trimmed.indexOf("{");
  const firstArrayIndex = trimmed.indexOf("[");
  const hasObject = firstObjectIndex >= 0;
  const hasArray = firstArrayIndex >= 0;

  if (hasObject || hasArray) {
    const startIndex =
      hasObject && hasArray ? Math.min(firstObjectIndex, firstArrayIndex) : hasObject ? firstObjectIndex : firstArrayIndex;
    const openingChar = trimmed[startIndex];
    const closingChar = openingChar === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let isEscaped = false;

    for (let index = startIndex; index < trimmed.length; index += 1) {
      const character = trimmed[index];

      if (inString) {
        if (isEscaped) {
          isEscaped = false;
        } else if (character === "\\") {
          isEscaped = true;
        } else if (character === "\"") {
          inString = false;
        }
        continue;
      }

      if (character === "\"") {
        inString = true;
        continue;
      }

      if (character === openingChar) {
        depth += 1;
        continue;
      }

      if (character === closingChar) {
        depth -= 1;
        if (depth === 0) {
          return trimmed.slice(startIndex, index + 1);
        }
      }
    }
  }

  return trimmed;
}

function buildTableAnalysisPrompt(table: TableSchema): string {
  const columnPreview = table.columns
    .map((column) => {
      const nullable = column.isNullable ? "nullable" : "not null";
      const defaultValue = column.defaultValue ? ` default=${String(column.defaultValue).replace(/\s+/g, " ").trim()}` : "";
      return `- ${column.name}: ${column.dataType}, ${nullable}${defaultValue}`;
    })
    .join("\n");

  return [
    `Analyze this database table for semantic search.`,
    `Table name: ${table.tableName}`,
    `Columns:`,
    columnPreview,
    ``,
    `Return JSON only with this exact shape:`,
    `{"description":"...","tags":["..."]}`,
    ``,
    `Rules:`,
    `- description must be one concise English sentence under 30 words`,
    `- tags must be 3 to 8 short lowercase search tags`,
    `- focus on likely business meaning, entities, and common query intents`,
    `- do not mention uncertainty or add any extra keys`,
  ].join("\n");
}

export interface TableSearchMetadata {
  description: string;
  tags: string[];
}

export interface TableSearchMetadataWithName extends TableSearchMetadata {
  tableName: string;
}

export function buildTableEmbeddingText(table: TableSchema, metadata: TableSearchMetadata): string {
  const columnNames = table.columns.map((column) => column.name).join(", ");
  const columnTypes = table.columns.map((column) => `${column.name}:${column.dataType}`).join(", ");
  return [
    `table ${table.tableName}`,
    `description ${metadata.description}`,
    `tags ${metadata.tags.join(", ")}`,
    `columns ${columnNames}`,
    `column-types ${columnTypes}`,
  ].join("\n");
}

function buildTableAnalysisMessages(tables: TableSchema[]): LlmMessageParam[] {
  return [
    {
      role: "system",
      content:
        "You describe database tables for search indexing. Reply with valid JSON only and keep the output compact, concrete, and in English.",
    },
    {
      role: "user",
      content: tables.length === 1 ? buildTableAnalysisPrompt(tables[0]) : buildBatchTableAnalysisPrompt(tables),
    },
  ];
}

function buildBatchTableAnalysisPrompt(tables: TableSchema[]): string {
  const tableBlocks = tables
    .map((table) => {
      const columns = table.columns
        .map((column) => {
          const nullable = column.isNullable ? "nullable" : "not null";
          const defaultValue = column.defaultValue ? ` default=${String(column.defaultValue).replace(/\s+/g, " ").trim()}` : "";
          return `- ${column.name}: ${column.dataType}, ${nullable}${defaultValue}`;
        })
        .join("\n");

      return [`Table name: ${table.tableName}`, "Columns:", columns].join("\n");
    })
    .join("\n\n");

  return [
    "Analyze these database tables for semantic search.",
    tableBlocks,
    "",
    "Return JSON only as an array with this exact shape:",
    '[{"tableName":"...","description":"...","tags":["..."]}]',
    "",
    "Rules:",
    "- return one item for every input table",
    "- preserve each tableName exactly",
    "- description must be one concise English sentence under 30 words",
    "- tags must be 3 to 8 short lowercase search tags",
    "- focus on likely business meaning, entities, and common query intents",
    "- do not add extra keys or explanatory text",
  ].join("\n");
}

function normalizeMetadata(tableName: string, description: string, tags: string[]): TableSearchMetadataWithName {
  const normalizedTags = Array.from(new Set(tags.map(normalizeTag).filter(Boolean))).slice(0, 8);
  if (normalizedTags.length < 3) {
    throw new Error(`The LLM returned too few usable tags for '${tableName}'.`);
  }

  return {
    tableName,
    description: clipWords(description.replace(/\s+/g, " ").trim(), 30),
    tags: normalizedTags,
  };
}

export async function analyzeTableBatchForSearch(
  llmConfig: LlmConfig,
  tables: TableSchema[],
): Promise<Map<string, TableSearchMetadata>> {
  if (!tables.length) {
    return new Map();
  }

  const client = new LlmClient(llmConfig);
  const response = await client.complete(buildTableAnalysisMessages(tables), []);
  if (!response.content?.trim()) {
    throw new Error(tables.length === 1 ? `The LLM returned an empty table analysis for '${tables[0].tableName}'.` : "The LLM returned an empty table analysis batch.");
  }

  if (tables.length === 1) {
    const parsed = tableMetadataSchema.parse(JSON.parse(extractJsonPayload(response.content)));
    const normalized = normalizeMetadata(tables[0].tableName, parsed.description, parsed.tags);
    return new Map([
      [
        tables[0].tableName,
        {
          description: normalized.description,
          tags: normalized.tags,
        },
      ],
    ]);
  }

  const parsedBatch = batchTableMetadataSchema.parse(JSON.parse(extractJsonPayload(response.content)));
  const metadataByTable = new Map(
    parsedBatch.map((item) => [item.tableName, normalizeMetadata(item.tableName, item.description, item.tags)]),
  );
  const results = new Map<string, TableSearchMetadata>();

  for (const table of tables) {
    const metadata = metadataByTable.get(table.tableName);
    if (!metadata) {
      throw new Error(`The LLM did not return metadata for '${table.tableName}'.`);
    }

    results.set(table.tableName, {
      description: metadata.description,
      tags: metadata.tags,
    });
  }

  return results;
}
