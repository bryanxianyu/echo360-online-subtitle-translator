const STORAGE_KEY = "echo360TranslatorConfig";
const extensionApi = window.Echo360ExtensionApi;
const buildConfig = window.Echo360BuildConfig || {};
const enableLocalBackend = buildConfig.enableLocalBackend !== false;
const providerConfig = window.Echo360ProviderConfig;
const performanceFields = providerConfig.PERFORMANCE_FIELDS;
const providerHints = {
  "google-web": "免费且无需 API Key，适合首次试用和低门槛使用；翻译质量通常不如专用 AI/API 模型。",
  deepseek: "需要你自己的 DeepSeek API Key。更适合追求课程字幕翻译质量的长期使用；为了更丝滑的翻译体验，DeepSeek Thinking 默认为关闭。",
  gemini: "需要你自己的 Gemini API Key。适合追求更好翻译质量；请确认所在地区和账号可用。",
  openai: "需要你自己的 OpenAI API Key。适合追求更好翻译质量；Reasoning Effort 仅对支持模型生效。",
  deepl: "需要你自己的 DeepL API Key。适合常规机器翻译质量需求；不支持 YUE 目标语言。"
};

let rawConfig = providerConfig.migrate({});
let localApiKeys = {};
const dirtyKeys = new Set();
let localProviderSettings = { ...rawConfig.providerSettings };
let pendingProfilePatches = {};
let pendingGlobalPatch = {};
let activeProvider = rawConfig.provider;
let configDirty = false;
let setup = null;
let autoSaveTimer = 0;
let autoSavePromise = null;
let resetUndoSnapshot = null;
let resetUndoTimer = 0;

function applyAppearance(mode) {
  const root = document.documentElement;
  if (!mode || mode === "auto") delete root.dataset.appearance;
  else root.dataset.appearance = mode;
}

function setStatus(text, isError = false) {
  const status = document.getElementById("status");
  status.textContent = text;
  status.classList.toggle("error", !!isError);
  const retry = document.getElementById("retrySaveBtn");
  if (retry) retry.hidden = !isError;
}

function hasPendingChanges() {
  return configDirty || hasStagedData();
}

function hasStagedData() {
  return dirtyKeys.size > 0 || Object.keys(pendingProfilePatches).length > 0 || Object.keys(pendingGlobalPatch).length > 0;
}

function clonePatchMap(patches) {
  return Object.fromEntries(Object.entries(patches).map(([id, patch]) => [id, { ...patch }]));
}

function removeMatchingPatchValues(target, snapshot) {
  for (const [id, savedPatch] of Object.entries(snapshot)) {
    const currentPatch = target[id];
    if (!currentPatch) continue;
    for (const [field, value] of Object.entries(savedPatch)) {
      if (Object.is(currentPatch[field], value)) delete currentPatch[field];
    }
    if (Object.keys(currentPatch).length === 0) delete target[id];
  }
}

function scheduleAutoSave(immediate = false) {
  if (!hasPendingChanges()) return;
  clearTimeout(autoSaveTimer);
  setStatus("等待自动保存…");
  if (immediate) {
    flushAutoSave();
    return;
  }
  autoSaveTimer = setTimeout(() => flushAutoSave(), 600);
}

async function flushAutoSave() {
  clearTimeout(autoSaveTimer);
  if (autoSavePromise) {
    await autoSavePromise;
    if (hasPendingChanges() && document.getElementById("retrySaveBtn")?.hidden) return flushAutoSave();
    return;
  }
  if (!hasPendingChanges()) return;
  autoSavePromise = saveConfig();
  try {
    await autoSavePromise;
  } catch (error) {
    setStatus(`保存失败：${error?.message || String(error)}`, true);
  } finally {
    autoSavePromise = null;
    if (hasPendingChanges() && !document.getElementById("retrySaveBtn")?.hidden) return;
    if (hasPendingChanges()) scheduleAutoSave();
  }
}

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value == null ? "" : String(value);
}

