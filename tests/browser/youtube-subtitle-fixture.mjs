import { createServer } from "node:http";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const fixtureHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>YouTube subtitle fixture</title>
    <style>
      html,
      body {
        margin: 0;
        min-height: 100%;
        background: #0f0f0f;
        color: #f8fafc;
        font: 14px/1.4 Arial, sans-serif;
      }

      #movie_player {
        position: relative;
        width: 960px;
        max-width: calc(100vw - 48px);
        aspect-ratio: 16 / 9;
        margin: 32px auto;
        background: #020617;
        overflow: hidden;
      }

      #movie_player video {
        display: block;
        width: 100%;
        height: 100%;
        background: linear-gradient(135deg, #111827 0%, #1f2937 100%);
      }

      .ytp-chrome-bottom {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 48px;
        background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.78));
      }

      .ytp-right-controls {
        position: absolute;
        right: 12px;
        bottom: 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 160px;
        min-height: 32px;
      }

      .fixture-control {
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.18);
      }
    </style>
  </head>
  <body>
    <main>
      <div id="movie_player" class="html5-video-player">
        <video aria-label="Fixture video" controls></video>
        <div class="ytp-chrome-bottom">
          <div class="ytp-right-controls">
            <button class="fixture-control" aria-label="Settings"></button>
            <button class="fixture-control" aria-label="Theater mode"></button>
          </div>
        </div>
      </div>
    </main>
  </body>
</html>`;

const timedTextJson = {
  events: [
    {
      tStartMs: 0,
      dDurationMs: 1600,
      segs: [{ utf8: "Hello from the fixture." }],
    },
    {
      tStartMs: 1800,
      dDurationMs: 1800,
      segs: [{ utf8: "This payload is reserved for subtitle pipeline coverage." }],
    },
    {
      tStartMs: 5000,
      dDurationMs: 1800,
      segs: [{ utf8: "Later playback text should translate after seeking." }],
    },
  ],
};

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
  if (inputIndex === -1) {
    return [];
  }

  try {
    const parsed = JSON.parse(prompt.slice(inputIndex + "Input:".length).trim());
    if (!Array.isArray(parsed.items)) {
      return [];
    }

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
  } catch {
    return [];
  }
}

export function startYouTubeSubtitleFixtureServer() {
  const probe = {
    timedTextRequests: 0,
    providerRequests: [],
  };

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/api/timedtext") {
      probe.timedTextRequests += 1;
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(timedTextJson));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/chat/completions") {
      try {
        const body = await readJsonBody(request);
        const prompt = body.messages?.[0]?.content ?? "";
        const items = extractPromptItems(prompt).map((item) => ({
          id: item.id,
          text: `[translated ${item.text}]`,
        }));
        probe.providerRequests.push({ prompt, items });

        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(
          JSON.stringify({
            model: body.model ?? "fixture-model",
            choices: [{ message: { content: JSON.stringify({ items }) } }],
          }),
        );
      } catch (error) {
        response.writeHead(500, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(error instanceof Error ? error.message : "Provider failed");
      }
      return;
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/watch") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(fixtureHtml);
      return;
    }

    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("Not found");
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object", "Fixture server did not expose a port.");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      resolveServer({
        url: `${baseUrl}/watch?v=fixture&yoyoSubtitleFixture=1`,
        providerBaseUrl: `${baseUrl}/v1`,
        getTimedTextRequestCount: () => probe.timedTextRequests,
        getProviderRequestCount: () => probe.providerRequests.length,
        getLastProviderRequest: () => probe.providerRequests.at(-1),
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
}
