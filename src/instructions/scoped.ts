import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfigDirectory } from "../config/paths.js";
import type { DatabaseConfig } from "../types/index.js";

export type ScopedInstructionScope = "global" | "host" | "database";
export type ScopedInstructionAudience = "runtime" | "catalog";

interface ScopedInstructionLayers {
  global?: string;
  host?: string;
  database?: string;
}

export interface ScopedInstructionSource {
  scope: ScopedInstructionScope;
  path: string;
  exists: boolean;
  contentHash?: string;
}

export interface ScopedInstructionBundle {
  audience: ScopedInstructionAudience;
  fingerprint: string | null;
  mergedText: string | null;
  layers: ScopedInstructionLayers;
  sources: ScopedInstructionSource[];
}

type ReservedInstructionSection = "shared" | "runtime" | "catalog";

const RESERVED_INSTRUCTION_SECTIONS = new Set<ReservedInstructionSection>(["shared", "runtime", "catalog"]);
const SCOPED_INSTRUCTION_FILE_NAME = "AGENTS.md";

function sanitizePathFragment(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

function normalizeTableNames(tableNames: readonly (string | null | undefined)[]): string[] {
  return Array.from(
    new Set(
      tableNames
        .map((tableName) => (typeof tableName === "string" ? tableName.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function buildHostScopeFragment(config: Pick<DatabaseConfig, "host" | "port">): string {
  return `${sanitizePathFragment(config.host)}-${config.port}`;
}

function normalizeInstructionText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function createContentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSectionHeading(value: string): ReservedInstructionSection | null {
  const normalized = value.trim().toLowerCase().replace(/:+$/, "");
  return RESERVED_INSTRUCTION_SECTIONS.has(normalized as ReservedInstructionSection)
    ? (normalized as ReservedInstructionSection)
    : null;
}

function splitReservedInstructionSections(value: string): Map<ReservedInstructionSection, string> | null {
  const lines = normalizeInstructionText(value).split("\n");
  const sectionLines = new Map<ReservedInstructionSection, string[]>();
  let sawReservedSection = false;
  let activeSection: ReservedInstructionSection | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    const heading = headingMatch ? normalizeSectionHeading(headingMatch[1]) : null;
    if (heading) {
      sawReservedSection = true;
      activeSection = heading;
      if (!sectionLines.has(heading)) {
        sectionLines.set(heading, []);
      }
      continue;
    }

    if (!activeSection) {
      continue;
    }

    sectionLines.get(activeSection)?.push(line);
  }

  if (!sawReservedSection) {
    return null;
  }

  const sections = new Map<ReservedInstructionSection, string>();
  for (const sectionName of RESERVED_INSTRUCTION_SECTIONS) {
    const sectionText = normalizeInstructionText((sectionLines.get(sectionName) ?? []).join("\n"));
    if (sectionText) {
      sections.set(sectionName, sectionText);
    }
  }

  return sections;
}

function selectScopedInstructionText(rawText: string, audience: ScopedInstructionAudience): string | null {
  const normalized = normalizeInstructionText(rawText);
  if (!normalized) {
    return null;
  }

  const sections = splitReservedInstructionSections(normalized);
  if (!sections) {
    return normalized;
  }

  const audienceSection = audience === "runtime" ? "runtime" : "catalog";
  const selected = [sections.get("shared"), sections.get(audienceSection)].filter((value): value is string => Boolean(value));
  if (!selected.length) {
    return null;
  }

  return normalizeInstructionText(selected.join("\n\n"));
}

function buildScopedInstructionText(audience: ScopedInstructionAudience, layers: ScopedInstructionLayers): string | null {
  const orderedLayers: Array<{ label: string; content: string | undefined }> = [
    { label: "Global instructions", content: layers.global },
    { label: "Host instructions", content: layers.host },
    { label: "Database instructions", content: layers.database },
  ];
  const activeLayers = orderedLayers.filter((layer) => Boolean(layer.content));
  if (!activeLayers.length) {
    return null;
  }

  const purposeLine =
    audience === "catalog"
      ? "Scoped database instructions are active while building the local schema catalog for the current database target."
      : "Scoped database instructions are active for the current database target.";
  return [
    purposeLine,
    "When scoped instructions conflict, apply them with this precedence: database > host > global.",
    ...activeLayers.map((layer) => `${layer.label}:\n${layer.content}`),
  ].join("\n\n");
}

function buildInstructionFingerprint(audience: ScopedInstructionAudience, layers: ScopedInstructionLayers): string | null {
  const fingerprintPayload = {
    audience,
    global: layers.global ?? null,
    host: layers.host ?? null,
    database: layers.database ?? null,
  };
  if (!fingerprintPayload.global && !fingerprintPayload.host && !fingerprintPayload.database) {
    return null;
  }

  return createContentHash(JSON.stringify(fingerprintPayload));
}

export function getScopedInstructionsDirectory(): string {
  return path.join(getConfigDirectory(), "agents");
}

export function getHostInstructionsDirectory(config: Pick<DatabaseConfig, "host" | "port">): string {
  return path.join(getScopedInstructionsDirectory(), buildHostScopeFragment(config));
}

export function getDatabaseInstructionsDirectory(config: Pick<DatabaseConfig, "host" | "port" | "database">): string {
  return path.join(getHostInstructionsDirectory(config), sanitizePathFragment(config.database));
}

export function getGlobalInstructionPath(): string {
  return path.join(getScopedInstructionsDirectory(), SCOPED_INSTRUCTION_FILE_NAME);
}

export function getHostInstructionPath(config: Pick<DatabaseConfig, "host" | "port">): string {
  return path.join(getHostInstructionsDirectory(config), SCOPED_INSTRUCTION_FILE_NAME);
}

export function getDatabaseInstructionPath(config: Pick<DatabaseConfig, "host" | "port" | "database">): string {
  return path.join(getDatabaseInstructionsDirectory(config), SCOPED_INSTRUCTION_FILE_NAME);
}

export function getDatabaseTableInstructionsDirectory(config: Pick<DatabaseConfig, "host" | "port" | "database">): string {
  return path.join(getDatabaseInstructionsDirectory(config), "tables");
}

export function getTableInstructionPath(config: Pick<DatabaseConfig, "host" | "port" | "database">, tableName: string): string {
  return path.join(getDatabaseTableInstructionsDirectory(config), `${sanitizePathFragment(tableName)}.md`);
}

function formatArchiveDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isArchivedTableInstructionFile(fileName: string): boolean {
  return /-delete-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/i.test(fileName);
}

async function buildArchivedTableInstructionPath(
  directoryPath: string,
  fileName: string,
  date: Date,
): Promise<string> {
  const parsed = path.parse(fileName);
  const dateStamp = formatArchiveDate(date);
  let attempt = 0;

  while (true) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidatePath = path.join(directoryPath, `${parsed.name}-delete-${dateStamp}${suffix}${parsed.ext}`);
    try {
      await readFile(candidatePath, "utf8");
      attempt += 1;
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return candidatePath;
      }

      throw error;
    }
  }
}

async function createEmptyFileIfMissing(filePath: string): Promise<boolean> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, "", {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }

    throw error;
  }
}

export async function ensureScopedInstructionFiles(
  config: Pick<DatabaseConfig, "host" | "port" | "database">,
  tableNames: readonly (string | null | undefined)[],
): Promise<string[]> {
  const createdPaths: string[] = [];
  const baseInstructionPaths = [getGlobalInstructionPath(), getHostInstructionPath(config), getDatabaseInstructionPath(config)];

  for (const instructionPath of baseInstructionPaths) {
    if (await createEmptyFileIfMissing(instructionPath)) {
      createdPaths.push(instructionPath);
    }
  }

  const uniqueTableNames = normalizeTableNames(tableNames);

  for (const tableName of uniqueTableNames) {
    const tableInstructionPath = getTableInstructionPath(config, tableName);
    if (await createEmptyFileIfMissing(tableInstructionPath)) {
      createdPaths.push(tableInstructionPath);
    }
  }

  return createdPaths;
}

export async function archiveStaleTableInstructionFiles(
  config: Pick<DatabaseConfig, "host" | "port" | "database">,
  tableNames: readonly (string | null | undefined)[],
  date = new Date(),
): Promise<Array<{ fromPath: string; toPath: string }>> {
  const tablesDirectory = getDatabaseTableInstructionsDirectory(config);
  let entries: string[];
  try {
    entries = await readdir(tablesDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const activeFileNames = new Set(normalizeTableNames(tableNames).map((tableName) => path.basename(getTableInstructionPath(config, tableName))));
  const renamed: Array<{ fromPath: string; toPath: string }> = [];

  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) {
      continue;
    }

    if (activeFileNames.has(entry) || isArchivedTableInstructionFile(entry)) {
      continue;
    }

    const fromPath = path.join(tablesDirectory, entry);
    const toPath = await buildArchivedTableInstructionPath(tablesDirectory, entry, date);
    await rename(fromPath, toPath);
    renamed.push({ fromPath, toPath });
  }

  return renamed;
}

async function loadScopedInstructionSource(
  scope: ScopedInstructionScope,
  targetPath: string,
  audience: ScopedInstructionAudience,
): Promise<{ source: ScopedInstructionSource; selectedText?: string }> {
  try {
    const rawText = await readFile(targetPath, "utf8");
    const selectedText = selectScopedInstructionText(rawText, audience) ?? undefined;
    return {
      source: {
        scope,
        path: targetPath,
        exists: true,
        contentHash: selectedText ? createContentHash(selectedText) : undefined,
      },
      selectedText,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        source: {
          scope,
          path: targetPath,
          exists: false,
        },
      };
    }

    throw error;
  }
}

export async function loadScopedInstructionBundle(
  config: Pick<DatabaseConfig, "host" | "port" | "database">,
  audience: ScopedInstructionAudience,
): Promise<ScopedInstructionBundle> {
  const [globalSource, hostSource, databaseSource] = await Promise.all([
    loadScopedInstructionSource("global", getGlobalInstructionPath(), audience),
    loadScopedInstructionSource("host", getHostInstructionPath(config), audience),
    loadScopedInstructionSource("database", getDatabaseInstructionPath(config), audience),
  ]);
  const layers: ScopedInstructionLayers = {
    global: globalSource.selectedText,
    host: hostSource.selectedText,
    database: databaseSource.selectedText,
  };

  return {
    audience,
    fingerprint: buildInstructionFingerprint(audience, layers),
    mergedText: buildScopedInstructionText(audience, layers),
    layers,
    sources: [globalSource.source, hostSource.source, databaseSource.source],
  };
}
