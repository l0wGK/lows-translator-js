// ESM shim over the CommonJS implementation.
//
// Named re-exports rather than `export * from`: the CJS module has no static
// shape ESM can read, so the names have to be written out. That is a feature:
// adding an export means declaring it here, and the two cannot drift silently.
import mod from "./index.cjs";

export const LowsTranslator = mod.LowsTranslator;
export const LowsTranslatorError = mod.LowsTranslatorError;
export const VERSION = mod.VERSION;
export default mod.LowsTranslator;
