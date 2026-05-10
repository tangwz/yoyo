import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const extensionPath = resolve("build/chrome-mv3");
const keepOpen = process.env.YOYO_SMOKE_KEEP_OPEN === "1";
const detachBrowser = process.env.YOYO_SMOKE_DETACH_BROWSER === "1";
const promptProbe = {
  connectionTestPrompt: "",
  translationPrompts: [],
  requests: [],
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(raw || "{}"));
      } catch (error) {
        rejectBody(error);
      }
    });
    request.on("error", rejectBody);
  });
}

function extractSegmentIds(prompt) {
  const ids = new Set();
  const pattern = /"segmentId"\s*:\s*"([^"]+)"/g;
  for (const match of prompt.matchAll(pattern)) {
    ids.add(match[1]);
  }
  return [...ids];
}

function countProviderRequests() {
  return promptProbe.requests.length;
}

function lastProviderRequest() {
  return promptProbe.requests.at(-1);
}

function assertProviderRequestCount(expected, message) {
  const actual = countProviderRequests();
  assert(actual === expected, `${message} Expected ${expected}, got ${actual}.`);
}

async function assertProviderRequestCountStays(expected, message, durationMs = 500) {
  const deadline = Date.now() + durationMs;

  while (Date.now() < deadline) {
    assertProviderRequestCount(expected, message);
    await delay(50);
  }

  assertProviderRequestCount(expected, message);
}

function assertNoProviderPromptIncludes(snippets, message) {
  const leakedSnippet = promptProbe.requests
    .map((request) => request.prompt)
    .find((prompt) => snippets.some((snippet) => prompt.includes(snippet)));
  assert(!leakedSnippet, message);
}

function createMockProviderServer() {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    try {
      const body = await readJsonBody(request);
      const prompt = body.messages?.[0]?.content ?? "";
      const authorization = request.headers.authorization ?? "";
      promptProbe.requests.push({
        prompt,
        authorization,
      });

      if (authorization === "Bearer smoke-failing-key") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message:
                "Unauthorized for sk-secret-token at https://private.example.com/v1/chat/completions",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }

      if (prompt === "Reply with exactly: ok") {
        promptProbe.connectionTestPrompt = prompt;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: body.model ?? "mock-model",
            choices: [{ message: { content: "ok" } }],
          }),
        );
        return;
      }

      promptProbe.translationPrompts.push(prompt);
      const items = extractSegmentIds(prompt).map((segmentId) => ({
        segmentId,
        translatedText: `[translated ${segmentId}]`,
      }));

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: body.model ?? "mock-model",
          choices: [{ message: { content: JSON.stringify({ items }) } }],
        }),
      );
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : "Mock provider failed");
    }
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object", "Mock provider did not expose a port.");
      resolveServer({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
}

function getFreePort() {
  const server = createServer();

  return new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address !== "object") {
          rejectPort(new Error("Could not allocate a debugging port."));
          return;
        }

        resolvePort(address.port);
      });
    });
  });
}

async function waitForCdpEndpoint(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        return endpoint;
      }
    } catch {
      // Chrome is still starting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error("Timed out waiting for detached Chrome debugging endpoint.");
}

