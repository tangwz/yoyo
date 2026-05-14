import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const buildDir = resolve("build");
const extensionDir = resolve(buildDir, "chrome-mv3");
const manifestPath = resolve(extensionDir, "manifest.json");
const requiredPermissions = ["storage", "contextMenus"];
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
const notificationReachabilitySourcePaths = [
  "entrypoints/background.ts",
  "src/background/contextMenu.ts",
  "src/background/notifications.ts",
  "src/browser/browserApi.ts",
];
const providerTestPrivacySourcePaths = ["src/provider/openAiCompatible.ts"];
const sourceMapPolicyEnv = "YOYO_RELEASE_SOURCE_MAPS";

function normalizePackagePath(path) {
  return path.replace(/^\/+/, "").replace(/^\.\//, "");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isErrnoException(error, code) {
  return error && typeof error === "object" && "code" in error && error.code === code;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      throw new Error("Missing build/chrome-mv3/manifest.json. Run pnpm build first.", {
        cause: error,
      });
    }
    throw new Error(`Could not read build/chrome-mv3/manifest.json: ${getErrorMessage(error)}`, {
      cause: error,
    });
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

function collectManifestRuntimeEntries(manifest) {
  const runtimeEntries = [];

  if (typeof manifest.action?.default_popup === "string") {
    runtimeEntries.push({
      label: "action default_popup",
      path: manifest.action.default_popup,
    });
  }

  if (typeof manifest.options_ui?.page === "string") {
    runtimeEntries.push({
      label: "options page",
      path: manifest.options_ui.page,
    });
  }

  if (typeof manifest.background?.service_worker === "string") {
    runtimeEntries.push({
      label: "background service worker",
      path: manifest.background.service_worker,
    });
  }

  if (Array.isArray(manifest.content_scripts)) {
    manifest.content_scripts.forEach((contentScript, contentScriptIndex) => {
      if (Array.isArray(contentScript.js)) {
        contentScript.js.forEach((path, scriptIndex) => {
          if (typeof path === "string") {
            runtimeEntries.push({
              label: `content_scripts[${contentScriptIndex}].js[${scriptIndex}]`,
              path,
            });
          }
        });
      }

      if (Array.isArray(contentScript.css)) {
        contentScript.css.forEach((path, stylesheetIndex) => {
          if (typeof path === "string") {
            runtimeEntries.push({
              label: `content_scripts[${contentScriptIndex}].css[${stylesheetIndex}]`,
              path,
            });
          }
        });
      }
    });
  }

  return runtimeEntries;
}

function collectManifestIcons(manifest) {
  const icons = [];

  if (manifest.icons && typeof manifest.icons === "object" && !Array.isArray(manifest.icons)) {
    for (const [size, path] of Object.entries(manifest.icons)) {
      if (typeof path === "string") {
        icons.push({ label: `manifest icon ${JSON.stringify(path)}`, path, size });
      }
    }
  }

  if (
    manifest.action?.default_icon &&
    typeof manifest.action.default_icon === "object" &&
    !Array.isArray(manifest.action.default_icon)
  ) {
    for (const [size, path] of Object.entries(manifest.action.default_icon)) {
      if (typeof path === "string") {
        icons.push({ label: `action icon ${JSON.stringify(path)}`, path, size });
      }
    }
  }

  return icons;
}

export function verifyRuntimePackageEntries(manifest, entries, packageName) {
  const entrySet = new Set(entries.map(normalizePackagePath));
  const runtimeEntries = collectManifestRuntimeEntries(manifest);
  const icons = collectManifestIcons(manifest);

  assert(
    typeof manifest.action?.default_popup === "string",
    `${packageName} manifest must declare an action default_popup.`,
  );
  assert(
    typeof manifest.options_ui?.page === "string",
    `${packageName} manifest must declare an options page.`,
  );
  assert(
    typeof manifest.background?.service_worker === "string",
    `${packageName} manifest must declare a background service worker.`,
  );
  assert(
    Array.isArray(manifest.content_scripts) &&
      manifest.content_scripts.some(
        (contentScript) => Array.isArray(contentScript.js) && contentScript.js.length > 0,
      ),
    `${packageName} manifest must declare at least one content script JavaScript entry.`,
  );
  assert(
    typeof manifest.icons?.["128"] === "string",
    `${packageName} manifest must declare icons.128.`,
  );
  assert(icons.length > 0, `${packageName} manifest must declare at least one icon.`);

  for (const runtimeEntry of runtimeEntries) {
    const path = normalizePackagePath(runtimeEntry.path);
    assert(entrySet.has(path), `${packageName} is missing ${runtimeEntry.label} "${path}".`);
  }

  for (const icon of icons) {
    const path = normalizePackagePath(icon.path);
    assert(entrySet.has(path), `${packageName} is missing ${icon.label}.`);
  }
}

function hasSourceMapReference(text) {
  return /[#@]\s*sourceMappingURL\s*=/.test(text);
}

export function verifySourceMapPolicy(entries, packageName, options = {}) {
  const allowSourceMaps = options.allowSourceMaps === true;

  if (allowSourceMaps) {
    return;
  }

  const sourceMapEntries = entries
    .map(normalizePackagePath)
    .filter((entry) => entry.endsWith(".map"));
  const sourceMapReferences = [...(options.packagedTextByEntry ?? new Map()).entries()]
    .filter(([, text]) => hasSourceMapReference(text))
    .map(([entry]) => normalizePackagePath(entry));
  const sourceMapArtifacts = [...new Set([...sourceMapEntries, ...sourceMapReferences])].sort();

  assert(
    sourceMapArtifacts.length === 0,
    `${packageName} contains source map artifacts: ${sourceMapArtifacts.join(", ")}`,
  );
}

function hasNotificationApiCall(source) {
  return /\b(?:browser|chrome)\.notifications\.create\s*\(/.test(source);
}

function hasContextMenuClickPath(source) {
  return (
    /\b(?:browser|chrome)\.contextMenus\.create\s*\(/.test(source) &&
    /\b(?:browser|chrome)\.contextMenus\.onClicked\.addListener\s*\(/.test(source)
  );
}

function hasBackgroundNotificationRoute(source) {
  return (
    /\bonTranslatePageMenuClick\s*\(/.test(source) &&
    /\bnotify(?:ProviderMissing|PageCannotTranslate)\s*\(/.test(source)
  );
}

export function verifyNotificationPermissionReachability(manifest, sourceFiles) {
  const permissions = manifest.permissions ?? [];
  assert(Array.isArray(permissions), "manifest.permissions must be an array.");

  const hasNotificationPermission = permissions.includes("notifications");
  const source = [...sourceFiles.values()].join("\n");

  if (!hasNotificationPermission) {
    assert(
      !hasNotificationApiCall(source),
      'browser.notifications.create is present but manifest.permissions does not include "notifications".',
    );
    return;
  }

  assert(
    hasNotificationApiCall(source),
    'manifest.permissions includes "notifications" but no browser.notifications.create call was found.',
  );
  assert(
    hasContextMenuClickPath(source),
    'manifest.permissions includes "notifications" but no context-menu click path was found.',
  );
  assert(
    hasBackgroundNotificationRoute(source),
    'manifest.permissions includes "notifications" but no context-menu failure notification route was found.',
  );
}

function collectContentScriptJsEntries(manifest) {
  if (!Array.isArray(manifest.content_scripts)) {
    return [];
  }

  return manifest.content_scripts.flatMap((contentScript) =>
    Array.isArray(contentScript.js)
      ? contentScript.js.filter((path) => typeof path === "string").map(normalizePackagePath)
      : [],
  );
}

function findPrivateProviderMarker(text) {
  const markers = [
    { label: "apiKey", pattern: /\bapiKey\b/u },
    { label: "providerProfiles", pattern: /\bproviderProfiles\b/u },
    { label: "yoyo.providerProfiles", pattern: /\byoyo\.providerProfiles\b/u },
    { label: "chrome.storage", pattern: /\bchrome\.storage\b/u },
    { label: "browser.storage", pattern: /\bbrowser\.storage\b/u },
    { label: "storage.local", pattern: /\bstorage\.local\b/u },
  ];

  return markers.find((marker) => marker.pattern.test(text))?.label;
}

export function verifyContentScriptPrivacyBoundary(manifest, packagedTextByEntry, packageName) {
  for (const contentScriptPath of collectContentScriptJsEntries(manifest)) {
    const contentScriptText = packagedTextByEntry.get(contentScriptPath);

    assert(
      typeof contentScriptText === "string",
      `${packageName} content script "${contentScriptPath}" could not be inspected.`,
    );

    const marker = findPrivateProviderMarker(contentScriptText);
    assert(
      marker === undefined,
      `${packageName} content script "${contentScriptPath}" contains private-provider marker "${marker}".`,
    );
  }
}

function getProviderTestConnectionSource(source) {
  const start = source.indexOf("async testConnection");
  const end = source.indexOf("async generateText", start);

  if (start === -1) {
    return "";
  }

  return source.slice(start, end === -1 ? undefined : end);
}

export function verifyProviderTestPrivacy(sourceFiles) {
  const providerSource = sourceFiles.get("src/provider/openAiCompatible.ts") ?? "";
  const testConnectionSource = getProviderTestConnectionSource(providerSource);

  assert(
    /prompt:\s*["']Reply with exactly: ok["']/.test(testConnectionSource) &&
      !/\b(?:sourceText|pageText|extract(?:Page|Readable|Text)?)\b/u.test(testConnectionSource),
    "Provider connection test must send only the fixed smoke-test prompt.",
  );
}

async function findLatestChromeZip() {
  let entries;
  try {
    entries = await readdir(buildDir, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      throw new Error("Missing build/. Run pnpm build and pnpm zip first.", {
        cause: error,
      });
    }
    throw new Error(`Could not read build/: ${getErrorMessage(error)}`, { cause: error });
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
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr).trim()
      : "";
    const detail = stderr ? ` ${stderr}` : "";
    throw new Error(`Could not list zip entries with "unzip -Z1 ${zipPath}".${detail}`, {
      cause: error,
    });
  }
}

async function readZipTextEntries(zipPath, entries) {
  const textEntries = entries.filter((entry) => /\.(?:css|html|js)$/u.test(entry));
  const result = new Map();

  await Promise.all(
    textEntries.map(async (entry) => {
      const { stdout } = await execFileAsync("unzip", ["-p", zipPath, entry], {
        maxBuffer: 10 * 1024 * 1024,
      });
      result.set(entry, stdout);
    }),
  );

  return result;
}

async function readZipManifest(zipPath, zipName) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", zipPath, "manifest.json"], {
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr).trim()
      : "";
    const detail = stderr ? ` ${stderr}` : "";
    throw new Error(`Could not read manifest.json from ${zipName}.${detail}`, { cause: error });
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

async function readNotificationReachabilitySourceFiles() {
  return readSourceFiles(notificationReachabilitySourcePaths);
}

async function readProviderTestPrivacySourceFiles() {
  return readSourceFiles(providerTestPrivacySourcePaths);
}

async function readSourceFiles(paths) {
  const sourceFiles = new Map();

  await Promise.all(
    paths.map(async (path) => {
      sourceFiles.set(path, await readFile(resolve(path), "utf8"));
    }),
  );

  return sourceFiles;
}

function shouldAllowReleaseSourceMaps(env = process.env) {
  return env[sourceMapPolicyEnv] === "allow";
}

async function main() {
  const manifest = await readManifest();
  verifyManifest(manifest);
  verifyNotificationPermissionReachability(
    manifest,
    await readNotificationReachabilitySourceFiles(),
  );
  verifyProviderTestPrivacy(await readProviderTestPrivacySourceFiles());

  const latestZip = await findLatestChromeZip();
  const zipEntries = await listZipEntries(latestZip.path);
  const zipTextEntries = await readZipTextEntries(latestZip.path, zipEntries);
  verifyZipEntries(zipEntries, latestZip.name);
  verifySourceMapPolicy(zipEntries, latestZip.name, {
    allowSourceMaps: shouldAllowReleaseSourceMaps(),
    packagedTextByEntry: zipTextEntries,
  });

  const zipManifest = await readZipManifest(latestZip.path, latestZip.name);
  verifyManifest(zipManifest);
  verifyRuntimePackageEntries(zipManifest, zipEntries, latestZip.name);
  verifyContentScriptPrivacyBoundary(zipManifest, zipTextEntries, latestZip.name);

  console.log(`Release package verified: ${latestZip.name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