function getInputValue(id, fallback = "") {
  const el = document.getElementById(id);
  return el ? el.value : fallback;
}

function getNumberFromInput(id, fallback, min) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  const parsed = el.value === "" ? Number(fallback) : Number(el.value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function readCurrentProfile(provider) {
  const base = { ...(localProviderSettings[provider] || providerConfig.resolve(rawConfig, provider)) };
  if (provider === activeProvider) {
    const customMode = !!document.getElementById("customModelEnabled")?.checked;
    base.modelMode = customMode ? "custom" : "catalog";
    if (customMode) {
      base.customModel = getInputValue("customModel", base.customModel || "").trim();
      base.model = base.customModel;
    } else {
      const selectedCatalogModel = getInputValue("modelOptions", base.catalogModel || "").trim();
      if (selectedCatalogModel) base.catalogModel = selectedCatalogModel;
      base.model = String(base.catalogModel || "").trim();
    }
    base.endpoint = getInputValue("endpoint", base.endpoint || "").trim();
    base.openaiApiProtocol = getInputValue("openaiApiProtocol", base.openaiApiProtocol || "responses");
  }
  for (const field of performanceFields) {
    const input = document.getElementById(field);
    if (!input) continue;
    if (field === "fallbackMode") base[field] = input.value || base[field] || "immediate";
    else {
      const min = field === "rps" || field === "retries" || field === "slowSplitThreshold" ? 0 : 1;
      base[field] = getNumberFromInput(field, base[field], min);
    }
  }
  if (provider === "openai") base.reasoningEffort = getInputValue("reasoningEffort", base.reasoningEffort || "");
  if (provider === "deepseek") base.deepseekThinkingMode = getInputValue("deepseekThinkingMode", base.deepseekThinkingMode || "disabled");
  if (provider === "deepl") base.deeplFormality = getInputValue("deeplFormality", base.deeplFormality || "");
  localProviderSettings[provider] = base;
  return base;
}

function loadProviderProfile(provider) {
  const profile = localProviderSettings[provider] || providerConfig.resolve(rawConfig, provider);
  localProviderSettings[provider] = profile;
  setInputValue("model", profile.model || "");
  setInputValue("endpoint", profile.endpoint || "");
  const endpoint = document.getElementById("endpoint");
  if (endpoint) endpoint.placeholder = providerConfig.DEFAULT_ENDPOINTS[provider] || "留空使用默认地址";
  for (const field of performanceFields) setInputValue(field, profile[field]);
  setInputValue("reasoningEffort", profile.reasoningEffort || "");
  setInputValue("openaiApiProtocol", profile.openaiApiProtocol || "responses");
  setInputValue("deepseekThinkingMode", profile.deepseekThinkingMode || "disabled");
  setInputValue("deeplFormality", profile.deeplFormality || "");
  const endpointHint = document.getElementById("endpointHint");
  if (endpointHint) {
    endpointHint.textContent = "灰色文字为当前服务默认地址；留空使用默认值，自定义地址用于模型目录和翻译请求。";
    endpointHint.classList.remove("error");
  }
  document.getElementById("resetAdvancedStatus")?.replaceChildren();
}

function refreshProviderUi() {
  const provider = document.getElementById("provider").value;
  const keyless = providerConfig.KEYLESS_PROVIDERS.has(provider);
  const keyEl = document.getElementById("apiKey");
  document.getElementById("providerHint").textContent = providerHints[provider] || "";
  keyEl.disabled = keyless;
  keyEl.placeholder = keyless ? "Google Translate 不需要 API Key" : "请输入你的 API Key";
  if (keyless) {
    keyEl.value = "";
    keyEl.dataset.forProvider = "";
  } else {
    keyEl.value = String(localApiKeys[provider] || "");
    keyEl.dataset.forProvider = provider;
  }
  refreshAdvancedUi(provider);
}

function refreshAdvancedUi(provider) {
  const rows = [...document.querySelectorAll("[data-provider-advanced]")];
  const hasDevAdvanced = document.querySelector("[data-dev-advanced]") !== null;
  let visible = 0;
  for (const row of rows) {
    row.hidden = row.dataset.providerAdvanced !== provider;
    if (!row.hidden) visible += 1;
  }
  const hint = document.getElementById("advancedEmptyHint");
  if (hint) hint.hidden = visible > 0 || hasDevAdvanced;
  refreshAdvancedResetButton();
}

function refreshBuildUi() {
  const section = document.getElementById("localBackendSection");
  const checkbox = document.getElementById("useLocalBackend");
  if (!enableLocalBackend) {
    if (section) section.hidden = true;
    if (checkbox) checkbox.checked = false;
  }
}

async function loadConfig() {
  const stored = await extensionApi.storage.local.get(STORAGE_KEY);
  const existing = stored[STORAGE_KEY] || {};
  rawConfig = providerConfig.migrate(existing);
  if (Number(existing.configVersion || 0) < 5) await extensionApi.storage.local.set({ [STORAGE_KEY]: rawConfig });
  localApiKeys = { ...rawConfig.apiKeys };
  localProviderSettings = { ...rawConfig.providerSettings };
  activeProvider = rawConfig.provider;
  document.getElementById("provider").value = activeProvider;
  const useLocalBackend = document.getElementById("useLocalBackend");
  if (useLocalBackend) useLocalBackend.checked = enableLocalBackend && !!rawConfig.useLocalBackend;
  const backendUrl = document.getElementById("backendUrl");
  if (backendUrl) backendUrl.value = rawConfig.backendUrl || "http://127.0.0.1:8765";
  const target = document.getElementById("target");
  const targetValue = String(rawConfig.target || "ZH").toUpperCase();
  if ([...target.options].some((option) => option.value === targetValue)) target.value = targetValue;
  else target.value = "ZH";
  loadProviderProfile(activeProvider);
  const appearance = rawConfig.appearance || "auto";
  setInputValue("appearance", appearance);
  applyAppearance(appearance);
  refreshProviderUi();
  refreshBuildUi();
  if (setup) await setup.load(rawConfig);
  if (!hasPendingChanges()) setStatus("更改会自动保存");
}

function isLocalBackendUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch (_) { return false; }
}