function createArticleServer() {
  const server = createServer((request, response) => {
    if (request.url !== "/article") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Smoke Article</title></head>
        <body>
          <main>
            <h1>Smoke test title</h1>
            <p>The first paragraph should be translated by the extension.</p>
            <p>The second paragraph keeps the page realistic.</p>
            <pre>const code = "must stay untouched";</pre>
          </main>
        </body>
      </html>`);
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object", "Article server did not expose a port.");
      resolveServer({
        url: `http://127.0.0.1:${address.port}/article`,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
}

function findChromeExecutable() {
  const candidates = [
    process.env.YOYO_CHROME_EXECUTABLE,
    join(
      homedir(),
      "Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

async function getExtensionServiceWorker(context) {
  let serviceWorker = context.serviceWorkers().find((worker) =>
    worker.url().endsWith("/background.js"),
  );
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", {
      predicate: (worker) => worker.url().endsWith("/background.js"),
      timeout: 10000,
    });
  }

  const match = serviceWorker.url().match(/^chrome-extension:\/\/([^/]+)\//);
  assert(match, `Could not read extension id from service worker URL: ${serviceWorker.url()}`);
  return { extensionId: match[1], serviceWorker };
}

async function findExtensionPage(context, extensionId, pathPrefix, timeout = 5000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const page = context
      .pages()
      .find((candidate) =>
        candidate.url().startsWith(`chrome-extension://${extensionId}/${pathPrefix}`),
      );
    if (page) {
      return page;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  return undefined;
}

async function openActionPopup(serviceWorker, windowId) {
  const result = await serviceWorker.evaluate(async (targetWindowId) => {
    try {
      await chrome.action.openPopup({ windowId: targetWindowId });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, windowId);

  assert(result.ok, `Could not open extension action popup: ${result.message}`);
}

async function main() {
  assert(existsSync(extensionPath), "Missing build/chrome-mv3. Run pnpm build first.");

  const [providerServer, articleServer, userDataDir] = await Promise.all([
    createMockProviderServer(),
    createArticleServer(),
    mkdtemp(join(tmpdir(), "yoyo-extension-smoke-")),
  ]);

  let context;
  let browser;
  let leaveBrowserOpen = false;
  try {
    const executablePath = findChromeExecutable();
    if (detachBrowser) {
      assert(executablePath, "Detached mode requires a Chrome executable.");
      const debuggingPort = await getFreePort();
      const chromeProcess = spawn(
        executablePath,
        [
          `--user-data-dir=${userDataDir}`,
          `--remote-debugging-port=${debuggingPort}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-features=DisableLoadExtensionCommandLineSwitch",
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          "about:blank",
        ],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      chromeProcess.unref();

      browser = await chromium.connectOverCDP(await waitForCdpEndpoint(debuggingPort));
      context = browser.contexts()[0];
      assert(context, "Detached Chrome did not expose a browser context.");
    } else {
      const launchOptions = executablePath
        ? { executablePath }
        : { channel: process.env.YOYO_CHROME_CHANNEL ?? "chrome" };

      context = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        headless: false,
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          "--disable-features=DisableLoadExtensionCommandLineSwitch",
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
        ],
      });
    }

    const { extensionId, serviceWorker } = await getExtensionServiceWorker(context);
    assertProviderRequestCount(0, "Provider received a request before any UI interaction.");

    const firstRunPopupPage = await context.newPage();
    await firstRunPopupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await firstRunPopupPage
      .getByText("需要先配置 Provider，正在打开设置页面...")
      .waitFor({ timeout: 5000 });
    await firstRunPopupPage.getByRole("button", { name: "打开设置" }).waitFor({ timeout: 5000 });
    await assertProviderRequestCountStays(0, "First-run popup sent a provider request.");

    const optionsPage = await findExtensionPage(context, extensionId, "options.html");
    assert(optionsPage, "First-run popup did not open the options page.");
    assert(
      optionsPage.url().includes("options.html") &&
        optionsPage.url().includes("section=provider") &&
        optionsPage.url().includes("source=first-run"),
      `First-run options URL did not include provider routing params: ${optionsPage.url()}`,
    );
    await firstRunPopupPage.close().catch(() => undefined);

    await optionsPage.getByLabel("Base URL").fill(providerServer.baseUrl);
    await optionsPage.getByLabel("API Key").fill("smoke-test-key");
    await optionsPage.getByLabel("Text Model").fill("mock-model");
    await optionsPage.getByRole("button", { name: "保存翻译服务" }).click();
    await optionsPage.getByText("已保存翻译服务。").waitFor({ timeout: 5000 });
    await assertProviderRequestCountStays(0, "Saving provider settings sent a provider request.");

    await optionsPage.getByRole("button", { name: "测试连接" }).click();
    await optionsPage.getByText("测试成功。").waitFor({ timeout: 5000 });
    assert(
      promptProbe.connectionTestPrompt === "Reply with exactly: ok",
      "Provider test did not use the fixed connection-test prompt.",
    );
    assertProviderRequestCount(1, "Provider test should be the first and only provider request.");
    assert(
      lastProviderRequest()?.prompt === "Reply with exactly: ok",
      "Provider test request did not contain the fixed connection-test prompt.",
    );

    await optionsPage.getByLabel("API Key").fill("smoke-failing-key");
    await optionsPage.getByRole("button", { name: "测试连接" }).click();
    const failureMessage = optionsPage.getByRole("alert");
    await failureMessage.waitFor({ timeout: 5000 });
    assert(
      (await failureMessage.textContent())?.trim() === "API Key 无效或无权限。",
      "Provider failure did not show the bounded unauthorized message.",
    );
    const optionsTextAfterFailure = (await optionsPage.textContent("body")) ?? "";
    assert(
      !optionsTextAfterFailure.includes("sk-secret-token") &&
        !optionsTextAfterFailure.includes("private.example.com"),
      "Provider failure leaked sensitive response details into the options page.",
    );

    const storageSnapshot = await optionsPage.evaluate(async () => {
      const local = await chrome.storage.local.get(["yoyo.providerProfiles", "yoyo.activeProviderId"]);
      const sync = await chrome.storage.sync.get(["yoyo.providerProfiles", "yoyo.activeProviderId"]);
      return { local, sync };
    });
    assert(
      Array.isArray(storageSnapshot.local["yoyo.providerProfiles"]),
      "Provider profile was not saved to chrome.storage.local.",
    );
    assert(
      storageSnapshot.sync["yoyo.providerProfiles"] === undefined &&
        storageSnapshot.sync["yoyo.activeProviderId"] === undefined,
      "Provider profile data leaked into chrome.storage.sync.",
    );

    const beforeArticleLoadRequestCount = countProviderRequests();
    const articlePage = detachBrowser
      ? (context.pages().find((page) => page !== optionsPage && page.url() === "about:blank") ??
        (await context.newPage()))
      : await context.newPage();
    await articlePage.goto(articleServer.url);
    await articlePage.waitForSelector("main p");
    await assertProviderRequestCountStays(
      beforeArticleLoadRequestCount,
      "Loading a readable article sent a provider request.",
    );

    const articleTab = await serviceWorker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url === targetUrl);
      if (!tab?.id) {
        throw new Error(`No article tab found for ${targetUrl}`);
      }
      return { id: tab.id, windowId: tab.windowId };
    }, articlePage.url());

    const beforePopupRequestCount = countProviderRequests();
    await articlePage.bringToFront();
    await openActionPopup(serviceWorker, articleTab.windowId);
    await assertProviderRequestCountStays(
      beforePopupRequestCount,
      "Opening the action popup for a readable article sent a provider request.",
    );

    const beforeEstimateRequestCount = countProviderRequests();
    const estimateResponse = await optionsPage.evaluate(async (targetTabId) => {
      return chrome.tabs.sendMessage(targetTabId, {
        type: "estimatePage",
      });
    }, articleTab.id);
    assert(
      estimateResponse?.type === "estimatePageResult",
      "Page estimate did not return an estimate result.",
    );
    await assertProviderRequestCountStays(
      beforeEstimateRequestCount,
      "Page estimate sent a provider request.",
    );
    assertNoProviderPromptIncludes(
      [
        "Smoke test title",
        "The first paragraph should be translated by the extension.",
        "The second paragraph keeps the page realistic.",
      ],
      "Article text reached the provider before explicit translation.",
    );

    const beforeTranslationRequestCount = countProviderRequests();
    await optionsPage.evaluate(async (targetTabId) => {
      await chrome.runtime.sendMessage({
        type: "translatePage",
        tabId: targetTabId,
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      });
    }, articleTab.id);

    await articlePage
      .locator("[data-yoyo-translation]")
      .first()
      .waitFor({ timeout: 10000 });
    const translationCount = await articlePage.locator("[data-yoyo-translation]").count();
    const codeText = await articlePage.locator("pre").textContent();
    assert(translationCount >= 2, `Expected translations to be injected, got ${translationCount}.`);
    assert(
      codeText === 'const code = "must stay untouched";',
      "Code block content changed during smoke test.",
    );
    assert(
      promptProbe.translationPrompts.length > 0,
      "No translation prompt reached the mock provider.",
    );
    assert(
      countProviderRequests() > beforeTranslationRequestCount,
      "Explicit translation did not increment provider request count.",
    );
    const translationRequests = promptProbe.requests.slice(beforeTranslationRequestCount);
    assert(
      translationRequests.some(
        (request) =>
          request.prompt.includes("Smoke test title") &&
          request.prompt.includes("The first paragraph should be translated by the extension."),
      ),
      "Translation provider request did not include article text after explicit translation.",
    );
    const runtimeState = await optionsPage.evaluate(async (targetTabId) => {
      return chrome.tabs.sendMessage(targetTabId, {
        type: "getPageRuntimeState",
      });
    }, articleTab.id);
    assert(
      runtimeState?.type === "pageRuntimeState" && runtimeState.hasTranslations === true,
      "Article tab did not report existing translations after injection.",
    );
    const beforeExistingPopupRequestCount = countProviderRequests();
    await articlePage.bringToFront();
    await openActionPopup(serviceWorker, articleTab.windowId);
    await assertProviderRequestCountStays(
      beforeExistingPopupRequestCount,
      "Opening the action popup for existing translations sent a provider request.",
    );
    if (detachBrowser) {
      await optionsPage.close().catch(() => undefined);
    }
    await articlePage.bringToFront();

    console.log("Extension smoke test passed.");
    console.log(`Extension id: ${extensionId}`);
    console.log(`Injected translations: ${translationCount}`);

    if (detachBrowser) {
      leaveBrowserOpen = true;
      console.log("Chrome is ready for acceptance and will remain open.");
      return;
    }

    if (keepOpen) {
      console.log("Chrome is ready for acceptance. Close the browser or stop this process when done.");
      await new Promise(() => undefined);
    }
  } finally {
    if (!keepOpen && !leaveBrowserOpen) {
      await context?.close();
    }

    await Promise.allSettled([
      providerServer.close(),
      articleServer.close(),
      leaveBrowserOpen
        ? Promise.resolve()
        : rm(userDataDir, { recursive: true, force: true }),
    ]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
