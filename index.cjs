"use strict";
// The Low's Translator API client.
//
// Written in CommonJS with an ESM shim (index.mjs) rather than the other way
// round, because the audience is Discord bot developers and a large share of
// that ecosystem is still `require`. One implementation, both module systems,
// no build step. A published package that needs compiling is a package whose
// source and its dist can disagree.
//
// No dependencies, and `fetch` is taken from the global. That is what makes
// this run unchanged on Node 18+, Bun, Deno, Cloudflare Workers and in a
// browser; pulling in an HTTP library would cost all of that for nothing.

const VERSION = require("./package.json").version;
const DEFAULT_BASE = "https://lows.gg";

/**
 * An error from the API, or from trying to reach it.
 *
 * `code` is the stable machine-readable string. Match on it, not on `message`,
 * which gets reworded. `status` is 0 when the request never reached the server.
 */
class LowsTranslatorError extends Error {
  constructor(message, { code = "network_error", status = 0, retryAfter = 0, cause } = {}) {
    super(message);
    this.name = "LowsTranslatorError";
    this.code = code;
    this.status = status;
    /** Seconds the server asked us to wait, or 0. */
    this.retryAfter = retryAfter;
    if (cause) this.cause = cause;
  }

  /** Out of characters for the day. Waiting minutes will not help. */
  get isQuotaExhausted() { return this.code === "daily_limit"; }

  /**
   * Worth trying again shortly.
   *
   * An ALLOWLIST, not "status is 0 or 5xx". That test looked right and was
   * wrong: every locally raised error carries status 0, so a missing API key
   * and a missing target language both reported themselves as retryable, and a
   * caller driving its own queue on this property would spin forever on a
   * mistake no amount of waiting fixes.
   *
   * `daily_limit` is deliberately absent. It is a 429 like a throttle, but the
   * window is a day, so retrying is a busy-loop until midnight. `aborted` is
   * absent because the caller asked for the cancellation.
   */
  get isRetryable() {
    if (RETRYABLE_CODES.has(this.code)) return true;
    return this.status >= 500;
  }
}

// The only failures a retry can fix: the request never arrived, or the server
// said it was momentarily unable. Everything else is a fact about the request.
const RETRYABLE_CODES = new Set(["network_error", "timeout", "busy", "unavailable", "bad_response"]);

/** Read one header whether `headers` is a Headers instance or a plain object. */
function readHeader(res, name) {
  const h = res && res.headers;
  if (!h) return null;
  if (typeof h.get === "function") return h.get(name);
  return h[name] ?? h[String(name).toLowerCase()] ?? null;
}

/**
 * Sleep, but wake early if the caller cancels.
 *
 * The backoff between retries can be up to 10s. Waiting it out after the caller
 * has already given up is 10s of a process sitting inside an await for an answer
 * nobody is going to read. Resolving early is enough: the loop re-checks the
 * signal and throws.
 */
const sleep = (ms, signal) => new Promise((resolve) => {
  if (!signal) { setTimeout(resolve, ms); return; }
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
});