function profileChanged(provider, patch, profile) {
  localProviderSettings[provider] = { ...(localProviderSettings[provider] || {}), ...profile, ...patch };
  pendingProfilePatches[provider] = { ...(pendingProfilePatches[provider] || {}), ...patch };
  configDirty = true;
  const typingCustomModel = patch.modelMode === "custom" && document.activeElement === document.getElementById("customModel");
  scheduleAutoSave(Object.prototype.hasOwnProperty.call(patch, "modelMode") && !typingCustomModel);
}

function apiKeyChanged(provider, key) {
  localApiKeys[provider] = key;
  dirtyKeys.add(provider);
  configDirty = true;
  scheduleAutoSave();
}

function captureProfileField(field) {
  if (resetUndoSnapshot && (providerConfig.PROFILE_FIELDS.includes(field) || performanceFields.includes(field))) {
    clearTimeout(resetUndoTimer);
    resetUndoSnapshot = null;
    const undo = document.getElementById("undoAdvancedResetBtn");
    if (undo) undo.hidden = true;
  }
  const provider = activeProvider;
  let value;
  if (field === "model" || field === "endpoint" || field === "openaiApiProtocol" || field === "reasoningEffort" || field === "deepseekThinkingMode" || field === "deeplFormality") {
    value = getInputValue(field, localProviderSettings[provider]?.[field] || (field === "openaiApiProtocol" ? "responses" : "")).trim();
  } else if (field === "fallbackMode") {
    value = getInputValue(field, localProviderSettings[provider]?.[field] || "immediate");
  } else {
    const current = localProviderSettings[provider]?.[field];
    const min = field === "rps" || field === "retries" || field === "slowSplitThreshold" ? 0 : 1;
    value = getNumberFromInput(field, current, min);
  }
  pendingProfilePatches[provider] = { ...(pendingProfilePatches[provider] || {}), [field]: value };
  localProviderSettings[provider] = { ...(localProviderSettings[provider] || {}), [field]: value };
  configDirty = true;
  scheduleAutoSave();
  if (field === "endpoint") validateEndpointInput();
  refreshAdvancedResetButton();
}

