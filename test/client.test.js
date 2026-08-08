// The client, driven against a stub fetch.
//
// Every test here is about a decision that could plausibly be made the other
// way, which is why they exist: what gets retried, what does NOT get retried,
// and what shape the caller sees.
const test = require("node:test");
const assert = require("node:assert/strict");
const { LowsTranslator, LowsTranslatorError } = require("../index.cjs");

/** A fetch stub that plays a queue of scripted responses and records calls. */
function stub(...responses) {
  const calls = [];
  let i = 0;
  const f = async (url, init) => {
    calls.push({ url, init, headers: init?.headers || {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (typeof r === "function") return r();
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h) => (r.headers || {})[String(h).toLowerCase()] ?? null },
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null)),
    };
  };
  f.calls = calls;
  return f;
}

const ok = (body) => ({ status: 200, body });
const fail = (status, code, message = "x", headers) =>
  ({ status, body: { error: { code, message } }, headers });

test("translate returns a camelCase shape over the snake_case wire", async () => {
  const f = stub(ok({ translated_text: "Hey, who are you?", source_lang: "sv", target_lang: "en", engine: "ember" }));
  const lt = new LowsTranslator({ apiKey: "lt_x", fetch: f });
  const r = await lt.translate("Hej, vem är du?", { to: "en" });
  assert.deepEqual(r, { text: "Hey, who are you?", from: "sv", to: "en", engine: "ember", unchanged: false });
  assert.equal(f.calls[0].headers.Authorization, "Bearer lt_x");
  assert.equal(JSON.parse(f.calls[0].init.body).target_lang, "en");
});

test("source_lang is omitted unless you pass one", async () => {
  const f = stub(ok({ translated_text: "a", source_lang: "sv", target_lang: "en", engine: "ember" }));
  const lt = new LowsTranslator({ apiKey: "k", fetch: f });
  await lt.translate("x", { to: "en" });
  assert.equal("source_lang" in JSON.parse(f.calls[0].init.body), false);
  await lt.translate("x", { to: "en", from: "sv" });
  assert.equal(JSON.parse(f.calls[1].init.body).source_lang, "sv");
});

test("same source and target is reported as unchanged", async () => {
  // The API returns the input untouched and charges nothing. A caller looping
  // over a mixed channel needs to tell that apart from a real translation.
  const f = stub(ok({ translated_text: "hello", source_lang: "en", target_lang: "en", engine: "ember" }));
  const r = await new LowsTranslator({ apiKey: "k", fetch: f }).translate("hello", { to: "en" });
  assert.equal(r.unchanged, true);
});

test("a busy queue is retried, and the retry succeeds", async () => {
  const f = stub(
    fail(503, "busy", "Translation queue is busy.", { "retry-after": "0" }),
    ok({ translated_text: "hej", source_lang: "en", target_lang: "sv", engine: "ember" }));
  const lt = new LowsTranslator({ apiKey: "k", fetch: f, retries: 2 });
  assert.equal((await lt.translate("hi", { to: "sv" })).text, "hej");
  assert.equal(f.calls.length, 2);
});

test("A DAILY LIMIT IS NEVER RETRIED", async () => {
  // It is a 429 like a throttle, but the window is a day, so retrying is a
  // busy-loop until midnight, and the SDK doing that on a caller's behalf is
  // far worse than an error they can see.
  const f = stub(fail(429, "daily_limit", "Daily character limit reached.", { "retry-after": "3600" }));
  const lt = new LowsTranslator({ apiKey: "k", fetch: f, retries: 3 });
  const e = await lt.translate("x", { to: "sv" }).then(() => null, (err) => err);
  assert.ok(e instanceof LowsTranslatorError);
  assert.equal(e.code, "daily_limit");
  assert.equal(e.isQuotaExhausted, true);
  assert.equal(e.isRetryable, false);
  assert.equal(f.calls.length, 1, "must not retry a daily cap");
});

test("a bad key is not retried either", async () => {
  const f = stub(fail(401, "invalid_key"));
  const lt = new LowsTranslator({ apiKey: "nope", fetch: f, retries: 3 });
  const e = await lt.translate("x", { to: "sv" }).catch((err) => err);
  assert.equal(e.code, "invalid_key");
  assert.equal(f.calls.length, 1, "a 4xx will not fix itself");
});

test("network failures are retried, then surface as a typed error", async () => {
  let n = 0;
  const f = async () => { n++; throw new TypeError("fetch failed"); };
  const lt = new LowsTranslator({ apiKey: "k", fetch: f, retries: 1 });
  const e = await lt.translate("x", { to: "sv" }).catch((err) => err);
  assert.equal(n, 2);
  assert.equal(e.code, "network_error");
  assert.equal(e.status, 0);
  assert.ok(e.cause instanceof TypeError, "the original error is kept as cause");
});

