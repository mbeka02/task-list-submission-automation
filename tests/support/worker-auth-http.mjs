// Preloaded only by command tests: real loopback HTTP, synthetic provider data,
// fixed external-origin checks and a controlled clock. Never shipped in the image.

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";

let now = Number(process.env.OAUTH_TEST_NOW ?? 1791363600000);
Date.now = () => now;
const timer = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms >= 1000) {
    // Advance logical time for the command’s awaited polling delay only;
    // transport keep-alive timers are accelerated without changing the clock.
    if (fn.toString().includes("[native code]")) now += ms;
    return timer(fn, 1, ...args);
  }
  return timer(fn, ms, ...args);
};
let polls = 0;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const refreshing =
    raw.includes("refresh_token") && !raw.includes("device_code");
  appendFileSync(process.env.OAUTH_TEST_REQUESTS, `${req.method} ${req.url}\n`);
  let status = 200;
  let body;
  if (req.url === "/oauth/v1/device_authorization")
    body = {
      device_code: "device-secret-canary",
      user_code: "DEMO-1234",
      verification_uri: "https://accounts.larksuite.com/device",
      verification_uri_complete:
        "https://accounts.larksuite.com/device?user_code=DEMO-1234",
      expires_in: 240,
      interval: 1,
    };
  else if (
    req.url === "/oauth/v3/token" &&
    refreshing &&
    process.env.OAUTH_TEST_MODE === "refresh_disconnect"
  ) {
    req.socket.destroy();
    return;
  } else if (req.url === "/oauth/v3/token" && refreshing)
    body = {
      access_token: "renewed-access-canary",
      refresh_token: "renewed-refresh-canary",
      token_type: "Bearer",
      expires_in: 7200,
      refresh_token_expires_in: 604800,
    };
  else if (req.url === "/oauth/v3/token") {
    polls++;
    if (process.env.OAUTH_TEST_MODE === "denied") {
      status = 400;
      body = { error: "access_denied", error_description: "secret-canary" };
    } else if (process.env.OAUTH_TEST_MODE === "disconnect") {
      req.socket.destroy();
      return;
    } else if (process.env.OAUTH_TEST_MODE === "slow_down" && polls === 1) {
      status = 400;
      body = { error: "slow_down" };
    } else if (polls === 1) {
      status = 400;
      body = { error: "authorization_pending" };
    } else
      body = {
        access_token: "access-secret-canary",
        refresh_token: "refresh-secret-canary",
        token_type: "Bearer",
        expires_in: 7200,
        refresh_token_expires_in: 604800,
        scope: "offline_access im:message:readonly",
      };
    if (body?.access_token && process.env.OAUTH_TEST_MODE === "doc_scopes")
      body.scope =
        "offline_access im:message:readonly docs:doc docx:document docs:permission.member:retrieve docs:permission.member:create docs:permission.setting:read docs:permission.setting:write_only";
    if (body?.access_token && process.env.OAUTH_TEST_MODE === "missing_scope")
      body.scope = "offline_access";
    if (body?.access_token && process.env.OAUTH_TEST_MODE === "dpop")
      body.token_type = "DPoP";
    if (body?.access_token && process.env.OAUTH_TEST_MODE === "bad_lifetime")
      body.expires_in = Number.MAX_SAFE_INTEGER;
  } else if (req.url === "/open-apis/authen/v1/user_info")
    body = {
      code: 0,
      data: {
        open_id:
          process.env.OAUTH_TEST_MODE === "wrong_reader"
            ? "ou_other"
            : "ou_reader",
      },
    };
  else {
    status = 500;
    body = {};
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const base = `http://127.0.0.1:${server.address().port}`;
function rewrite(url) {
  const target = new URL(url);
  if (
    !["https://accounts.larksuite.com", "https://open.larksuite.com"].includes(
      target.origin,
    )
  )
    throw new Error("Unexpected external origin");
  return base + target.pathname + target.search;
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => originalFetch(rewrite(url), options);
defaultHttpInstance.interceptors.request.use((request) => {
  request.url = rewrite(request.url);
  request.proxy = false;
  return request;
});
