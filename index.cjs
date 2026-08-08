"use strict";
// The Low's Translator API client.
//
// Written in CommonJS with an ESM shim (index.mjs) rather than the other way
// round, because the audience is Discord bot developers and a large share of
// that ecosystem is still `require`. One implementation, both module systems,
// no build step — a published package that needs compiling is a package whose
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
 * `code` is the stable machine-readable string — match on it, not on `message`,
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
   * Deliberately excludes `daily_limit`: it is a 429 like a throttle, but the
   * window is a day, so retrying is a busy-loop until midnight. The retrying is
   * done for you — this is exposed for callers driving their own queue.
   */
  get isRetryable() {
    return this.status === 0 || this.status >= 500 || this.code === "busy" || this.code === "unavailable";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.timeout = Number.isFinite(opts.timeout) ? opts.timeout : 30_000;
    this.retries = Number.isFinite(opts.retries) ? opts.retries : 2;
    this._fetch = opts.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!this._fetch) {
      throw new LowsTranslatorError(
        "No fetch available. Use Node 18+, or pass { fetch } yourself.",
        { code: "no_fetch" });
    }
  }

  /** @private */
  async _request(path, { method = "GET", body = null, auth = true } = {}) {
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
      // A per-ATTEMPT timeout, not a total one: a caller who set 30s wants each
      // try to have 30s, and a shared budget would silently give the last
      // attempt no time at all.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeout);
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

        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        last = new LowsTranslatorError(
          data?.error?.message || `HTTP ${res.status}`,
          { code: data?.error?.code || `http_${res.status}`, status: res.status, retryAfter });
      } catch (e) {
        if (e instanceof LowsTranslatorError) {
          last = e;
        } else {
          const aborted = e?.name === "AbortError";
          last = new LowsTranslatorError(
            aborted ? `Timed out after ${this.timeout}ms` : `Could not reach ${this.baseUrl}`,
            { code: aborted ? "timeout" : "network_error", cause: e });
        }
      } finally {
        clearTimeout(timer);
      }

      if (attempt === this.retries || !last.isRetryable) break;
      // Honour Retry-After when the server sent one, otherwise back off. Capped,
      // because an SDK that sleeps for an hour inside await is a hung process.
      const waitMs = last.retryAfter ? Math.min(last.retryAfter * 1000, 10_000) : 400 * 2 ** attempt;
      await sleep(waitMs);
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
    const from = options.from || options.source || options.sourceLang;

    const data = await this._request("/v1/translate", {
      method: "POST",
      body: { text: String(text), target_lang: to, ...(from ? { source_lang: from } : {}) },
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
   * @param {string[]} texts
   * @param {object} options `to`, `from`, and `concurrency` (default 4).
   */
  async translateAll(texts, options = {}) {
    const list = Array.from(texts || []);
    const limit = Math.max(1, Math.min(16, options.concurrency || 4));
    const out = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await this.translate(list[i], options);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
    return out;
  }

  /**
   * Every target language, as two-letter codes. Needs no API key, so you can
   * check coverage before you have one.
   * @returns {Promise<string[]>}
   */
  async languages() {
    const data = await this._request("/v1/languages", { auth: false });
    return data.languages || [];
  }

  /**
   * Today's usage for this key.
   * @returns {Promise<{used:number, limit:number, remaining:number, resets:string}>}
   */
  async usage() {
    const data = await this._request("/v1/usage");
    const used = Number(data.characters_used || 0);
    const limit = Number(data.character_limit || 0);
    return { used, limit, remaining: Math.max(0, limit - used), resets: data.resets };
  }
}

module.exports = { LowsTranslator, LowsTranslatorError, VERSION };
module.exports.default = LowsTranslator;
