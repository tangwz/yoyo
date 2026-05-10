import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const buildDir = resolve("build");
const extensionDir = resolve(buildDir, "chrome-mv3");
const manifestPath = resolve(extensionDir, "manifest.json");
const requiredPermissions = ["storage", "contextMenus", "notifications"];
const forbiddenPermissions = ["activeTab", "scripting"];
const forbiddenZipEntries = [
  "src/",
  "tests/",
  "docs/",
  "scripts/",
  ".env",
  ".log",
  ".DS_Store",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Missing build/chrome-mv3/manifest.json. Run pnpm build first.");
    }
    throw new Error(`Could not read build/chrome-mv3/manifest.json: ${error.message}`);
  }
}

function verifyManifest(manifest) {
  const permissions = manifest.permissions ?? [];
  const hostPermissions = manifest.host_permissions ?? [];

  assert(Array.isArray(permissions), "manifest.permissions must be an array.");
  assert(Array.isArray(hostPermissions), "manifest.host_permissions must be an array.");

  for (const permission of requiredPermissions) {
    assert(
      permissions.includes(permission),
      `manifest.permissions must include ${JSON.stringify(permission)}.`,
    );
  }

  for (const permission of forbiddenPermissions) {
    assert(
      !permissions.includes(permission),
      `manifest.permissions must not include ${JSON.stringify(permission)}.`,
    );
  }

  assert(
    hostPermissions.includes("<all_urls>"),
    'manifest.host_permissions must include "<all_urls>".',
  );
}

async function findLatestChromeZip() {
  let entries;
  try {
    entries = await readdir(buildDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Missing build/. Run pnpm build and pnpm zip first.");
    }
    throw new Error(`Could not read build/: ${error.message}`);
  }

  const zipFiles = await Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".zip") && entry.name.includes("chrome"),
      )
      .map(async (entry) => {
        const path = resolve(buildDir, entry.name);
        return { path, name: entry.name, stats: await stat(path) };
      }),
  );

  assert(zipFiles.length > 0, "Missing Chrome zip in build/. Run pnpm zip first.");

  zipFiles.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
  return zipFiles[0];
}

async function listZipEntries(zipPath) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-Z1", zipPath], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.split("\n").filter(Boolean);
  } catch (error) {
    const stderr = error.stderr?.trim();
    const detail = stderr ? ` ${stderr}` : "";
    throw new Error(`Could not list zip entries with "unzip -Z1 ${zipPath}".${detail}`);
  }
}

async function readZipManifest(zipPath, zipName) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", zipPath, "manifest.json"], {
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = error.stderr?.trim();
    const detail = stderr ? ` ${stderr}` : "";
    throw new Error(`Could not read manifest.json from ${zipName}.${detail}`);
  }
}

function isForbiddenEntry(entry) {
  const segments = entry.split("/").filter(Boolean);

  return forbiddenZipEntries.some((forbiddenEntry) => {
    if (forbiddenEntry.endsWith("/")) {
      return segments.includes(forbiddenEntry.slice(0, -1));
    }

    if (forbiddenEntry === ".env") {
      return segments.some((segment) => segment === ".env" || segment.startsWith(".env."));
    }

    if (forbiddenEntry === ".log") {
      return segments.some((segment) => segment.endsWith(".log"));
    }

    return entry === forbiddenEntry || entry.endsWith(`/${forbiddenEntry}`);
  });
}

function verifyZipEntries(entries, zipName) {
  assert(entries.includes("manifest.json"), `${zipName} must contain manifest.json at the zip root.`);

  const forbiddenEntries = entries.filter(isForbiddenEntry);
  assert(
    forbiddenEntries.length === 0,
    `${zipName} contains forbidden review artifacts: ${forbiddenEntries.join(", ")}`,
  );
}

async function main() {
  const manifest = await readManifest();
  verifyManifest(manifest);

  const latestZip = await findLatestChromeZip();
  const zipEntries = await listZipEntries(latestZip.path);
  verifyZipEntries(zipEntries, latestZip.name);
  verifyManifest(await readZipManifest(latestZip.path, latestZip.name));

  console.log(`Release package verified: ${latestZip.name}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