function sameAsDefault(field, current, expected) {
  if (typeof expected === "number") {
    if (String(current ?? "").trim() === "") return expected === 0;
    const number = Number(current);
    return Number.isFinite(number) && number === expected;
  }
  return String(current ?? "").trim() === String(expected ?? "").trim();
}

function refreshAdvancedResetButton() {
  const button = document.getElementById("resetAdvancedBtn");
  if (!button) return;
  const profile = localProviderSettings[activeProvider] || providerConfig.resolve(rawConfig, activeProvider);
  const defaults = providerConfig.defaultAdvancedPatch(activeProvider, enableLocalBackend);
  button.disabled = Object.entries(defaults).every(([field, expected]) => {
    const input = document.getElementById(field);
    const current = activeProvider === document.getElementById("provider").value && input
      ? input.value
      : profile[field];
    return sameAsDefault(field, current, expected);
  });
}

function validateEndpointInput() {
  const endpoint = document.getElementById("endpoint");
  const hint = document.getElementById("endpointHint");
  if (!endpoint || !hint) return;
  try {
    providerConfig.endpointFor(activeProvider, endpoint.value, activeProvider === "deepl" ? "usage" : "models");
    hint.textContent = "灰色文字为当前服务默认地址；留空使用默认值，自定义地址用于模型目录和翻译请求。";
    hint.classList.remove("error");
  } catch (error) {
    hint.textContent = error?.message || "Endpoint 与当前服务接口不兼容";
    hint.classList.add("error");
  }
}

function resetAdvancedSettings() {
  const provider = activeProvider;
  const patch = providerConfig.defaultAdvancedPatch(provider, enableLocalBackend);
  const profile = localProviderSettings[provider] || providerConfig.resolve(rawConfig, provider);
  const priorEndpoint = String(document.getElementById("endpoint")?.value || "").trim();
  const endpointChanged = !sameAsDefault("endpoint", priorEndpoint, patch.endpoint);
  const validationChanged = (providerConfig.PROVIDER_ADVANCED_FIELDS[provider] || []).some((field) => {
    const input = document.getElementById(field);
    const current = input ? input.value : profile[field];
    return !sameAsDefault(field, current, patch[field]);
  });

  const priorValues = Object.fromEntries(Object.keys(patch).map((field) => {
    const inputValue = document.getElementById(field)?.value;
    if (field === "endpoint") return [field, String(inputValue || "").trim()];
    if (performanceFields.includes(field) && field !== "fallbackMode") {
      const value = inputValue === "" || inputValue === undefined ? profile[field] : Number(inputValue);
      return [field, Number.isFinite(Number(value)) ? Number(value) : profile[field]];
    }
    return [field, inputValue ?? profile[field]];
  }));
  clearTimeout(resetUndoTimer);
  resetUndoSnapshot = { provider, priorValues, resetValues: { ...patch } };
  for (const [field, value] of Object.entries(patch)) setInputValue(field, value);
  localProviderSettings[provider] = { ...profile, ...patch };
  pendingProfilePatches[provider] = { ...(pendingProfilePatches[provider] || {}), ...patch };
  configDirty = true;
  setup?.syncConfiguration({ profiles: { [provider]: localProviderSettings[provider] } });

  if (endpointChanged) setup?.invalidate("Endpoint 已恢复默认，请重新读取模型目录并验证", true);
  else if (validationChanged) setup?.invalidate("高级翻译参数已恢复默认，请重新验证", false);

  validateEndpointInput();
  refreshAdvancedResetButton();
  const status = document.getElementById("resetAdvancedStatus");
  if (status) status.textContent = "高级参数已恢复默认。";
  const undo = document.getElementById("undoAdvancedResetBtn");
  if (undo) undo.hidden = false;
  scheduleAutoSave(true);
  resetUndoTimer = setTimeout(() => {
    resetUndoSnapshot = null;
    if (undo) undo.hidden = true;
  }, 10000);
}

