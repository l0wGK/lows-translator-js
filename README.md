# lows-translator

Translation that speaks chat.

Mentions, custom emoji and markdown come back **intact** instead of mangled, because this was built for messages rather than documents. If you have ever written regex to mask `<@123>` before calling a translation API and unmask it afterwards, this is that step deleted.

```bash
npm install lows-translator
```

```js
import { LowsTranslator } from "lows-translator";

const lt = new LowsTranslator(process.env.LOWS_API_KEY);

const r = await lt.translate(
  "Hej <@1234>, vet du när eventet börjar? <:kek:987654321>",
  { to: "en", from: "sv" },
);
console.log(r.text);
// "Hey <@1234>, do you know when the event starts? <:kek:987654321>"
```

That output is real, not illustrative. The mention and the custom emoji came back byte for byte.

**What survives a translation:**

| | |
|---|---|
| `<@1234>` `<@!1234>` `<@&1234>` | user and role mentions |
| `<#1234>` | channel links |
| `<:name:1234>` `<a:name:1234>` | custom and animated emoji |
| `<t:1234:R>` | timestamps |
| `**bold**` `*italic*` `~~strike~~` `||spoiler||` | markdown |
| `` `code` `` and fenced blocks | code |
| `https://…` | URLs |
| `[[double brackets]]` | kept in the ORIGINAL language, brackets removed |

That last one is a lever the others do not give you. Wrap a product name, a command or a username in `[[ ]]` and it comes out untranslated:

```js
await lt.translate("Vi använder [[Low Translator]] i alla kanaler nu",
  { to: "en", from: "sv" });
// "We use Low Translator in all channels now"
```

`require` works too. This ships both module formats from one implementation:

```js
const { LowsTranslator } = require("lows-translator");
```

## Why not just use DeepL

You might well use DeepL. This is for one specific case they do not serve: **chat text with syntax in it**.

|  | Chat entities | Free ceiling |
|---|---|---|
| Most translation APIs | mangled, so you mask and unmask yourself | metered from the first character |
| lows-translator | preserved | generous, on our own hardware |

We run our own engine, so the marginal cost of a translation is electricity rather than a per-character bill. That is why the free tier is a real one.

## API

### `new LowsTranslator(options)`

```js
new LowsTranslator("lt_your_key");           // just the key
new LowsTranslator({ apiKey, timeout, retries, baseUrl, fetch });
```

The key falls back to `process.env.LOWS_API_KEY`, so in most projects you never pass it.

| Option | Default | |
|---|---|---|
| `apiKey` | `LOWS_API_KEY` | |
| `timeout` | `30000` | per attempt, not a shared budget |
| `retries` | `2` | transient failures only, see below |
| `baseUrl` | `https://lows.gg` | |
| `fetch` | global | inject one for tests or a proxy |

### `translate(text, { to, from?, signal? })`

```js
const r = await lt.translate("god morgon", { to: "en", from: "sv" });
// { text: "good morning", from: "sv", to: "en", engine: "ember", unchanged: false }
```

**Pass `from` whenever you know it.** Detection **refuses rather than guesses**, so short text throws `undetected` rather than coming back wrong:

```js
await lt.translate("god morgon", { to: "en" });   // throws: undetected
await lt.translate("Hej, vem är du?", { to: "en" }); // fine, long enough
```

That is a deliberate trade. "god morgon" is Swedish, Norwegian and Danish depending on who typed it, and in chat a confidently wrong translation is worse than a question. If you have any idea of the source (a user's locale, a channel's language, the last thing they said), pass it and detection never runs.

`unchanged` is `true` when the source already matched the target. Nothing was translated and nothing was charged, which is worth knowing if you are looping over a mixed channel.

Empty, blank or non-string `text` is refused locally as `no_text`, without spending a request.

### `translateAll(texts, { to, concurrency? })`

```js
const rows = await lt.translateAll(
  ["hello there, how are you?", "see you tomorrow"],
  { to: "sv", from: "en", concurrency: 4 },
);
```

Results come back in input order. This is a convenience, not a batch endpoint: it is one request per text against your quota.

**If any one text fails, it throws, but the error carries the work that succeeded.** `undetected` is common on short text by design, and losing ninety-nine good translations because the hundredth was three characters long is not a useful default:

