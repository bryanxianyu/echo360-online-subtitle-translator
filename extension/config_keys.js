// Shared per-provider API key logic used by both popup.js and options.js so the
// two surfaces behave identically and stay in sync with each other.
(() => {
  const root = globalThis;

  const KEYLESS_PROVIDERS = new Set(["google-web"]);

  function isKeylessProvider(provider) {
    return KEYLESS_PROVIDERS.has(provider);
  }

  /**
   * Builds an in-memory provider -> API key map from a stored config object.
   * Migrates the legacy single `apiKey` field onto the config's current
   * provider the first time it's seen, so pre-existing installs don't lose
   * the key they already had saved.
   */
  function buildKeyMap(config) {
    const map = { ...(config?.apiKeys || {}) };
    const provider = config?.provider;
    if (provider && config?.apiKey && !map[provider]) {
      map[provider] = config.apiKey;
    }
    return map;
  }

  /** Records whatever is currently typed for `provider` into `map` (no-op for keyless providers). */
  function stashKey(map, provider, rawValue) {
    if (provider && !isKeylessProvider(provider)) {
      map[provider] = (rawValue || "").trim();
    }
    return map;
  }

  /**
   * Produces the `{ apiKeys, apiKey }` pair to merge into a config before
   * saving: `apiKeys` is the full per-provider map, `apiKey` mirrors the
   * resolved key for `provider` (kept for older/legacy readers).
   */
  function resolveForSave(map, provider) {
    return {
      apiKeys: { ...map },
      apiKey: isKeylessProvider(provider) ? "" : (map[provider] || ""),
    };
  }

  root.Echo360ConfigKeys = { KEYLESS_PROVIDERS, isKeylessProvider, buildKeyMap, stashKey, resolveForSave };
})();
