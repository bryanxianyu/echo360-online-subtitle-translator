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
    ONBOARDING_KEY: "echo360TranslatorOnboardingSeen",
    PROVIDER_LABELS: {
      "google-web": "Google Translate",
      deepseek: "DeepSeek",
      gemini: "Gemini",
      openai: "OpenAI",
      deepl: "DeepL",
    },
    TARGET_OPTIONS: ["ZH", "ZH-HK", "YUE", "EN", "JA", "KO", "FR", "DE", "ES", "IT", "PT", "RU", "AR", "HI"],
    TARGET_LABELS: {
      ZH: "简体中文",
      "ZH-HK": "繁体中文（香港）",
      YUE: "粤语（繁体）",
      EN: "英语 (English)",
      JA: "日语 (日本語)",
      KO: "韩语 (한국어)",
      FR: "法语 (Français)",
      DE: "德语 (Deutsch)",
      ES: "西班牙语 (Español)",
      IT: "意大利语 (Italiano)",
      PT: "葡萄牙语 (Português)",
      RU: "俄语 (Русский)",
      AR: "阿拉伯语 (العربية)",
      HI: "印地语 (हिन्दी)",
    },
    SUBTITLE_PENDING_LABEL: "正在翻译中...",
    SUBTITLE_FAILURE_LABEL: "[翻译失败]",
    DEFAULT_SUBTITLE_SIZE: "medium",
    SIZE_MAP: { small: "62%", medium: "70%", large: "78%" },
    SAFARI_SIZE_MAP: { small: "94%", medium: "110%", large: "128%" },
    DEFAULT_SUBTITLE_LINE_HEIGHT: "1.3",
    SAFARI_LINE_HEIGHT_MAP: { normal: "1.45", fullscreen: "1.45" },
    CUE_LINE_MAP: { small: "97.2%", medium: "97.2%", large: "97.2%" },
  };

  ns.state = ns.state || {
    latestPageVideoSnapshot: [],
  };
})();
