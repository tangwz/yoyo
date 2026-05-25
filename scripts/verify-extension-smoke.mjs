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
const baseUrlLabel = /^(Base URL|接口地址)$/;
const apiKeyLabel = /^(API key|API Key|访问密钥)$/;
const textModelLabel = /^(Text model|Text Model|文本模型)$/;
const openAiCompatibleProviderLabel = /^(OpenAI-compatible provider|OpenAI 兼容服务)$/;
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

async function waitForCondition(predicate, message, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(intervalMs);
  }

  if (lastError instanceof Error) {
    throw new Error(`${message} Last error: ${lastError.message}`);
  }
  throw new Error(message);
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

function extractPromptItems(prompt) {
  const inputIndex = prompt.lastIndexOf("Input:");
  if (inputIndex !== -1) {
    const inputText = prompt.slice(inputIndex + "Input:".length).trim();
    try {
      const parsed = JSON.parse(inputText);
      if (Array.isArray(parsed.items)) {
        return parsed.items
          .map((item) => {
            const id = item?.segmentId ?? item?.id;
            if (typeof id !== "string" || id === "...") {
              return undefined;
            }

            return {
              id,
              text: typeof item?.text === "string" ? item.text : id,
            };
          })
          .filter((item) => item !== undefined);
      }
    } catch {
      // Fall through to regex extraction for older prompt shapes.
    }
  }

  const ids = new Set();
  const pattern = /"(?:segmentId|id)"\s*:\s*"([^"]+)"/g;
  for (const match of prompt.matchAll(pattern)) {
    if (match[1] !== "...") {
      ids.add(match[1]);
    }
  }
  return [...ids].map((id) => ({ id, text: id }));
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
      const items = extractPromptItems(prompt).map((item) => ({
        id: item.id,
        text: `[translated ${item.id}]`,
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

const xLikeFeedHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>X-like feed fixture</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        margin: 0 auto;
        max-width: 720px;
      }
      article {
        border-bottom: 1px solid #ddd;
        padding: 16px 0;
      }
      [data-testid="tweetText"] {
        font-size: 18px;
        line-height: 1.45;
      }
    </style>
  </head>
  <body>
    <main>
      <article data-testid="tweet">
        <div><a href="/author">Terence</a><span>@terence</span><time>1h</time></div>
        <div data-testid="tweetText" lang="en" dir="auto">
          <span>Dynamic feed text should translate quickly.</span>
        </div>
        <div role="group" aria-label="Post actions">
          <button>Reply</button><button>Repost</button><button>Like</button>
        </div>
      </article>
      <article data-testid="tweet">
        <div data-testid="tweetText" lang="en" dir="auto">
          <span>Newly visible short text should translate too.</span>
        </div>
      </article>
    </main>
  </body>
</html>`;

function createArticleServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      url.pathname !== "/article" &&
      url.pathname !== "/lazy-article" &&
      url.pathname !== "/x-like-feed"
    ) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/x-like-feed") {
      response.end(xLikeFeedHtml);
      return;
    }

    if (url.pathname === "/lazy-article") {
      response.end(`<!doctype html>
        <html>
          <head>
            <title>Lazy Smoke Article</title>
            <style>
              body {
                margin: 0;
                font: 18px/1.6 Arial, sans-serif;
              }
              main {
                box-sizing: border-box;
                margin: 0 auto;
                max-width: 720px;
                padding: 32px 24px;
              }
              .spacer {
                height: 360vh;
              }
            </style>
          </head>
          <body>
            <main>
              <h1>Lazy viewport smoke title</h1>
              <p id="lazy-first">Lazy visible first paragraph should translate before the worker restart.</p>
              <div class="spacer" aria-hidden="true"></div>
              <p id="lazy-later">Lazy later paragraph should translate after the worker restart.</p>
            </main>
          </body>
        </html>`);
      return;
    }

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
        lazyUrl: `http://127.0.0.1:${address.port}/lazy-article`,
        xLikeUrl: `http://127.0.0.1:${address.port}/x-like-feed`,
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

async function getTabForUrl(serviceWorker, targetUrl) {
  return serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (!tab?.id) {
      throw new Error(`No tab found for ${url}`);
    }
    return { id: tab.id, windowId: tab.windowId };
  }, targetUrl);
}

