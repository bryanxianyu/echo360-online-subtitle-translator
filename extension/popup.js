(() => {
  const STORAGE_KEY = "echo360TranslatorConfig";
  const api = globalThis.Echo360ExtensionApi;
  const configApi = globalThis.Echo360ProviderConfig;
  const buildConfig = globalThis.Echo360BuildConfig || {};
  const enableLocalBackend = buildConfig.enableLocalBackend !== false;
  const $ = (id) => document.getElementById(id);
  const providerHints = {
    "google-web": "免费、无需 API Key，适合先试用；质量通常不如 AI/API 模型。",
    deepseek: "需要 DeepSeek API Key，适合更高质量字幕翻译；Thinking 默认关闭。",
    gemini: "需要 Gemini API Key，适合更高质量字幕翻译。",
    openai: "需要 OpenAI API Key，适合更高质量字幕翻译。",
    deepl: "需要 DeepL API Key，适合常规机器翻译。"
  };

  let rawConfig = configApi.migrate({});
  let activeProvider = rawConfig.provider;
  let localApiKeys = {};
  let dirtyKeys = new Set();
  let profilePatches = {};
  let selectionDirty = false;
  let setup = null;
  let saveTimer = 0;
  let savePromise = null;

  function setSaveStatus(message, isError = false) {
    const node = $("status");
    node.textContent = message;
    node.dataset.state = isError ? "error" : "success";
    const retry = $("retrySaveBtn");
    if (retry) retry.hidden = !isError;
  }

  function hasStagedData() {
    return dirtyKeys.size > 0 || Object.keys(profilePatches).length > 0 || selectionDirty;
  }

  function clonePatches(patches) {
    return Object.fromEntries(Object.entries(patches).map(([id, patch]) => [id, { ...patch }]));
  }

  function clearSavedPatches(snapshot) {
    for (const [id, savedPatch] of Object.entries(snapshot)) {
      const patch = profilePatches[id];
      if (!patch) continue;
      for (const [field, value] of Object.entries(savedPatch)) {
        if (Object.is(patch[field], value)) delete patch[field];
      }
      if (!Object.keys(patch).length) delete profilePatches[id];
    }
  }

  function scheduleAutoSave(immediate = false) {
    if (!hasStagedData()) return;
    clearTimeout(saveTimer);
    setSaveStatus("等待自动保存…");
    if (immediate) {
      flushAutoSave();
      return;
    }
    saveTimer = setTimeout(() => flushAutoSave(), 600);
  }

  async function flushAutoSave() {
    clearTimeout(saveTimer);
    if (savePromise) {
      await savePromise;
      if (hasStagedData() && $("retrySaveBtn")?.hidden) return flushAutoSave();
      return;
    }
    if (!hasStagedData()) return;
    savePromise = saveConfig();
    try {
      await savePromise;
    } catch (error) {
      setSaveStatus(`保存失败：${error?.message || String(error)}`, true);
    } finally {
      savePromise = null;
      if (hasStagedData() && $("retrySaveBtn")?.hidden) scheduleAutoSave();
    }
  }

  function updateProviderHint() {
    const provider = $("provider").value;
    const keyless = configApi.KEYLESS_PROVIDERS.has(provider);
    $("providerHint").textContent = providerHints[provider] || "";
    $("apiKeyHint").textContent = keyless
      ? "无需 API Key。"
      : "Key 保存在浏览器本地，仅发送给所选服务地址。模型目录成功不代表模型翻译可用。";
  }

  function profileChanged(provider, patch, profile) {
    profilePatches[provider] = { ...(profilePatches[provider] || {}), ...patch };
    const typingCustomModel = patch.modelMode === "custom" && document.activeElement === $("customModel");
    scheduleAutoSave(Object.prototype.hasOwnProperty.call(patch, "modelMode") && !typingCustomModel);
  }

  async function loadConfig() {
    const stored = await api.storage.local.get(STORAGE_KEY);
    rawConfig = configApi.migrate(stored[STORAGE_KEY] || {});
    if (Number(stored[STORAGE_KEY]?.configVersion || 0) < 5) {
      await api.storage.local.set({ [STORAGE_KEY]: rawConfig });
    }
    localApiKeys = { ...rawConfig.apiKeys };
    activeProvider = rawConfig.provider;
    $("provider").value = activeProvider;
    updateProviderHint();
    await setup.load(rawConfig);
    if (!hasStagedData()) setSaveStatus("更改会自动保存");
  }

  async function saveConfig() {
    setSaveStatus("保存中…");
    const provider = activeProvider;
    const patchesSnapshot = clonePatches(profilePatches);
    const keysSnapshot = Object.fromEntries([...dirtyKeys].map((id) => [id, String(localApiKeys[id] || "").trim()]));
    const modelError = setup?.validateModel();
    const result = await configApi.withConfigWriteLock(async () => {
      const stored = await api.storage.local.get(STORAGE_KEY);
      const latest = configApi.migrate(stored[STORAGE_KEY] || rawConfig);
      const apiKeys = { ...latest.apiKeys, ...keysSnapshot };
      const patchesToWrite = clonePatches(patchesSnapshot);
      const deferred = [];
      if (modelError && patchesToWrite[provider]) {
        for (const field of ["model", "modelMode", "catalogModel", "customModel"]) delete patchesToWrite[provider][field];
        if (!Object.keys(patchesToWrite[provider]).length) delete patchesToWrite[provider];
        deferred.push("模型 ID 为空，此项尚未保存");
      }
      let config = configApi.saveActive({ ...latest, apiKeys }, provider, patchesToWrite[provider] || {}, {}, configApi.KEYLESS_PROVIDERS.has(provider) ? "" : String(apiKeys[provider] || ""));
      const providerSettings = { ...config.providerSettings };
      for (const [id, patch] of Object.entries(patchesToWrite)) providerSettings[id] = { ...providerSettings[id], ...patch };
      config = {
        ...config,
        provider,
        providerSettings,
        ...providerSettings[provider],
        apiKeys,
        apiKey: configApi.KEYLESS_PROVIDERS.has(provider) ? "" : String(apiKeys[provider] || ""),
        useLocalBackend: enableLocalBackend ? !!latest.useLocalBackend : latest.useLocalBackend,
      };
      await api.storage.local.set({ [STORAGE_KEY]: config });
      return { config, patchesToWrite, keysSnapshot, provider, deferred };
    });

    rawConfig = result.config;
    clearSavedPatches(result.patchesToWrite);
    for (const [id, value] of Object.entries(result.keysSnapshot)) {
      if (String(localApiKeys[id] || "").trim() === value) dirtyKeys.delete(id);
    }
    localApiKeys = { ...result.config.apiKeys, ...Object.fromEntries([...dirtyKeys].map((id) => [id, localApiKeys[id]])) };
    selectionDirty = activeProvider !== result.provider;
    if (result.deferred.length) setSaveStatus(`${result.deferred.join("；")}。其他设置已保存。`, true);
    else setSaveStatus(hasStagedData() ? "等待自动保存…" : "已保存");
  }

  function onExternalConfigChange(changes, area) {
    if (area !== "local" || !changes[STORAGE_KEY]?.newValue) return;
    const incoming = configApi.migrate(changes[STORAGE_KEY].newValue);
    const incomingKeys = { ...incoming.apiKeys };
    for (const id of dirtyKeys) incomingKeys[id] = localApiKeys[id];
    localApiKeys = incomingKeys;
    const mergedProfiles = { ...incoming.providerSettings };
    for (const [id, patch] of Object.entries(profilePatches)) mergedProfiles[id] = { ...mergedProfiles[id], ...patch };
    rawConfig = { ...incoming, apiKeys: incomingKeys, providerSettings: mergedProfiles };
    if (!selectionDirty) {
      activeProvider = incoming.provider;
      $("provider").value = activeProvider;
      updateProviderHint();
    }
    const contextMatches = setup.matchesConfig(rawConfig);
    if (contextMatches) setup.syncConfiguration({ keys: localApiKeys, profiles: mergedProfiles });
    else if (!selectionDirty && !dirtyKeys.has(activeProvider) && document.activeElement !== $("apiKey")) {
      // Reload only when the provider request context actually changed.
      setup.load(rawConfig);
    }
  }

  const elements = {
    provider: $("provider"),
    apiKey: $("apiKey"),
    apiKeyHint: $("apiKeyHint"),
    model: $("model"),
    modelPickerControl: $("modelPickerControl"),
    modelPickerToggle: $("modelPickerToggle"),
    modelPickerPanel: $("modelPickerPanel"),
    modelPickerValue: $("modelPickerValue"),
    modelSearch: $("modelSearch"),
    modelOptions: $("modelOptions"),
    customModelEnabled: $("customModelEnabled"),
    customModel: $("customModel"),
    catalogStatus: $("catalogStatus"),
    verificationStatus: $("verificationStatus"),
    refreshModels: $("refreshModels"),
    verifyProvider: $("verifyProvider"),
    showIncompatible: $("showIncompatible"),
    testHelp: $("testHelp"),
  };

  setup = globalThis.Echo360ProviderSetup.mount({
    storageKey: STORAGE_KEY,
    localBackendEnabled: enableLocalBackend,
    elements,
    onProfileChange: profileChanged,
    onApiKeyChange(provider, value) {
      localApiKeys[provider] = value;
      dirtyKeys.add(provider);
      scheduleAutoSave();
    },
    persistApiKeys: false,
  });

  $("provider").addEventListener("change", () => {
    const oldProvider = activeProvider;
    const oldKey = $("apiKey").value.trim();
    if (!configApi.KEYLESS_PROVIDERS.has(oldProvider)) {
      localApiKeys[oldProvider] = oldKey;
      dirtyKeys.add(oldProvider);
      setup.syncConfiguration({ keys: { [oldProvider]: oldKey } });
    }
    activeProvider = $("provider").value;
    selectionDirty = true;
    updateProviderHint();
    scheduleAutoSave(true);
  }, true);
  $("apiKey").addEventListener("input", (event) => {
    const provider = event.target.dataset.forProvider;
    if (!provider) return;
    localApiKeys[provider] = event.target.value.trim();
    dirtyKeys.add(provider);
    scheduleAutoSave();
  });
  $("apiKey").addEventListener("change", (event) => {
    const provider = event.target.dataset.forProvider;
    if (!provider) return;
    const value = event.target.value.trim();
    localApiKeys[provider] = value;
    dirtyKeys.add(provider);
    scheduleAutoSave(true);
  });
  $("retrySaveBtn")?.addEventListener("click", () => flushAutoSave());
  for (const id of ["apiKey", "customModel"]) $(id)?.addEventListener("blur", () => {
    if (hasStagedData()) scheduleAutoSave(true);
  });
  window.addEventListener("pagehide", () => { if (hasStagedData()) flushAutoSave(); });
  $("optionsBtn").addEventListener("click", () => {
    const result = globalThis.Echo360ExtensionApi.raw.runtime.openOptionsPage?.();
    if (result && typeof result.catch === "function") result.catch(() => {});
  });
  api.storage.onChanged.addListener(onExternalConfigChange);

  loadConfig().catch((error) => setSaveStatus(`加载失败：${error?.message || String(error)}`, true));
})();