test("a missing key fails before any request is made", async () => {
  const f = stub(ok({}));
  const lt = new LowsTranslator({ apiKey: "", fetch: f });
  const e = await lt.translate("x", { to: "sv" }).catch((err) => err);
  assert.equal(e.code, "no_api_key");
  assert.equal(f.calls.length, 0, "no point spending a round trip to be told");
});

test("languages needs no key", async () => {
  const f = stub(ok({ languages: ["en", "sv"] }));
  const lt = new LowsTranslator({ apiKey: "", fetch: f });
  assert.deepEqual(await lt.languages(), ["en", "sv"]);
  assert.equal(f.calls[0].headers.Authorization, undefined);
});

test("usage adds the remaining figure the API does not send", async () => {
  const f = stub(ok({ characters_used: 1500, character_limit: 500000, resets: "daily at 00:00 UTC" }));
  const u = await new LowsTranslator({ apiKey: "k", fetch: f }).usage();
  assert.deepEqual(u, { used: 1500, limit: 500000, remaining: 498500, resets: "daily at 00:00 UTC" });
});

test("translateAll keeps input order despite running concurrently", async () => {
  // The whole risk of a concurrency pool is results coming back shuffled.
  let n = 0;
  const f = async () => {
    const i = n++;
    await new Promise((r) => setTimeout(r, (5 - i) * 6));   // later items finish FIRST
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ translated_text: "t" + i, source_lang: "en", target_lang: "sv", engine: "ember" }),
    };
  };
  const lt = new LowsTranslator({ apiKey: "k", fetch: f });
  const out = await lt.translateAll(["a", "b", "c", "d", "e"], { to: "sv", concurrency: 5 });
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((r) => r.text), ["t0", "t1", "t2", "t3", "t4"]);
});

test("a missing target is refused locally", async () => {
  const f = stub(ok({}));
  const e = await new LowsTranslator({ apiKey: "k", fetch: f }).translate("x", {}).catch((err) => err);
  assert.equal(e.code, "no_target");
  assert.equal(f.calls.length, 0);
});

test("the constructor takes a bare key string", async () => {
  assert.equal(new LowsTranslator("lt_abc").apiKey, "lt_abc");
});

test("HTML from a proxy is an error, not a silent undefined", async () => {
  const f = stub({ status: 200, body: "<html>504 Gateway Timeout</html>" });
  const e = await new LowsTranslator({ apiKey: "k", fetch: f }).languages().catch((err) => err);
  assert.equal(e.code, "bad_response");
});

// Everything below is a regression test. Each one is a bug that shipped in the
// first draft and was only found by running the client rather than reading it.

test("isRetryable does not invite a retry that can never work", () => {
  // The original test was "status is 0 or 5xx". Every locally raised error
  // carries status 0, so a missing key reported itself as retryable and a
  // caller driving its own queue on this property would spin forever.
  for (const code of ["no_api_key", "no_target", "no_text", "aborted", "invalid_key", "daily_limit"]) {
    assert.equal(new LowsTranslatorError("x", { code }).isRetryable, false, code);
  }
  for (const code of ["network_error", "timeout", "busy", "unavailable", "bad_response"]) {
    assert.equal(new LowsTranslatorError("x", { code }).isRetryable, true, code);
  }
  // An unrecognised server-side 5xx is still worth another go.
  assert.equal(new LowsTranslatorError("x", { code: "http_502", status: 502 }).isRetryable, true);
});

test("nonsense constructor options cannot break the request loop", async () => {
  // retries -1 skipped the loop body and threw the uninitialised `last`, which
  // reaches the caller as a bare `undefined`. timeout 0 aborted instantly.
  for (const opts of [{ retries: -1 }, { timeout: 0 }, { retries: 1.7 }, { timeout: -5 }]) {
    const lt = new LowsTranslator({ apiKey: "k", fetch: async () => { throw new Error("net"); }, ...opts });
    const e = await lt.languages().catch((err) => err);
    assert.ok(e instanceof LowsTranslatorError, `${JSON.stringify(opts)} threw ${e}`);
  }
  assert.equal(new LowsTranslator({ apiKey: "k", retries: 1.7 }).retries, 1);
  assert.equal(new LowsTranslator({ apiKey: "k", timeout: 0 }).timeout, 30000);
});

