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
