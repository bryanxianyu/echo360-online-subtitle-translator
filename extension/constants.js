(() => {
  const ns = window.Echo360Translator = window.Echo360Translator || {};
  const rawBuildConfig = window.Echo360BuildConfig || {};

  ns.buildConfig = {
    buildTarget: rawBuildConfig.buildTarget || "dev",
    enableLocalBackend: rawBuildConfig.enableLocalBackend !== false,
  };

  ns.constants = {
    STORAGE_KEY: "echo360TranslatorConfig",
    CACHE_KEY: "echo360TranslatedVttCache",
    PREFS_KEY_PREFIX: "echo360TranslatorPrefs::",
    TARGET_OPTIONS: ["ZH", "ZH-HK", "YUE", "EN", "JA", "KO", "FR", "DE", "ES", "IT", "PT", "RU", "AR", "HI"],
    DEFAULT_SUBTITLE_SIZE: "medium",
    SIZE_MAP: { small: "62%", medium: "70%", large: "78%" },
    SAFARI_SIZE_MAP: { small: "94%", medium: "110%", large: "128%" },
    CUE_LINE_MAP: { small: "97.2%", medium: "97.2%", large: "97.2%" },
  };

  ns.state = ns.state || {
    latestPageVideoSnapshot: [],
  };
})();