class LowsTranslator {
  /**
   * @param {string|object} options An API key, or an options object.
   * @param {string}   options.apiKey   Your key. Also read from LOWS_API_KEY.
   * @param {string}   [options.baseUrl]
   * @param {number}   [options.timeout] Per attempt, ms. Default 30000.
   * @param {number}   [options.retries] Retries for transient failures. Default 2.
   * @param {Function} [options.fetch]   Inject one for tests or a proxy.
   */
  constructor(options = {}) {
    const opts = typeof options === "string" ? { apiKey: options } : options;
    this.apiKey = opts.apiKey || process.env.LOWS_API_KEY || "";
    this.baseUrl = String(opts.baseUrl || process.env.LOWS_API_URL || DEFAULT_BASE).replace(/\/+$/, "");
    // Both clamped, because both had a value that broke the request loop
    // silently: retries -1 skipped the loop body altogether and then threw the
    // uninitialised `last`, which surfaces as a bare `undefined` and tells the
    // caller nothing. timeout 0 aborted every attempt the instant it began.
    this.timeout = Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout : 30_000;
    this.retries = Number.isFinite(opts.retries) && opts.retries >= 0 ? Math.floor(opts.retries) : 2;
    this._fetch = opts.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!this._fetch) {
      throw new LowsTranslatorError(
        "No fetch available. Use Node 18+, or pass { fetch } yourself.",
        { code: "no_fetch" });
    }
  }

  /** @private */
  async _request(path, { method = "GET", body = null, auth = true, signal = null } = {}) {
    const url = this.baseUrl + path;
    const headers = { Accept: "application/json", "User-Agent": `lows-translator/${VERSION}` };
    if (auth) {
      if (!this.apiKey) {
        throw new LowsTranslatorError(
          "No API key. Pass one to the constructor or set LOWS_API_KEY.",
          { code: "no_api_key" });
      }
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (body) headers["Content-Type"] = "application/json";

    let last;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      // Checked at the top of EVERY attempt, not just once before the loop.
      // It covers the caller who passes a signal that is already aborted and
      // the caller who aborts during a backoff sleep, and it means an
      // already-cancelled request costs no fetch call at all. Relying on fetch
      // to notice ctrl.signal was pre-aborted works with a real fetch, which is
      // required to reject, but silently hangs on any injected one that only
      // listens for the abort event.
      if (signal && signal.aborted) {
        throw new LowsTranslatorError("Request cancelled.", { code: "aborted" });
      }
      // A per-ATTEMPT timeout, not a total one: a caller who set 30s wants each
      // try to have 30s, and a shared budget would silently give the last
      // attempt no time at all.
      const ctrl = new AbortController();
      // Which of the two reasons fired matters: our own timeout is worth
      // retrying, a caller cancelling is not. AbortSignal.any would express
      // this in one line and does not exist on Node 18, which the package
      // claims to support, so the wiring is manual.
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.timeout);
      const onCallerAbort = () => ctrl.abort();
      if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      try {
        const res = await this._fetch(url, {
          method, headers, signal: ctrl.signal,
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }

        if (res.ok) {
          if (data == null) {
            throw new LowsTranslatorError("The API returned a non-JSON response.",
              { code: "bad_response", status: res.status });
          }
          return data;
        }

        // Defensive: a hand-rolled fetch (a proxy, a test double, some Workers
        // shims) can hand back plain-object headers. Calling .get on those threw
        // a TypeError that the catch below turned into "network_error",
        // discarding the real code the server actually sent.
        const retryAfter = Number(readHeader(res, "retry-after")) || 0;
        last = new LowsTranslatorError(
          data?.error?.message || `HTTP ${res.status}`,
          { code: data?.error?.code || `http_${res.status}`, status: res.status, retryAfter });
      } catch (e) {
        if (e instanceof LowsTranslatorError) {
          last = e;
        } else {
          const aborted = e?.name === "AbortError";
          const byCaller = aborted && !timedOut;
          last = new LowsTranslatorError(
            byCaller ? "Request cancelled."
              : aborted ? `Timed out after ${this.timeout}ms`
              : `Could not reach ${this.baseUrl}`,
            { code: byCaller ? "aborted" : aborted ? "timeout" : "network_error", cause: e });
        }
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onCallerAbort);
      }

      if (attempt === this.retries || !last.isRetryable) break;
      // Honour Retry-After when the server sent one, otherwise back off. Capped,
      // because an SDK that sleeps for an hour inside await is a hung process.
      const waitMs = last.retryAfter ? Math.min(last.retryAfter * 1000, 10_000) : 400 * 2 ** attempt;
      await sleep(waitMs, signal);
    }
    throw last;
  }

  /**
   * Translate one piece of text.
   *
   * @param {string} text
   * @param {object} options
   * @param {string} options.to     Two-letter target, e.g. "en".
   * @param {string} [options.from] Skip detection by naming the source.
   * @returns {Promise<{text:string, from:string, to:string, engine:string, unchanged:boolean}>}
   */
  async translate(text, options = {}) {
    const to = options.to || options.target || options.targetLang;
    if (!to) throw new LowsTranslatorError("`to` is required.", { code: "no_target" });
    // Checked here rather than at the server. `String(undefined)` is the string
    // "undefined", so a missing argument used to be sent as five real
    // characters, charged for, and translated. The API's own code is reused so
    // a caller matching on `no_text` handles both origins identically.
    if (typeof text !== "string" || !text.trim()) {
      throw new LowsTranslatorError("`text` must be a non-empty string.", { code: "no_text" });
    }
    const from = options.from || options.source || options.sourceLang;

    const data = await this._request("/v1/translate", {
      method: "POST",
      signal: options.signal || null,
      body: { text, target_lang: to, ...(from ? { source_lang: from } : {}) },
    });
    // camelCase out, snake_case on the wire. The wire shape is the API's
    // contract with every language; this is the shape JavaScript expects.
    return {
      text: data.translated_text,
      from: data.source_lang,
      to: data.target_lang,
      engine: data.engine,
      // True when source and target matched, so nothing was translated and
      // nothing was charged. Worth surfacing: a caller looping over a mixed
      // channel wants to know which messages were already readable.
      unchanged: data.source_lang === data.target_lang,
    };
  }

  /**
   * Translate many texts, at most `concurrency` at a time.
   *
   * Convenience only: this is N separate requests against your quota, because
   * the API has no batch endpoint. Results come back in input order.
   *
   * ON FAILURE IT STILL THROWS, but the error carries everything that DID
   * work, on `results` and `failures`. Promise.all semantics alone were wrong
   * here: `undetected` is common on short text, by design and as documented,
   * so a hundred good translations were being discarded because one input was
   * three characters long. Throwing keeps the obvious call site honest;
   * carrying the partials means the work is not lost either way.
   *
   * @param {string[]} texts
   * @param {object} options `to`, `from`, `signal`, and `concurrency` (default 4).
   */
  async translateAll(texts, options = {}) {
    const list = Array.from(texts || []);
    const limit = Math.max(1, Math.min(16, options.concurrency || 4));
    // `concurrency` is ours, not the per-request API's; passing the whole
    // options object straight through leaked it into every translate() call.
    const { concurrency, ...perItem } = options;
    const results = new Array(list.length).fill(null);
    const failures = [];
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        try {
          results[i] = await this.translate(list[i], perItem);
        } catch (e) {
          failures.push({ index: i, text: list[i], error: e });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
    if (failures.length) {
      failures.sort((a, b) => a.index - b.index);
      const first = failures[0];
      const err = new LowsTranslatorError(
        `${failures.length} of ${list.length} failed. First: ${first.error.message}`,
        { code: first.error.code, status: first.error.status, cause: first.error });
      /** Successful translations, at their input index; null where one failed. */
      err.results = results;
      /** Every failure, as { index, text, error }, in input order. */
      err.failures = failures;
      throw err;
    }
    return results;
  }

  /**
   * Every target language, as short codes. Mostly two letters, but not always:
   * "fil" is Filipino. Needs no API key, so you can
   * check coverage before you have one.
   * @returns {Promise<string[]>}
   */
  /**
   * Which language a string is in, without translating it.
   *
   * Free: detection runs offline, so it is not charged against your character
   * allowance and does not consume your quota. Pass an array to classify a
   * backlog in one round trip.
   *
   * The single form THROWS `undetected` when nothing could be determined, which
   * is the 422 the API returns. The batch form does not: one unreadable string
   * in fifty should not fail the other forty-nine, so its entry comes back with
   * `language: null` and the caller decides.
   */
  async detect(text, options = {}) {
    const many = Array.isArray(text);
    const list = many ? text : [text];
    // Same guard as translate(), and the same reason: String(undefined) is the
    // five-character string "undefined", which detects perfectly happily as
    // English and tells the caller nothing true.
    if (!list.length || !list.some((t) => typeof t === "string" && t.trim())) {
      throw new LowsTranslatorError("`text` must be a non-empty string.", { code: "no_text" });
    }
    const data = await this._request("/v1/detect", {
      method: "POST",
      signal: options.signal || null,
      body: many ? { texts: list } : { text },
    });
    const shape = (d) => ({
      /** Two-letter code, lowercase, or null when nothing could be determined. */
      language: d.language ?? null,
      /** 0..1, or null when the model has not finished loading. */
      confidence: d.confidence ?? null,
      /** False for text too short to trust. It may still guess; this says not to lean on it. */
      reliable: Boolean(d.reliable),
    });
    return many ? (data.results || []).map(shape) : shape(data);
  }

  async languages(options = {}) {
    const data = await this._request("/v1/languages", { auth: false, signal: options.signal || null });
    return data.languages || [];
  }

  /**
   * Today's usage for this key.
   * @returns {Promise<{used:number, limit:number, remaining:number, resets:string}>}
   */
  async usage(options = {}) {
    const data = await this._request("/v1/usage", { signal: options.signal || null });
    const used = Number(data.characters_used || 0);
    const limit = Number(data.character_limit || 0);
    return { used, limit, remaining: Math.max(0, limit - used), resets: data.resets };
  }
}

module.exports = { LowsTranslator, LowsTranslatorError, VERSION };
module.exports.default = LowsTranslator;