test("empty or non-string text costs no round trip", async () => {
  // String(undefined) is the string "undefined", so a missing argument used to
  // be sent as five real characters, charged for, and translated.
  const f = stub(ok({ translated_text: "", source_lang: "en", target_lang: "sv", engine: "ember" }));
  const lt = new LowsTranslator({ apiKey: "k", fetch: f });
  for (const bad of [undefined, null, "", "   ", 42, {}]) {
    const e = await lt.translate(bad, { to: "sv" }).catch((err) => err);
    assert.equal(e.code, "no_text", `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(f.calls.length, 0);
});

test("a hand-rolled fetch with plain-object headers keeps the server's code", async () => {
  // Test doubles, proxies and some Workers shims hand back plain objects.
  // Calling .get on those threw a TypeError that the catch turned into
  // "network_error", discarding the real code the server actually sent.
  const f = async () => ({
    ok: false, status: 503, headers: { "retry-after": "0" },
    text: async () => JSON.stringify({ error: { code: "busy", message: "b" } }),
  });
  const e = await new LowsTranslator({ apiKey: "k", fetch: f, retries: 0 }).languages().catch((err) => err);
  assert.equal(e.code, "busy");
  assert.equal(e.retryAfter, 0);
});

test("a caller can cancel, and the cancellation is not retried", async () => {
  const ac = new AbortController();
  let tries = 0;
  const f = async (_url, init) => new Promise((_, reject) => {
    tries++;
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  setTimeout(() => ac.abort(), 20);
  const lt = new LowsTranslator({ apiKey: "k", fetch: f, retries: 3 });
  const e = await lt.translate("hello", { to: "sv", signal: ac.signal }).catch((err) => err);
  assert.equal(e.code, "aborted");
  assert.equal(tries, 1, "the caller asked for this, so do not try again");
});

test("an already-aborted signal is honoured immediately", async () => {
  const ac = new AbortController();
  ac.abort();
  const f = async (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("a"), { name: "AbortError" })));
  });
  const e = await new LowsTranslator({ apiKey: "k", fetch: f, retries: 2 })
    .translate("hi", { to: "sv", signal: ac.signal }).catch((err) => err);
  assert.equal(e.code, "aborted");
});

test("cancelling during a backoff wakes immediately instead of waiting it out", async () => {
  // The server asked for 10s. Sitting inside that await after the caller has
  // given up is 10s of a process waiting for an answer nobody will read.
  const f = stub(fail(503, "busy", "queue", { "retry-after": "10" }));
  const ac = new AbortController();
  const lt = new LowsTranslator({ apiKey: "k", fetch: f, retries: 2 });
  const started = Date.now();
  setTimeout(() => ac.abort(), 30);
  const e = await lt.translate("hi", { to: "sv", signal: ac.signal }).catch((err) => err);
  assert.equal(e.code, "aborted");
  assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started}ms of the 10s backoff`);
  assert.equal(f.calls.length, 1, "and does not start another attempt");
});

test("our own timeout is told apart from a cancellation, and IS retried", async () => {
  let tries = 0;
  const f = async (_url, init) => new Promise((_, reject) => {
    tries++;
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "AbortError" })));
  });
  const lt = new LowsTranslator({ apiKey: "k", fetch: f, retries: 1, timeout: 20 });
  const e = await lt.translate("hello", { to: "sv" }).catch((err) => err);
  assert.equal(e.code, "timeout");
  assert.equal(tries, 2, "a timeout is transient, unlike a cancellation");
});

test("translateAll throws on failure but keeps the work that succeeded", async () => {
  // `undetected` is common on short text, by design and as documented. Plain
  // Promise.all semantics were discarding a hundred good translations because
  // one input was three characters long.
  let n = 0;
  const f = async () => {
    const i = n++;
    return i === 1
      ? { ok: false, status: 422, headers: { get: () => null },
          text: async () => JSON.stringify({ error: { code: "undetected", message: "too short" } }) }
      : { ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ translated_text: "t" + i, source_lang: "sv", target_lang: "en", engine: "ember" }) };
  };
  const lt = new LowsTranslator({ apiKey: "k", fetch: f, retries: 0 });
  const e = await lt.translateAll(["a", "b", "c", "d"], { to: "en", concurrency: 1 }).catch((err) => err);
  assert.equal(e.code, "undetected");
  assert.equal(e.results.filter(Boolean).length, 3, "the successes must survive");
  assert.equal(e.results[1], null, "the gap sits at the input index that failed");
  assert.equal(e.failures.length, 1);
  assert.equal(e.failures[0].index, 1);
  assert.equal(e.failures[0].text, "b");
  assert.equal(e.failures[0].error.code, "undetected");
});

test("concurrency is not leaked into the request body", async () => {
  // It is ours, not the API's. Passing the whole options object straight
  // through put it in every translate() call.
  const f = stub(ok({ translated_text: "a", source_lang: "sv", target_lang: "en", engine: "ember" }));
  await new LowsTranslator({ apiKey: "k", fetch: f }).translateAll(["x"], { to: "en", concurrency: 3 });
  assert.deepEqual(Object.keys(JSON.parse(f.calls[0].init.body)).sort(), ["target_lang", "text"]);
});