async function serviceWorkerTarget(context, extensionId) {
  const browser = context.browser();
  assert(browser, "Browser does not expose a CDP session for service worker control.");

  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.find(
      (target) =>
        target.type === "service_worker" &&
        target.url === `chrome-extension://${extensionId}/background.js`,
    );
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

async function terminateExtensionServiceWorker(context, extensionId) {
  const target = await serviceWorkerTarget(context, extensionId);
  assert(target, "Could not find the extension service worker target to terminate.");

  const browser = context.browser();
  assert(browser, "Browser does not expose a CDP session for service worker termination.");
  const cdp = await browser.newBrowserCDPSession();
  try {
    await cdp.send("Target.closeTarget", { targetId: target.targetId });
  } finally {
    await cdp.detach().catch(() => undefined);
  }

  await waitForCondition(
    async () => !(await serviceWorkerTarget(context, extensionId)),
    "Extension service worker target did not terminate.",
    5000,
  );
}

async function translationSnapshot(page) {
  return page.locator("[data-yoyo-translation]").evaluateAll((nodes) =>
    nodes.map((node) => ({
      segmentId: node.dataset.yoyoSegmentId ?? "",
      pending: node.dataset.yoyoPending === "true",
      text: (node.textContent ?? "").trim(),
    })),
  );
}

function assertUniqueInjectedSegments(snapshot, message) {
  const segmentIds = snapshot.map((item) => item.segmentId);
  const uniqueSegmentIds = new Set(segmentIds);
  assert(
    uniqueSegmentIds.size === segmentIds.length,
    `${message} Segment ids: ${segmentIds.join(", ")}`,
  );
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

    const openAiProviderRadio = optionsPage.getByRole("radio", {
      name: openAiCompatibleProviderLabel,
    });
    if (!(await openAiProviderRadio.isChecked())) {
      await openAiProviderRadio.click();
    }
    await optionsPage.getByLabel(baseUrlLabel).fill(providerServer.baseUrl);
    await optionsPage.getByLabel(apiKeyLabel).fill("smoke-test-key");
    await optionsPage.getByLabel(textModelLabel).fill("mock-model");
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

    await optionsPage.getByLabel(apiKeyLabel).fill("smoke-failing-key");
    await optionsPage.getByRole("button", { name: "测试连接" }).click();
    const failureMessage = optionsPage.getByRole("alert");
    await failureMessage.waitFor({ timeout: 5000 });
    const providerFailureText = (await failureMessage.textContent())?.trim();
    assert(
      providerFailureText === "API Key 无效或无权限。" ||
        providerFailureText === "访问密钥无效或无权限。" ||
        providerFailureText === "The API key is invalid or unauthorized.",
      `Provider failure did not show the bounded unauthorized message: ${providerFailureText}`,
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

    const articleTab = await getTabForUrl(serviceWorker, articlePage.url());

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

    const lazyPage = await context.newPage();
    await lazyPage.goto(articleServer.lazyUrl);
    await lazyPage.waitForSelector("#lazy-first");
    const lazyTab = await getTabForUrl(serviceWorker, lazyPage.url());
    const beforeLazyTranslationRequestCount = countProviderRequests();

    const lazyStartResponse = await optionsPage.evaluate(async (targetTabId) => {
      return chrome.runtime.sendMessage({
        type: "translatePage",
        tabId: targetTabId,
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      });
    }, lazyTab.id);
    assert(
      lazyStartResponse?.type === "taskProgress",
      `Lazy viewport translatePage did not start: ${JSON.stringify(lazyStartResponse)}`,
    );

    const initialLazySnapshot = await waitForCondition(
      async () => {
        const snapshot = await translationSnapshot(lazyPage);
        const translated = snapshot.filter((item) => !item.pending);
        if (translated.length === 0) {
          const progress = await optionsPage.evaluate(async (targetTabId) => {
            return chrome.runtime.sendMessage({
              type: "getTaskForTab",
              tabId: targetTabId,
            });
          }, lazyTab.id);
          throw new Error(
            JSON.stringify({
              snapshot,
              progress,
              providerRequests: countProviderRequests(),
              translationPrompts: promptProbe.translationPrompts.length,
            }),
          );
        }
        return translated.length >= 1 ? snapshot : undefined;
      },
      "Lazy viewport did not inject initial visible translations.",
    );
    assertUniqueInjectedSegments(
      initialLazySnapshot,
      "Lazy viewport duplicated translations before service worker restart.",
    );
    assert(
      (await lazyPage.locator("#lazy-later + [data-yoyo-translation]").count()) === 0,
      "Lazy viewport translated the offscreen segment before scrolling.",
    );

    await terminateExtensionServiceWorker(context, extensionId);
    await lazyPage.locator("#lazy-later").scrollIntoViewIfNeeded();

    const recoveredLazySnapshot = await waitForCondition(
      async () => {
        const laterText = await lazyPage
          .locator("#lazy-later + [data-yoyo-translation]")
          .textContent()
          .catch(() => undefined);
        const snapshot = await translationSnapshot(lazyPage);
        return laterText?.includes("[translated ") ? snapshot : undefined;
      },
      "Lazy viewport did not recover and translate the newly visible segment after service worker restart.",
      15000,
    );
    assertUniqueInjectedSegments(
      recoveredLazySnapshot,
      "Lazy viewport duplicated translations after service worker restart.",
    );
    assert(
      (await lazyPage.locator("#lazy-later + [data-yoyo-translation]").count()) === 1,
      "Lazy viewport injected the recovered segment more than once.",
    );

    await waitForCondition(
      async () => {
        const response = await optionsPage.evaluate(async (targetTabId) => {
          return chrome.runtime.sendMessage({
            type: "getTaskForTab",
            tabId: targetTabId,
          });
        }, lazyTab.id);
        const translatedCount = recoveredLazySnapshot.filter((item) => !item.pending).length;
        if (
          response?.type === "taskProgress" &&
          response.progress.state === "completed" &&
          response.progress.translated === translatedCount
        ) {
          return response;
        }

        throw new Error(
          JSON.stringify({
            response,
            snapshot: recoveredLazySnapshot,
            translatedCount,
          }),
        );
      },
      "Lazy viewport recovery did not complete cleanly.",
      15000,
    );
    assert(
      countProviderRequests() > beforeLazyTranslationRequestCount,
      "Lazy viewport recovery did not send any provider requests.",
    );

    const beforeFeedLoadRequestCount = countProviderRequests();
    const xLikePage = await context.newPage();
    await xLikePage.goto(articleServer.xLikeUrl);
    await xLikePage.waitForSelector('[data-testid="tweetText"]');
    await assertProviderRequestCountStays(
      beforeFeedLoadRequestCount,
      "Loading an X-like feed sent a provider request.",
    );

    const xLikeTab = await getTabForUrl(serviceWorker, xLikePage.url());
    const beforeFeedTranslationRequestCount = countProviderRequests();
    await optionsPage.evaluate(async (targetTabId) => {
      await chrome.runtime.sendMessage({
        type: "translatePage",
        tabId: targetTabId,
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      });
    }, xLikeTab.id);

    const xLikeResult = await waitForCondition(
      async () => {
        const promptItems = promptProbe.requests
          .slice(beforeFeedTranslationRequestCount)
          .flatMap((request) => extractPromptItems(request.prompt));
        const firstTweetItem = promptItems.find(
          (item) => item.text === "Dynamic feed text should translate quickly.",
        );
        const secondTweetItem = promptItems.find(
          (item) => item.text === "Newly visible short text should translate too.",
        );
        if (!firstTweetItem || !secondTweetItem) {
          return undefined;
        }

        const snapshot = await translationSnapshot(xLikePage);
        const translatedText = snapshot
          .filter((item) => !item.pending)
          .map((item) => item.text)
          .join("\n");

        return translatedText.includes(`[translated ${firstTweetItem.id}]`) &&
          translatedText.includes(`[translated ${secondTweetItem.id}]`)
          ? { snapshot }
          : undefined;
      },
      "X-like feed did not inject deterministic tweet text translations.",
      10000,
    );
    const xLikeSnapshot = xLikeResult.snapshot;
    assertUniqueInjectedSegments(
      xLikeSnapshot,
      "X-like feed duplicated injected translations.",
    );
    const translatedFeedText = xLikeSnapshot
      .filter((item) => !item.pending)
      .map((item) => item.text)
      .join("\n");
    assert(
      !translatedFeedText.includes("Reply") &&
        !translatedFeedText.includes("Repost") &&
        !translatedFeedText.includes("Like"),
      "X-like feed smoke must not translate action button labels.",
    );
    const feedTranslationRequests = promptProbe.requests.slice(
      beforeFeedTranslationRequestCount,
    );
    const feedTranslationPromptText = feedTranslationRequests
      .map((request) => request.prompt)
      .join("\n");
    assert(
      !feedTranslationPromptText.includes("Reply") &&
        !feedTranslationPromptText.includes("Repost") &&
        !feedTranslationPromptText.includes("Like"),
      "X-like action labels reached the provider prompt.",
    );
    assert(
      feedTranslationRequests.some(
        (request) =>
          request.prompt.includes("Dynamic feed text should translate quickly.") &&
          request.prompt.includes("Newly visible short text should translate too."),
      ),
      "X-like feed provider request did not include both tweet texts.",
    );
    const xLikeProgressResponse = await optionsPage.evaluate(async (targetTabId) => {
      return chrome.runtime.sendMessage({
        type: "getTaskForTab",
        tabId: targetTabId,
      });
    }, xLikeTab.id);
    if (
      xLikeProgressResponse?.type === "taskProgress" &&
      !["completed", "completedWithErrors", "failed", "cancelled"].includes(
        xLikeProgressResponse.progress.state,
      )
    ) {
      await optionsPage.evaluate(async (taskId) => {
        await chrome.runtime.sendMessage({
          type: "cancelTask",
          taskId,
          reason: "userCancelled",
        });
      }, xLikeProgressResponse.progress.taskId);
    }
    await xLikePage.close();

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
