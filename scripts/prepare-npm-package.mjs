import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const stageDir = path.join(rootDir, ".npm-package");
const distDir = path.join(rootDir, "dist");
const sourcePackagePath = path.join(rootDir, "package.json");
const npmReadmePath = path.join(rootDir, "README.npm.md");
const licensePath = path.join(rootDir, "LICENSE");

const DEFAULT_KEYWORDS = ["cli", "database", "sql", "postgresql", "mysql", "llm", "ai"];
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function prunePublishDist(targetDir) {
  const entries = await readdir(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await prunePublishDist(entryPath);
      continue;
    }

    if (/^test\.(d\.ts|js|js\.map)$/.test(entry.name) || /\.test\.(d\.ts|js|js\.map)$/.test(entry.name)) {
      await rm(entryPath, { force: true });
    }
  }
}

function copyField(target, source, fieldName) {
  if (source[fieldName] !== undefined) {
    target[fieldName] = source[fieldName];
  }
}

function buildPublishManifest(sourcePackage) {
  const publishConfig = {
    ...sourcePackage.publishConfig,
    registry: sourcePackage.publishConfig?.registry ?? OFFICIAL_NPM_REGISTRY,
  };

  if (sourcePackage.name.startsWith("@") && !publishConfig.access) {
    publishConfig.access = "public";
  }

  const manifest = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    description: sourcePackage.description,
    type: sourcePackage.type,
    bin: sourcePackage.bin,
    engines: sourcePackage.engines ?? { node: ">=20" },
    keywords: sourcePackage.keywords ?? DEFAULT_KEYWORDS,
    dependencies: sourcePackage.dependencies ?? {},
    publishConfig,
  };

  for (const fieldName of [
    "author",
    "bugs",
    "contributors",
    "funding",
    "homepage",
    "license",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "repository",
  ]) {
    copyField(manifest, sourcePackage, fieldName);
  }

  return manifest;
}

function collectWarnings(sourcePackage) {
  const warnings = [];

  if (!sourcePackage.license) {
    warnings.push("package.json is missing a license field. Decide on a public license or keep the package intentionally unlicensed before publishing.");
  }

  if (!sourcePackage.repository) {
    warnings.push("package.json is missing repository metadata. Add repository/homepage/bugs URLs before the first public release.");
  }

  if (!sourcePackage.homepage) {
    warnings.push("package.json is missing a homepage field. npm users benefit from a source-repository landing page.");
  }

  if (!sourcePackage.bugs) {
    warnings.push("package.json is missing a bugs field. Add an issue tracker URL so npm users know where to report problems.");
  }

  return warnings;
}

async function main() {
  if (!(await pathExists(distDir))) {
    throw new Error("dist/ does not exist. Run pnpm build before preparing the npm package.");
  }

  if (!(await pathExists(npmReadmePath))) {
    throw new Error("README.npm.md does not exist. Create the npm-specific README before preparing the package.");
  }

  const sourcePackage = JSON.parse(await readFile(sourcePackagePath, "utf8"));
  const publishManifest = buildPublishManifest(sourcePackage);

  await rm(stageDir, { force: true, recursive: true });
  await mkdir(stageDir, { recursive: true });
  await cp(distDir, path.join(stageDir, "dist"), { recursive: true });
  await prunePublishDist(path.join(stageDir, "dist"));
  await cp(npmReadmePath, path.join(stageDir, "README.md"));

  if (await pathExists(licensePath)) {
    await cp(licensePath, path.join(stageDir, "LICENSE"));
  }

  await writeFile(path.join(stageDir, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`, "utf8");

  console.log(`Prepared npm package in ${stageDir}`);

  const warnings = collectWarnings(sourcePackage);
  if (warnings.length) {
    console.warn("Publish metadata still needs review:");
    for (const warning of warnings) {
      console.warn(`- ${warning}`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
