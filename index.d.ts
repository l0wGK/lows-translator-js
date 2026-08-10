// Hand-written rather than generated. The surface is four methods; a build step
// to produce this would be more machinery than the thing it describes.

export interface LowsTranslatorOptions {
  /** Your API key. Falls back to process.env.LOWS_API_KEY. */
  apiKey?: string;
  /** Override the API host. Falls back to process.env.LOWS_API_URL. */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Default 30000. */
  timeout?: number;
  /** Retries for transient failures only. Default 2. */
  retries?: number;
  /** Inject a fetch implementation, for tests or a proxy. */
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  /** Cancel an in-flight request. A cancellation is never retried. */
  signal?: AbortSignal;
}

export interface TranslateOptions extends RequestOptions {
  /** Two-letter target language, e.g. "en". */
  to: string;
  /** Two-letter source. Omit to detect. */
  from?: string;
}

export interface TranslateManyOptions extends TranslateOptions {
  /** How many requests in flight at once. 1-16, default 4. */
  concurrency?: number;
}

export interface Translation {
  /** The translated text. */
  text: string;
  /** The source language, detected when you did not pass one. */
  from: string;
  /** The target language. */
  to: string;
  /** Which engine served it. */
  engine: string;
  /** Source and target were the same, so nothing was translated or charged. */
  unchanged: boolean;
}

export interface Detection {
  /** Two-letter code, lowercase, or null when nothing could be determined. */
  language: string | null;
  /** 0..1, or null when the model has not finished loading. */
  confidence: number | null;
  /** False for text too short to trust. It may still guess; this says not to lean on it. */
  reliable: boolean;
}

export interface Usage {
  used: number;
  limit: number;
  remaining: number;
  /** Human-readable, e.g. "daily at 00:00 UTC". */
  resets: string;
}

/** One input that failed inside `translateAll`. */
export interface TranslationFailure {
  /** Position in the array you passed in. */
  index: number;
  text: string;
  error: LowsTranslatorError;
}

/**
 * Match on `code`, never on `message`: messages get reworded, codes do not.
 *
 * Known codes: `no_api_key`, `no_target`, `no_text`, `no_fetch`, `invalid_key`,
 * `unsupported_language`, `too_long`, `undetected`, `daily_limit`, `busy`,
 * `unavailable`, `engine_error`, `timeout`, `aborted`, `network_error`,
 * `bad_response`.
 */
export class LowsTranslatorError extends Error {
  name: "LowsTranslatorError";
  code: string;
  /** HTTP status, or 0 when the request never reached the server. */
  status: number;
  /** Seconds the server asked us to wait, or 0. */
  retryAfter: number;
  /** Out of characters for the day; waiting minutes will not help. */
  readonly isQuotaExhausted: boolean;
  /** Worth trying again shortly. Excludes daily_limit and aborted by design. */
  readonly isRetryable: boolean;
  /** Only on an error from `translateAll`: successes by input index, null where one failed. */
  results?: (Translation | null)[];
  /** Only on an error from `translateAll`: every failure, in input order. */
  failures?: TranslationFailure[];
}

export class LowsTranslator {
  constructor(options?: LowsTranslatorOptions | string);
  apiKey: string;
  baseUrl: string;
  timeout: number;
  retries: number;
  /** Translate one piece of text. */
  translate(text: string, options: TranslateOptions): Promise<Translation>;
  /**
   * Translate many, bounded concurrency. N requests: there is no batch endpoint.
   *
   * Throws if any input fails, but the thrown error carries `results` and
   * `failures` so the successful translations are not lost.
   */
  translateAll(texts: readonly string[], options: TranslateManyOptions): Promise<Translation[]>;
  /** Every target language as short codes, e.g. "sv", "fil". Needs no API key. */
  /**
   * Which language a string is in, without translating it. Free: detection runs
   * offline and is not charged against your character allowance.
   *
   * The single form rejects with `undetected` when nothing could be determined;
   * the batch form returns `language: null` for that entry instead, so one
   * unreadable string does not fail the rest.
   */
  detect(text: string, options?: RequestOptions): Promise<Detection>;
  detect(texts: readonly string[], options?: RequestOptions): Promise<Detection[]>;
  languages(options?: RequestOptions): Promise<string[]>;
  /** Today's usage for this key. */
  usage(options?: RequestOptions): Promise<Usage>;
}

export const VERSION: string;
export default LowsTranslator;