function undoAdvancedReset() {
  const snapshot = resetUndoSnapshot;
  if (!snapshot || snapshot.provider !== activeProvider) return;
  clearTimeout(resetUndoTimer);
  resetUndoSnapshot = null;
  const undo = document.getElementById("undoAdvancedResetBtn");
  if (undo) undo.hidden = true;
  const profile = localProviderSettings[snapshot.provider] || providerConfig.resolve(rawConfig, snapshot.provider);
  for (const [field, value] of Object.entries(snapshot.priorValues)) setInputValue(field, value);
  localProviderSettings[snapshot.provider] = { ...profile, ...snapshot.priorValues };
  pendingProfilePatches[snapshot.provider] = { ...(pendingProfilePatches[snapshot.provider] || {}), ...snapshot.priorValues };
  configDirty = true;
  setup?.syncConfiguration({ profiles: { [snapshot.provider]: localProviderSettings[snapshot.provider] } });
  validateEndpointInput();
  refreshAdvancedResetButton();
  const status = document.getElementById("resetAdvancedStatus");
  if (status) status.textContent = "已撤销恢复默认。";
  scheduleAutoSave(true);
}

function captureGlobalField(field) {
  if (field === "target") pendingGlobalPatch.target = String(getInputValue(field, rawConfig.target || "ZH")).toUpperCase();
  else if (field === "appearance") pendingGlobalPatch.appearance = getInputValue(field, rawConfig.appearance || "auto") || "auto";
  else if (field === "useLocalBackend") pendingGlobalPatch.useLocalBackend = enableLocalBackend && !!document.getElementById(field)?.checked;
  else if (field === "backendUrl") pendingGlobalPatch.backendUrl = getInputValue(field, rawConfig.backendUrl || "http://127.0.0.1:8765").trim();
  configDirty = true;
  scheduleAutoSave();
}

function applyProviderDefaults() {
  clearTimeout(resetUndoTimer);
  resetUndoSnapshot = null;
  const undo = document.getElementById("undoAdvancedResetBtn");
  if (undo) undo.hidden = true;
  const keyEl = document.getElementById("apiKey");
  const previous = activeProvider;
  if (keyEl.dataset.forProvider) {
    localApiKeys[keyEl.dataset.forProvider] = keyEl.value.trim();
    dirtyKeys.add(keyEl.dataset.forProvider);
  }
  readCurrentProfile(previous);
  const next = document.getElementById("provider").value;
  loadProviderProfile(next);
  activeProvider = next;
  configDirty = true;
  refreshProviderUi();
  setup?.syncConfiguration({ keys: localApiKeys, profiles: localProviderSettings });
  scheduleAutoSave(true);
}

function isEditingApiKey() {
  return document.activeElement === document.getElementById("apiKey");
}

