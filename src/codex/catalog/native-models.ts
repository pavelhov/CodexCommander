/**
 * Legacy emergency fallback when the installed Codex CLI bundled catalog is unavailable.
 * Runtime publication uses bundled catalog slugs via `supportedNativeOpenAiSlugs()`.
 */
export const LEGACY_NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

/** @deprecated Use `supportedNativeOpenAiSlugs()` / `isSupportedNativeOpenAiSlug()`. */
export const NATIVE_OPENAI_MODELS = LEGACY_NATIVE_OPENAI_MODELS;

/** @deprecated Use `supportedNativeOpenAiSlugs()` / `isSupportedNativeOpenAiSlug()`. */
export const LEGACY_SUPPORTED_NATIVE_OPENAI_SLUGS = new Set(LEGACY_NATIVE_OPENAI_MODELS);

/** @deprecated Use `supportedNativeOpenAiSlugs()` / `isSupportedNativeOpenAiSlug()`. */
export const SUPPORTED_NATIVE_OPENAI_SLUGS = LEGACY_SUPPORTED_NATIVE_OPENAI_SLUGS;
