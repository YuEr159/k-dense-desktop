/**
 * Splash-to-app handover tests.
 *
 * Run against real sockets rather than mocks: the bug this covers is a window
 * that never leaves "Starting local services…", which only reproduces when a
 * service is genuinely unreachable and then becomes reachable.
 *
 *     node --test desktop/test/startup-readiness.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";

import { pollUntilReady } from "../startup-readiness.mjs";

const servers = [];

/** Bind `handler` on an ephemeral loopback port; returns its URL. */
function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

/** A URL nothing is listening on. Bind then close, so the port is free. */
async function deadUrl() {
  const url = await listen(() => {});
  await new Promise((resolve) => servers.pop().close(resolve));
  return url;
}

const ok = (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
};

after(() => {
  for (const server of servers) server.close();
});

describe("pollUntilReady", () => {
  it("waits for the frontend even after the backend answers", async () => {
    // The exact cold-start shape: the backend starts listening seconds before
    // the interface is served, and navigating on the backend alone lands the
    // window on a connection-refused page.
    const backend = await listen(ok);
    const ui = await deadUrl();
    let ready = false;
    const res = pollUntilReady({
      backendUrl: backend,
      uiUrl: ui,
      deadline: Date.now() + 3000,
      pollMs: 25,
    }).then((value) => {
      ready = value;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(ready, false, "must not report ready while the frontend is down");
    assert.equal(await res, false, "and gives up at the deadline");
  });

  it("resolves once both services answer", async () => {
    const backend = await listen(ok);
    const ui = await listen(ok);
    assert.equal(
      await pollUntilReady({
        backendUrl: backend,
        uiUrl: ui,
        deadline: Date.now() + 3000,
        pollMs: 25,
      }),
      true,
    );
  });

  // The window may navigate itself (a user refresh, a recovery page) or be
  // closed while the services are still starting; neither should be followed
  // by a stray load of the app.
  it("stops as soon as the window takes over", async () => {
    const backend = await listen(ok);
    // A dead frontend keeps the loop running long enough to observe the stop.
    const ui = await deadUrl();
    let probes = 0;
    const res = await pollUntilReady({
      backendUrl: backend,
      uiUrl: ui,
      stopped: () => ++probes > 3,
      deadline: Date.now() + 5000,
      pollMs: 10,
    });
    assert.equal(res, false);
    assert.ok(probes <= 5, `stopped probing promptly (saw ${probes})`);
  });

  it("treats a non-2xx answer as not ready", async () => {
    const backend = await listen((_req, res) => {
      res.writeHead(503);
      res.end("starting");
    });
    const ui = await listen(ok);
    assert.equal(
      await pollUntilReady({
        backendUrl: backend,
        uiUrl: ui,
        deadline: Date.now() + 300,
        pollMs: 25,
      }),
      false,
    );
  });

  // A hung backend must not stall the loop: the timeout is what keeps a half-
  // open socket from freezing the splash forever.
  it("times out a probe that never answers", async () => {
    const hang = await listen(() => {});
    const started = Date.now();
    const res = await pollUntilReady({
      backendUrl: hang,
      uiUrl: hang,
      deadline: Date.now() + 600,
      pollMs: 25,
      probe: undefined,
    });
    assert.equal(res, false);
    assert.ok(Date.now() - started < 4000, "did not block past the deadline");
  });

  // The backend serves routes, not a landing page: `GET /` is a 404. Probing
  // the bare origin therefore never succeeded, and every launch sat on the
  // ten-minute deadline issuing two requests a second. The window only came up
  // through `openWindow`'s one-shot probe — which is why a launch that missed
  // it looked like the exe did nothing until the tray was clicked.
  it("probes the backend's liveness endpoint, not its bare origin", async () => {
    const backend = await listen((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const ui = await listen(ok);
    assert.equal(
      await pollUntilReady({
        backendUrl: backend,
        uiUrl: ui,
        deadline: Date.now() + 2000,
        pollMs: 25,
      }),
      true,
      "a backend whose root 404s must still read as ready",
    );
  });
});