function handleExternalConfigChange(newValue) {
  if (!newValue) return;
  const incoming = providerConfig.migrate(newValue);
  const currentContextMatches = setup?.matchesConfig(incoming) || false;
  const mergedKeys = { ...incoming.apiKeys };
  for (const provider of dirtyKeys) mergedKeys[provider] = localApiKeys[provider];
  localApiKeys = mergedKeys;
  if (!configDirty) {
    rawConfig = incoming;
    localProviderSettings = { ...incoming.providerSettings };
    if (incoming.provider !== activeProvider) {
      activeProvider = incoming.provider;
      document.getElementById("provider").value = activeProvider;
    } else {
      localProviderSettings[activeProvider] = incoming.providerSettings[activeProvider];
    }
    loadProviderProfile(activeProvider);
    const target = document.getElementById("target");
    const targetValue = String(incoming.target || "ZH").toUpperCase();
    if ([...target.options].some((option) => option.value === targetValue)) target.value = targetValue;
    setInputValue("appearance", incoming.appearance || "auto");
    applyAppearance(incoming.appearance || "auto");
    if (!isEditingApiKey()) refreshProviderUi();
    setup?.syncConfiguration({ keys: localApiKeys, profiles: localProviderSettings });
    if (!currentContextMatches) setup?.load(incoming);
    pendingProfilePatches = {};
    pendingGlobalPatch = {};
    return;
  }
  localProviderSettings = { ...incoming.providerSettings };
  for (const [provider, patch] of Object.entries(pendingProfilePatches)) {
    localProviderSettings[provider] = { ...localProviderSettings[provider], ...patch };
  }
  rawConfig = { ...incoming, ...pendingGlobalPatch, apiKeys: mergedKeys, provider: activeProvider, providerSettings: localProviderSettings };
  for (const field of ["target", "appearance", "backendUrl", "useLocalBackend"]) {
    if (Object.prototype.hasOwnProperty.call(pendingGlobalPatch, field)) continue;
    if (field === "target") {
      const target = document.getElementById("target");
      const value = String(incoming.target || "ZH").toUpperCase();
      if ([...target.options].some((option) => option.value === value)) target.value = value;
    } else if (field === "appearance") {
      setInputValue("appearance", incoming.appearance || "auto");
      applyAppearance(incoming.appearance || "auto");
    } else if (field === "backendUrl") {
      setInputValue("backendUrl", incoming.backendUrl || "http://127.0.0.1:8765");
    } else {
      const checkbox = document.getElementById("useLocalBackend");
      if (checkbox) checkbox.checked = enableLocalBackend && !!incoming.useLocalBackend;
    }
  }
  if (setup?.matchesConfig(rawConfig)) setup.syncConfiguration({ keys: localApiKeys, profiles: localProviderSettings });
  else setup?.load(rawConfig);
  if (!isEditingApiKey()) refreshProviderUi();
}

extensionApi.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) handleExternalConfigChange(changes[STORAGE_KEY].newValue);
});

