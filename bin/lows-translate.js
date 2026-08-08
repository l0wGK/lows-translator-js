#!/usr/bin/env node
"use strict";
// A CLI, mostly so `npx lows-translator "hej"` works.
//
// That is a discovery mechanism as much as a tool: somebody who reads about the
// API can try it in one line without writing a file, and the thing they type is
// the package name.

const { LowsTranslator, LowsTranslatorError } = require("../index.cjs");

const argv = process.argv.slice(2);

/** A flag that takes a value. Returns the value, or null if absent. */
const value = (name, short) => {
  const i = argv.findIndex((a) => a === `--${name}` || (short && a === `-${short}`));
  if (i < 0) return null;
  const v = argv[i + 1];
  // A flag with nothing after it used to return the boolean `true`, which then
  // travelled all the way to the wire as `target_lang: true`. Refuse it here.
  if (v === undefined || v.startsWith("-")) {
    console.error(`--${name} needs a value, for example --${name} en`);
    process.exit(1);
  }
  argv.splice(i, 2);
  return v;
};

/** A flag that takes no value, so it must not eat the next argument. */
const has = (name, short) => {
  const i = argv.findIndex((a) => a === `--${name}` || (short && a === `-${short}`));
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};

const wantHelp = has("help", "h");
const listLangs = has("languages", "l");
const showUsage = has("usage", "u");
const to = value("to", "t");
const from = value("from", "f");

// Anything flag-shaped still in argv is a typo. Left alone it becomes part of
// the text, so `--too en` would be silently translated and charged for.
const stray = argv.find((a) => a.startsWith("--") || /^-[a-zA-Z]$/.test(a));
if (stray && !wantHelp) {
  console.error(`Unknown option ${stray}. Try --help.`);
  process.exit(1);
}
const text = argv.join(" ").trim();

if (wantHelp || (!text && !listLangs && !showUsage)) {
  console.log(`
  lows-translate: translate text from the command line

    npx lows-translator "Hej, vem är du?" --to en
    npx lows-translator "good morning everyone" -t sv -f en
    npx lows-translator --languages
    npx lows-translator --usage

  Options
    -t, --to <lang>     target language (required to translate)
    -f, --from <lang>   source language (default: detect; pass it for short text)
    -l, --languages     list every supported language
    -u, --usage         today's usage for your key
    -h, --help          this

  Your key comes from LOWS_API_KEY. Request one at https://lows.gg/api
`);
  process.exit(wantHelp ? 0 : 1);
}

(async () => {
  const client = new LowsTranslator();
  if (listLangs) {
    // Before the key check on purpose: /v1/languages needs no key, so this
    // works for somebody deciding whether to ask for one.
    console.log((await client.languages()).join(" "));
    return;
  }
  if (showUsage) {
    const u = await client.usage();
    console.log(`${u.used.toLocaleString()} of ${u.limit.toLocaleString()} characters used today `
      + `(${u.remaining.toLocaleString()} left, resets ${u.resets})`);
    return;
  }
  if (!to) {
    console.error("Which language? Add --to en (or --languages to see them all).");
    process.exit(1);
  }
  const r = await client.translate(text, { to, from: from || undefined });
  // Just the translation on stdout, so it pipes. Everything else is stderr.
  if (r.unchanged) console.error(`(already ${r.from})`);
  console.log(r.text);
})().catch((e) => {
  if (e instanceof LowsTranslatorError) {
    console.error(`${e.code}: ${e.message}`);
    if (e.code === "no_api_key") console.error("Set LOWS_API_KEY, or request a key at https://lows.gg/api");
    process.exit(2);
  }
  console.error(e?.message || e);
  process.exit(2);
});
