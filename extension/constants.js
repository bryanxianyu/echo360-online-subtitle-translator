(() => {
  const ns = window.Echo360Translator = window.Echo360Translator || {};

  ns.constants = {
    STORAGE_KEY: "echo360TranslatorConfig",
    CACHE_KEY: "echo360TranslatedVttCache",
    PREFS_KEY_PREFIX: "echo360TranslatorPrefs::",
    TARGET_OPTIONS: ["ZH", "ZH-HK", "YUE", "EN", "JA", "KO", "FR", "DE", "ES", "IT", "PT", "RU", "AR", "HI"],
    DEFAULT_SUBTITLE_SIZE: "medium",
    SIZE_MAP: { small: "56%", medium: "64%", large: "88%" },
    SAFARI_SIZE_MAP: { small: "88%", medium: "104%", large: "128%" },
    CUE_LINE_MAP: { small: "97.2%", medium: "97.2%", large: "97.2%" },
    BILINGUAL_LINE_PAIR_MAP: {
      small: { upper: "94%", lower: "98.5%" },
      medium: { upper: "93%", lower: "98.5%" },
      large: { upper: "91%", lower: "98.5%" },
    },
  };

  ns.state = ns.state || {
    latestPageVideoSnapshot: [],
  };
})();