async function saveConfig() {
  setStatus("保存中…");
  const provider = activeProvider;
  const profileSnapshot = clonePatchMap(pendingProfilePatches);
  const globalSnapshot = { ...pendingGlobalPatch };
  const keySnapshot = Object.fromEntries([...dirtyKeys].map((id) => [id, String(localApiKeys[id] || "").trim()]));
  const result = await providerConfig.withConfigWriteLock(async () => {
    const stored = await extensionApi.storage.local.get(STORAGE_KEY);
    const existing = providerConfig.migrate(stored[STORAGE_KEY] || rawConfig);
    const keysToWrite = { ...existing.apiKeys, ...keySnapshot };
    const profilesToWrite = clonePatchMap(profileSnapshot);
    const globalsToWrite = { ...globalSnapshot };
    const deferred = [];

    const modelError = setup?.validateModel();
    if (modelError && profilesToWrite[provider]) {
      for (const field of ["model", "modelMode", "catalogModel", "customModel"]) delete profilesToWrite[provider][field];
      if (!Object.keys(profilesToWrite[provider]).length) delete profilesToWrite[provider];
      deferred.push("模型 ID 为空，此项尚未保存");
    }
    for (const [id, patch] of Object.entries(profilesToWrite)) {
      if (!Object.prototype.hasOwnProperty.call(patch, "endpoint")) continue;
      try {
        providerConfig.endpointFor(id, patch.endpoint, id === "deepl" ? "usage" : "models");
      } catch (_) {
        delete patch.endpoint;
        deferred.push("Endpoint 格式不兼容，此项尚未保存");
      }
      if (!Object.keys(patch).length) delete profilesToWrite[id];
    }

    const useLocalBackend = enableLocalBackend && !!(Object.prototype.hasOwnProperty.call(globalsToWrite, "useLocalBackend")
      ? globalsToWrite.useLocalBackend
      : existing.useLocalBackend);
    const backendUrl = Object.prototype.hasOwnProperty.call(globalsToWrite, "backendUrl")
      ? globalsToWrite.backendUrl
      : existing.backendUrl || "http://127.0.0.1:8765";
    if (useLocalBackend && !isLocalBackendUrl(backendUrl)) {
      delete globalsToWrite.backendUrl;
      delete globalsToWrite.useLocalBackend;
      deferred.push("Backend URL 只允许 localhost、127.0.0.1 或 ::1，此项尚未保存");
    }
    let config = providerConfig.saveActive(
      { ...existing, apiKeys: keysToWrite },
      provider,
      profilesToWrite[provider] || {},
      globalsToWrite,
      providerConfig.KEYLESS_PROVIDERS.has(provider) ? "" : String(keysToWrite[provider] || ""),
    );
    const providerSettings = { ...config.providerSettings };
    for (const [id, patch] of Object.entries(profilesToWrite)) providerSettings[id] = { ...providerSettings[id], ...patch };
    config = {
      ...config,
      providerSettings,
      ...providerSettings[provider],
      apiKeys: keysToWrite,
      apiKey: providerConfig.KEYLESS_PROVIDERS.has(provider) ? "" : String(keysToWrite[provider] || ""),
    };
    await extensionApi.storage.local.set({ [STORAGE_KEY]: config });
    return { config, profilesToWrite, globalsToWrite, keysToWrite, deferred, provider };
  });

  rawConfig = result.config;
  const currentProfiles = { ...result.config.providerSettings };
  for (const [id, patch] of Object.entries(pendingProfilePatches)) currentProfiles[id] = { ...currentProfiles[id], ...patch };
  localProviderSettings = currentProfiles;
  localApiKeys = { ...result.config.apiKeys, ...Object.fromEntries([...dirtyKeys].map((id) => [id, localApiKeys[id]])) };
  removeMatchingPatchValues(pendingProfilePatches, result.profilesToWrite);
  for (const [field, value] of Object.entries(result.globalsToWrite)) {
    if (Object.is(pendingGlobalPatch[field], value)) delete pendingGlobalPatch[field];
  }
  for (const [id, value] of Object.entries(keySnapshot)) {
    if (Object.is(String(localApiKeys[id] || "").trim(), value) && String(localApiKeys[id] || "").trim() === value) dirtyKeys.delete(id);
  }
  configDirty = activeProvider !== result.provider || hasStagedData();
  if (!configDirty) {
    const target = document.getElementById("target");
    const targetValue = String(result.config.target || "ZH").toUpperCase();
    if ([...target.options].some((option) => option.value === targetValue)) target.value = targetValue;
    setInputValue("appearance", result.config.appearance || "auto");
    applyAppearance(result.config.appearance || "auto");
  }
  if (result.deferred.length) setStatus(`${result.deferred.join("；")}。其他设置已保存。`, true);
  else setStatus(hasPendingChanges() ? "等待自动保存…" : "已保存");
}

