import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = resolve(ROOT, "public");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "4177", 10);
const MAX_BODY = 1024 * 1024;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Request must contain valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function getProviderConfig(provider) {
  if (provider === "openai") {
    return {
      key: process.env.OPENAI_API_KEY,
      model: OPENAI_MODEL,
      url: "https://api.openai.com/v1/chat/completions"
    };
  }
  if (provider === "anthropic") {
    return {
      key: process.env.ANTHROPIC_API_KEY,
      model: ANTHROPIC_MODEL,
      url: "https://api.anthropic.com/v1/messages"
    };
  }
  return null;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    throw new Error("Send between 1 and 40 conversation messages.");
  }
  return messages.map((message) => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new Error("Messages must contain user/assistant roles and text content.");
    }
    const content = message.content.trim();
    if (!content || content.length > 30000) {
      throw new Error("Each message must contain 1 to 30,000 characters.");
    }
    return { role: message.role, content };
  });
}

function sendEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const provider = body.provider;
  const config = getProviderConfig(provider);
  if (!config) return json(res, 400, { error: "Choose a supported provider." });
  if (!config.key) {
    return json(res, 503, {
      error: provider === "openai"
        ? "OPENAI_API_KEY is not configured on the server."
        : "ANTHROPIC_API_KEY is not configured on the server."
    });
  }

  let messages;
  try {
    messages = normalizeMessages(body.messages);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const model = typeof body.model === "string" && body.model.trim().length <= 100
    ? body.model.trim()
    : config.model;
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  let upstream;
  try {
    const isAnthropic = provider === "anthropic";
    const payload = isAnthropic
      ? {
          model,
          max_tokens: 4096,
          stream: true,
          messages
        }
      : {
          model,
          stream: true,
          messages
        };

    upstream = await fetch(config.url, {
      method: "POST",
      headers: isAnthropic
        ? {
            "content-type": "application/json",
            "x-api-key": config.key,
            "anthropic-version": "2023-06-01"
          }
        : {
            "content-type": "application/json",
            authorization: `Bearer ${config.key}`
          },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    return json(res, 502, { error: `Could not reach ${provider}: ${error.message}` });
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    let message = `${provider} API returned HTTP ${upstream.status}.`;
    try {
      const parsed = JSON.parse(detail);
      message = parsed.error?.message || parsed.message || message;
    } catch {
      // Keep the bounded status message rather than echoing arbitrary upstream HTML.
    }
    return json(res, upstream.status, { error: message.slice(0, 1200) });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-content-type-options": "nosniff"
  });

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const event = JSON.parse(raw);
          let delta = "";
          if (provider === "openai") {
            delta = event.choices?.[0]?.delta?.content || "";
          } else if (event.type === "content_block_delta") {
            delta = event.delta?.text || "";
          } else if (event.type === "error") {
            sendEvent(res, { error: event.error?.message || "Anthropic stream error." });
            continue;
          }
          if (delta) sendEvent(res, { delta });
        } catch {
          // Ignore non-JSON keep-alive or provider metadata lines.
        }
      }
    }
    sendEvent(res, { done: true });
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed) {
      sendEvent(res, { error: error.message || "The response stream ended unexpectedly." });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, {
      providers: {
        openai: { configured: Boolean(process.env.OPENAI_API_KEY), defaultModel: OPENAI_MODEL },
        anthropic: { configured: Boolean(process.env.ANTHROPIC_API_KEY), defaultModel: ANTHROPIC_MODEL }
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.host !== req.headers.host) {
          return json(res, 403, { error: "Cross-origin requests are not allowed." });
        }
      } catch {
        return json(res, 403, { error: "Invalid request origin." });
      }
    }
    return handleChat(req, res);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "Method not allowed." });
  }

  let requested;
  try {
    requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  } catch {
    return json(res, 400, { error: "Invalid path encoding." });
  }
  const filePath = resolve(PUBLIC, `.${requested}`);
  const pathFromPublic = relative(PUBLIC, filePath);
  if (pathFromPublic.startsWith("..") || isAbsolute(pathFromPublic)) {
    return json(res, 403, { error: "Forbidden." });
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mime[extname(filePath)] || "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store"
    });
    if (req.method === "HEAD") return res.end();
    return res.end(data);
  } catch {
    return json(res, 404, { error: "Not found." });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`REA AI Studio running at http://${HOST}:${PORT}\n`);
});