```js
try {
  const rows = await lt.translateAll(texts, { to: "sv" });
} catch (e) {
  e.results;    // translations at their input index, null where one failed
  e.failures;   // [{ index, text, error }], in input order
}
```

### Cancelling

Every method takes a `signal`, so a request can be dropped when the user navigates away or a shutdown starts:

```js
const ac = new AbortController();
setTimeout(() => ac.abort(), 2000);
await lt.translate(text, { to: "en", signal: ac.signal });   // throws code "aborted"
```

A cancellation is never retried, and it wakes the client out of a pending retry backoff rather than waiting it out. This is separate from `timeout`, which is the client giving up on one attempt and *is* retried.

### `detect(text | texts)`

```js
await lt.detect("Hej, kan nagon hjalpa mig?");
// { language: "sv", confidence: 0.98, reliable: true }
```

**Free.** Detection runs offline, so it is not charged against your character allowance and does not touch your quota. It still needs your key, so the request is counted at zero characters.

`reliable` is false for text too short to trust. It may still guess; treat that as a hint, not an answer.

Pass an array to classify a backlog in one round trip:

```js
const rows = await lt.detect(["hello there", "bom dia", "??"]);
// [{ language: "en", ... }, { language: "pt", ... }, { language: null, confidence: 0, reliable: false }]
```

The single form throws `undetected` when nothing could be determined. The batch form does not: one unreadable string in fifty should not fail the other forty-nine, so its entry comes back with `language: null` and you decide.

### `languages()`

```js
await lt.languages();   // ["af", "ar", "bg", "ca", ...]
```

**Needs no API key**, so you can check coverage before you ask for one.

### `usage()`

```js
await lt.usage();
// { used: 1500, limit: 500000, remaining: 498500, resets: "daily at 00:00 UTC" }
```

## Errors

Everything throws `LowsTranslatorError`. Match on **`code`**, never on `message`: messages get reworded, codes do not.

```js
import { LowsTranslator, LowsTranslatorError } from "lows-translator";

try {
  await lt.translate(text, { to: "en" });
} catch (e) {
  if (e instanceof LowsTranslatorError && e.isQuotaExhausted) {
    // out of characters until 00:00 UTC, so queue it for tomorrow
  } else if (e.code === "undetected") {
    // could not tell the language; ask, or pass `from`
  } else {
    throw e;
  }
}
```

| Code | Means |
|---|---|
| `invalid_key` | missing, malformed or revoked |
| `daily_limit` | out of characters until 00:00 UTC |
| `too_long` | over 2,000 characters in one call |
| `undetected` | detection was not confident; pass `from`. Common on short text |
| `unsupported_language` | not available yet; see `languages()` |
| `busy` / `unavailable` | transient, retried for you |
| `timeout` / `network_error` | never reached us, retried for you |
| `no_text` / `no_target` / `no_api_key` | refused locally, before any request |
| `aborted` | you cancelled it through `signal` |

**Retries are deliberate about what they do not retry.** A `busy` queue or a network blip is retried with backoff, honouring `Retry-After`. A `daily_limit` is **not**. It is a 429 like a throttle, but the window is a day, so retrying would be a busy-loop until midnight. Nor is any other 4xx: a bad key will not fix itself.

`e.isRetryable` tells you whether the client would have tried again, so you can drive your own queue off it. It is an allowlist of genuinely transient codes plus 5xx, **not** "status is 0 or 5xx": every locally raised error has status 0, so that test made a missing API key look retryable and would spin a caller forever on a mistake no amount of waiting fixes.

## Command line

```bash
npx lows-translator "Hej, vem är du?" --to en
npx lows-translator --languages
npx lows-translator --usage
```

The translation goes to stdout and everything else to stderr, so it pipes.

## Runs anywhere with fetch

Node 18+, Bun, Deno, Cloudflare Workers, and the browser. Zero dependencies, and `fetch` comes from the global rather than a bundled HTTP library, which is what keeps that list short.

> In a browser, remember the key is in the page. Call this from your own backend.

## Getting a key

The API is invite-only while it is in beta. Ask at **[lows.gg/api](https://lows.gg/api)**. You write a couple of sentences about what you are building, and a person reads it.

It runs on our own hardware alongside a live Discord bot, which is why there is a person in the loop rather than a signup form: the cost of a bad integration here is not a bill, it is the bot getting slower for everyone.

## Licence

MIT