// Capture the old provider's form values before provider_setup's bubble-phase
// listener swaps the shared controls to the newly selected profile.
document.getElementById("provider").addEventListener("change", applyProviderDefaults, true);
document.getElementById("apiKey").addEventListener("input", (event) => {
  configDirty = true;
  const id = event.target.dataset.forProvider;
  if (id) {
    localApiKeys[id] = event.target.value.trim();
    dirtyKeys.add(id);
    setup?.syncConfiguration({ keys: { [id]: localApiKeys[id] } });
    scheduleAutoSave();
  }
});
document.getElementById("apiKey").addEventListener("change", (event) => {
  const provider = event.target.dataset.forProvider;
  if (provider) { localApiKeys[provider] = event.target.value.trim(); dirtyKeys.add(provider); scheduleAutoSave(true); }
});
for (const id of ["model", "endpoint", "openaiApiProtocol", "target", ...performanceFields, "reasoningEffort", "deepseekThinkingMode", "deeplFormality", "useLocalBackend", "backendUrl", "appearance"]) {
  document.getElementById(id)?.addEventListener("input", () => {
    if (providerConfig.PROFILE_FIELDS.includes(id)) captureProfileField(id);
    else captureGlobalField(id);
  });
  document.getElementById(id)?.addEventListener("change", () => {
    if (providerConfig.PROFILE_FIELDS.includes(id)) captureProfileField(id);
    else captureGlobalField(id);
    scheduleAutoSave(true);
  });
}
document.getElementById("appearance").addEventListener("change", (event) => applyAppearance(event.target.value));
document.getElementById("resetAdvancedBtn")?.addEventListener("click", resetAdvancedSettings);
document.getElementById("undoAdvancedResetBtn")?.addEventListener("click", undoAdvancedReset);
document.getElementById("retrySaveBtn")?.addEventListener("click", () => flushAutoSave());
for (const id of ["endpoint", "backendUrl", "apiKey", "customModel", ...performanceFields]) {
  document.getElementById(id)?.addEventListener("blur", () => {
    if (hasPendingChanges()) scheduleAutoSave(true);
  });
}
window.addEventListener("pagehide", () => { if (hasPendingChanges()) flushAutoSave(); });

setup = window.Echo360ProviderSetup.mount({
  storageKey: STORAGE_KEY,
  localBackendEnabled: enableLocalBackend,
  elements: {
    provider: document.getElementById("provider"),
    apiKey: document.getElementById("apiKey"),
    apiKeyHint: document.getElementById("apiKeyHint"),
    model: document.getElementById("model"),
    modelPickerControl: document.getElementById("modelPickerControl"),
    modelPickerToggle: document.getElementById("modelPickerToggle"),
    modelPickerPanel: document.getElementById("modelPickerPanel"),
    modelPickerValue: document.getElementById("modelPickerValue"),
    modelSearch: document.getElementById("modelSearch"),
    modelOptions: document.getElementById("modelOptions"),
    customModelEnabled: document.getElementById("customModelEnabled"),
    customModel: document.getElementById("customModel"),
    endpoint: document.getElementById("endpoint"),
    openaiApiProtocol: document.getElementById("openaiApiProtocol"),
    target: document.getElementById("target"),
    catalogStatus: document.getElementById("catalogStatus"),
    verificationStatus: document.getElementById("verificationStatus"),
    refreshModels: document.getElementById("refreshModels"),
    verifyProvider: document.getElementById("verifyProvider"),
    showIncompatible: document.getElementById("showIncompatible"),
    testHelp: document.getElementById("testHelp"),
    useLocalBackend: document.getElementById("useLocalBackend"),
    reasoningEffort: document.getElementById("reasoningEffort"),
    deepseekThinkingMode: document.getElementById("deepseekThinkingMode"),
    deeplFormality: document.getElementById("deeplFormality"),
    timeout: document.getElementById("timeout"),
  },
  onProfileChange: profileChanged,
  onApiKeyChange: apiKeyChanged,
  persistApiKeys: false,
});

refreshBuildUi();
loadConfig().catch((error) => setStatus(`加载失败：${error?.message || String(error)}`, true));
