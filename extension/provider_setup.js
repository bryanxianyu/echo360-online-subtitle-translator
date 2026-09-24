(() => {
  const root = globalThis;
  const configApi = root.Echo360ProviderConfig;
  const extensionApi = root.Echo360ExtensionApi;
  const HISTORY_KEY = "echo360ProviderValidationHistory";
  const STATUS_LABELS = {
    invalid_key: "Key 无效或已失效",
    permission_denied: "Key 或账号无权使用此接口/模型",
    quota_exceeded: "账户额度或配额不足",
    rate_limited: "服务暂时限流，请稍后重试",
    model_unavailable: "模型不可用或不支持此接口",
    invalid_configuration: "服务地址或参数不兼容",
    host_permission_required: "请允许扩展访问此服务地址",
    discovery_unavailable: "无法获取模型列表，可手动输入模型 ID 后测试",
    network_error: "网络连接失败，尚不能判断 Key 是否有效",
    timeout: "服务请求超时",
    invalid_response: "服务返回了无效或空的翻译结果",
    cancelled: "已取消",
  };

  function storageGet(key) { return extensionApi.storage.local.get(key); }
  function storageSet(value) { return extensionApi.storage.local.set(value); }
  async function hash(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function createRequestId() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

  function mount(options = {}) {
    const el = options.elements || {};
    const localBackendEnabled = options.localBackendEnabled !== false;
    const required = ["provider", "apiKey", "model", "modelOptions", "catalogStatus", "verificationStatus", "verifyProvider"];
    for (const key of required) if (!el[key]) throw new Error(`Provider setup missing element: ${key}`);
    const state = { config: {}, profiles: {}, keys: {}, models: [], catalogLoadedFresh: false, discoveryRevision: 0, verificationRevision: 0, verificationSuccessStamp: "", discoveryRequestId: "", verificationRequestId: "", discoveryStamp: "", discoveryPromise: null, verificationPromise: null, timer: 0, modelTimer: 0, dirty: new Set(), destroyed: false };

    function provider() { return el.provider.value || "google-web"; }
    function key() { return String(el.apiKey.value || "").trim(); }
    function context() {
      const profile = currentProfile();
      return {
        provider: provider(),
        apiKey: key(),
        endpoint: String(el.endpoint?.value ?? profile.endpoint ?? "").trim(),
        model: String(el.model.value || "").trim(),
        modelMode: profile.modelMode === "custom" ? "custom" : "catalog",
        target: String(el.target?.value || state.config.target || "ZH").trim().toUpperCase(),
        openaiApiProtocol: provider() === "openai"
          ? String(el.openaiApiProtocol?.value ?? profile.openaiApiProtocol ?? "responses")
          : "",
        reasoningEffort: el.reasoningEffort?.value ?? profile.reasoningEffort ?? "",
        deepseekThinkingMode: el.deepseekThinkingMode?.value ?? profile.deepseekThinkingMode ?? "disabled",
        deeplFormality: el.deeplFormality?.value ?? profile.deeplFormality ?? "",
        timeout: Math.min(30, Math.max(1, Number(el.timeout?.value ?? profile.timeout) || 30)),
        useLocalBackend: localBackendEnabled && !!(el.useLocalBackend ? el.useLocalBackend.checked : state.config.useLocalBackend),
      };
    }
    function mark(kind, text, error = false) {
      const node = el[kind];
      node.textContent = text;
      node.dataset.state = error ? "error" : "info";
      node.classList.toggle("error", !!error);
    }
    function labelError(error) {
      const category = error?.category || "network_error";
      const base = STATUS_LABELS[category] || "服务请求失败";
      const detail = String(error?.message || "").slice(0, 180);
      const retry = Number(error?.retryAfterSeconds) > 0 ? `（建议 ${Number(error.retryAfterSeconds)} 秒后重试）` : "";
      return `${base}${detail ? `：${detail}` : ""}${retry}`;
    }
    async function signature(value) {
      const { apiKey, ...rest } = value;
      return hash(JSON.stringify([rest, await hash(apiKey || "")]));
    }
    function cancelCurrent(kind) {
      const idKey = kind === "discover" ? "discoveryRequestId" : "verificationRequestId";
      const oldId = state[idKey];
      state[idKey] = "";
      if (oldId) Promise.resolve(extensionApi.runtime.sendMessage({ type: "provider-cancel", requestId: oldId })).catch(() => {});
    }
    function invalidate(reason = "配置已更改，请重新验证", clearCatalog = true) {
      state.verificationRevision += 1;
      state.verificationPromise = null;
      state.verificationSuccessStamp = "";
      clearTimeout(state.modelTimer);
      el.verifyProvider.disabled = false;
      cancelCurrent("verify");
      if (clearCatalog) {
        state.discoveryRevision += 1;
        cancelCurrent("discover");
        state.discoveryStamp = "";
        state.discoveryPromise = null;
        state.models = [];
        state.catalogLoadedFresh = false;
      }
      if (reason) mark("verificationStatus", reason);
      mark("catalogStatus", configApi.KEYLESS_PROVIDERS.has(provider()) ? "无需 Key；点击验证服务" : "配置已更改，等待验证");
      renderModels();
      showVerificationHistory();
    }
    function currentProfile() { return state.profiles[provider()] || configApi.resolve(state.config, provider()); }
    function saveProfilePatch(patch) {
      const id = provider();
      state.profiles[id] = { ...(state.profiles[id] || configApi.resolve(state.config, id)), ...patch };
      options.onProfileChange?.(id, patch, state.profiles[id]);
    }
    function persistKey(id, value) {
      const cleaned = String(value || "").trim();
      if (configApi.KEYLESS_PROVIDERS.has(id)) return;
      state.keys[id] = cleaned;
      options.onApiKeyChange?.(id, cleaned);
      if (options.persistApiKeys === false) return;
      storageGet(options.storageKey || "echo360TranslatorConfig").then((result) => {
        const raw = result[options.storageKey || "echo360TranslatorConfig"] || {};
        const normalized = configApi.migrate(raw);
        const apiKeys = { ...normalized.apiKeys, [id]: cleaned };
        const updated = { ...normalized, apiKeys };
        if (normalized.provider === id) updated.apiKey = cleaned;
        return storageSet({ [options.storageKey || "echo360TranslatorConfig"]: updated });
      }).catch(() => {});
    }
    function renderModels() {
      if (!el.modelOptions) return;
      const showIncompatible = !!el.showIncompatible?.checked;
      const selected = String(currentProfile().catalogModel || "").trim();
      const query = String(el.modelPickerPanel && !el.modelPickerPanel.hidden ? el.modelSearch?.value || "" : "").trim();
      const searchableText = (value) => {
        const text = String(value || "").normalize("NFKC").toLowerCase();
        return { text, compact: text.replace(/[^a-z0-9]/g, " ").replace(/\s+/g, "") };
      };
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const filtered = state.models.filter((model) => {
        if (!showIncompatible && model.eligibility === "incompatible") return false;
        if (!terms.length) return true;
        const id = searchableText(model.id);
        const name = searchableText(model.displayName || model.id);
        const text = `${id.text} ${name.text}`;
        const compact = `${id.compact}${name.compact}`;
        const normalizedQuery = searchableText(query);
        return text.includes(normalizedQuery.text) || (normalizedQuery.compact && compact.includes(normalizedQuery.compact))
          || terms.every((term) => text.includes(term));
      });
      el.modelOptions.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.disabled = true;
      placeholder.textContent = query
        ? filtered.length ? "选择搜索结果" : "没有匹配的模型"
        : state.models.length ? filtered.length ? "请选择模型" : "没有可选模型；可显示不兼容模型或启用手动输入"
          : "尚无模型目录；请刷新或勾选输入自定义名称";
      el.modelOptions.appendChild(placeholder);
      const selectedInFiltered = filtered.some((model) => model.id === selected);
      if (!query && selected && !selectedInFiltered) {
        const current = state.models.find((model) => model.id === selected);
        const unavailable = document.createElement("option");
        unavailable.value = selected;
        unavailable.disabled = true;
        unavailable.textContent = current
          ? `${selected}（已保存；当前被兼容性筛选隐藏）`
          : `${selected}（已保存；当前目录未返回）`;
        unavailable.dataset.eligibility = current?.eligibility || "unknown";
        el.modelOptions.appendChild(unavailable);
      }
      for (const model of filtered) {
        const option = document.createElement("option");
        option.value = model.id;
        const name = model.displayName || model.id;
        option.textContent = model.eligibility === "incompatible" ? `${name}（不兼容）` : name;
        option.dataset.eligibility = model.eligibility;
        option.title = [model.id, model.eligibility === "incompatible" && model.reason].filter(Boolean).join("；");
        option.selected = model.id === selected;
        el.modelOptions.appendChild(option);
      }
      el.modelOptions.value = selected || "";
      if (!selected || ![...el.modelOptions.options].some((option) => option.value === selected)) el.modelOptions.selectedIndex = 0;
      el.modelOptions.disabled = configApi.KEYLESS_PROVIDERS.has(provider()) || provider() === "deepl";
      if (el.modelPickerToggle) el.modelPickerToggle.disabled = el.modelOptions.disabled;
      if (el.modelPickerValue) {
        const current = state.models.find((model) => model.id === selected);
        const visible = filtered.find((model) => model.id === selected);
        const label = visible || current;
        el.modelPickerValue.textContent = selected
          ? `${label?.displayName || selected}${current && current.eligibility === "incompatible" && !showIncompatible ? "（不兼容）" : ""}`
          : "请选择模型";
        if (el.modelPickerToggle) el.modelPickerToggle.title = selected;
      }
    }
    function setModelPickerOpen(open) {
      if (!el.modelPickerPanel || !el.modelPickerToggle) return;
      const enabled = open && el.customModelEnabled?.checked !== true;
      el.modelPickerPanel.hidden = !enabled;
      el.modelPickerToggle.setAttribute("aria-expanded", String(enabled));
      if (enabled) {
        if (el.modelSearch) el.modelSearch.value = "";
        renderModels();
        el.modelSearch?.focus();
      } else {
        if (el.modelSearch) el.modelSearch.value = "";
        renderModels();
      }
    }
    function onOutsidePickerPointer(event) {
      if (!el.modelPickerPanel || el.modelPickerPanel.hidden) return;
      if (el.modelPickerPanel.contains(event.target) || el.modelPickerToggle?.contains(event.target)) return;
      setModelPickerOpen(false);
    }
    function syncModelControls(profile = currentProfile()) {
      const mode = profile.modelMode === "custom" ? "custom" : "catalog";
      const custom = mode === "custom";
      const activeModel = String(custom ? profile.customModel ?? profile.model ?? "" : profile.catalogModel ?? profile.model ?? "").trim();
      if (el.customModelEnabled) el.customModelEnabled.checked = custom;
      if (el.customModel) el.customModel.hidden = !custom;
      if (el.modelPickerControl) el.modelPickerControl.hidden = custom;
      if (el.customModel) el.customModel.value = String(profile.customModel ?? (custom ? activeModel : ""));
      el.model.value = activeModel;
      el.modelPickerToggle?.setAttribute("aria-expanded", "false");
      if (el.modelPickerPanel) el.modelPickerPanel.hidden = true;
      if (el.modelSearch) el.modelSearch.value = "";
      el.modelPickerToggle?.closest(".provider-model-section")?.querySelector("label")?.setAttribute("for", custom ? "customModel" : "modelPickerToggle");
      renderModels();
    }
    function syncProvider() {
      const id = provider();
      const isKeyless = configApi.KEYLESS_PROVIDERS.has(id);
      const hasModel = ["openai", "deepseek", "gemini"].includes(id);
      el.apiKey.disabled = isKeyless;
      el.apiKey.value = isKeyless ? "" : String(state.keys[id] || "");
      el.apiKey.dataset.forProvider = isKeyless ? "" : id;
      el.model.closest(".provider-model-section")?.toggleAttribute("hidden", !hasModel);
      if (el.refreshModels) el.refreshModels.disabled = !hasModel;
      el.verifyProvider.textContent = "点此验证服务";
      const profile = currentProfile();
      syncModelControls(profile);
      if (el.endpoint) el.endpoint.value = String(profile.endpoint || "");
      if (el.openaiApiProtocol) el.openaiApiProtocol.value = profile.openaiApiProtocol || "responses";
      const hints = {
        "google-web": "Google Translate 不需要 API Key。",
        deepl: "Key 只用于验证当前 DeepL 地址；翻译测试会产生少量 API 用量。",
      };
      if (el.apiKeyHint) el.apiKeyHint.textContent = isKeyless ? hints[id] : "Key 保存在 Chrome 本地，仅发送给所选服务地址。";
      if (el.testHelp) el.testHelp.textContent = "";
    }
    async function send(type, payload, kind, revision) {
      const requestId = createRequestId();
      const idKey = kind === "discover" ? "discoveryRequestId" : "verificationRequestId";
      const revisionKey = kind === "discover" ? "discoveryRevision" : "verificationRevision";
      state[idKey] = requestId;
      const result = await extensionApi.runtime.sendMessage({ type, requestId, payload });
      if (state.destroyed || state[revisionKey] !== revision || state[idKey] !== requestId) return null;
      state[idKey] = "";
      return result;
    }
    async function showCachedModels() {
      const value = context();
      if (configApi.KEYLESS_PROVIDERS.has(value.provider) || value.provider === "deepl" || !value.apiKey) return;
      const revision = state.discoveryRevision;
      const result = await extensionApi.runtime.sendMessage({ type: "provider-cache", payload: value });
      if (state.destroyed || revision !== state.discoveryRevision || state.catalogLoadedFresh || !result?.ok || !result.data) return;
      state.models = result.data.models || [];
      const age = Date.now() - Number(result.data.fetchedAt || 0);
      const stale = age > 24 * 60 * 60 * 1000;
      mark("catalogStatus", `缓存模型 ${state.models.length} 个${stale ? "（已过期）" : ""}；上次读取 ${new Date(result.data.fetchedAt).toLocaleString()}`);
      renderModels();
    }
    async function showVerificationHistory() {
      try {
        const revision = state.verificationRevision;
        const stamp = await signature(context());
        const values = await storageGet(HISTORY_KEY);
        if (state.destroyed || revision !== state.verificationRevision) return;
        const item = values[HISTORY_KEY]?.[stamp];
        if (item?.verifiedAt) {
          state.verificationSuccessStamp = stamp;
          if (!state.verificationPromise) mark("verificationStatus", `上次测试成功：${new Date(item.verifiedAt).toLocaleString()}（${item.execution === "provider_direct" ? "服务直连" : "本地后端"}）`);
        }
      } catch (_) { /* History is optional; it never blocks configuration. */ }
    }
    async function saveVerificationHistory(value, data) {
      try {
        const stamp = await signature(value);
        const values = await storageGet(HISTORY_KEY);
        const entries = { ...(values[HISTORY_KEY] || {}), [stamp]: { verifiedAt: data.verifiedAt || Date.now(), execution: data.execution || "provider_direct" } };
        const recent = Object.entries(entries).sort((a, b) => b[1].verifiedAt - a[1].verifiedAt).slice(0, 20);
        await storageSet({ [HISTORY_KEY]: Object.fromEntries(recent) });
      } catch (_) { /* History is optional. */ }
    }
    async function discover(force = false, { verifyAfter = true } = {}) {
      const revision = state.discoveryRevision;
      const verificationRevision = state.verificationRevision;
      const value = context();
      if (configApi.KEYLESS_PROVIDERS.has(value.provider)) return verify();
      if (!value.apiKey) { invalidate("请先填写 API Key"); return null; }
      if (value.provider === "deepl" && !value.endpoint) value.endpoint = "";
      let stamp;
      try { stamp = await hash(JSON.stringify([value.provider, value.endpoint, await hash(value.apiKey)])); }
      catch (_) { mark("catalogStatus", "浏览器暂不支持安全指纹计算", true); return null; }
      if (state.destroyed || revision !== state.discoveryRevision) return null;
      if (state.discoveryStamp === stamp && state.discoveryPromise) return state.discoveryPromise;
      if (!force && state.discoveryStamp === stamp && state.models.length) return null;
      const verificationStamp = await signature(value);
      if (state.destroyed || revision !== state.discoveryRevision) return null;
      mark("catalogStatus", value.provider === "deepl" ? "正在检查 Key 和账户用量…" : "正在验证 Key 并获取模型…");
      state.discoveryStamp = stamp;
      let requestPromise;
      requestPromise = send("provider-discover", value, "discover", revision).then(async (result) => {
        if (!result) return null;
        if (!result.ok) {
          mark("catalogStatus", labelError(result.error), true);
          if (result.error?.category === "invalid_key") mark("verificationStatus", "未执行翻译测试：请检查 API Key", true);
          if (state.models.length) mark("catalogStatus", `${labelError(result.error)}；保留了旧模型目录`, true);
          return result;
        }
        state.models = result.data?.models || [];
        state.catalogLoadedFresh = true;
        renderModels();
        const count = state.models.length;
        mark("catalogStatus", value.provider === "deepl"
          ? `Key 已通过用量接口检查${result.data?.usage?.characterLimit ? `；周期额度 ${result.data.usage.characterCount || 0}/${result.data.usage.characterLimit}` : ""}`
          : count ? `凭据已通过模型目录接口；返回 ${count} 个模型（不代表所选模型已可翻译）` : "服务返回空模型目录；可手动输入模型 ID 并测试");
        if (verifyAfter && (value.provider === "deepl" || (value.provider !== "google-web" && value.model))) {
          const selectedModel = value.provider === "deepl" ? null : state.models.find((model) => model.id === value.model);
          if (value.provider !== "deepl" && (!selectedModel || selectedModel.eligibility === "incompatible")) {
            const status = selectedModel
              ? "当前模型与翻译接口不兼容，请从目录重新选择"
              : value.modelMode === "custom"
                ? "当前自定义模型未出现在目录中；可手动点击“点此验证服务”"
                : "当前模型未在此服务目录中找到，请重新选择模型后验证";
            mark("verificationStatus", status, !!selectedModel);
          } else if (selectedModel || value.provider === "deepl") {
            const currentStamp = await signature(context());
            if (state.verificationRevision === verificationRevision
              && currentStamp === verificationStamp
              && state.verificationSuccessStamp !== verificationStamp) await verify();
          }
        } else if (verifyAfter && value.provider !== "google-web" && !value.model) {
          mark("verificationStatus", "模型目录已读取，请先选择模型再验证");
        }
        return result;
      }).catch((error) => {
        if (!state.destroyed && state.discoveryRevision === revision) mark("catalogStatus", labelError({ category: error.category || "network_error", message: error.message }), true);
        return null;
      }).finally(() => { if (state.discoveryPromise === requestPromise) state.discoveryPromise = null; });
      state.discoveryPromise = requestPromise;
      return requestPromise;
    }
    function verify() {
      clearTimeout(state.modelTimer);
      const value = context();
      if (!configApi.KEYLESS_PROVIDERS.has(value.provider) && !value.apiKey) {
        mark("verificationStatus", "请先填写 API Key", true);
        return Promise.resolve(null);
      }
      if (["openai", "deepseek", "gemini"].includes(value.provider) && !value.model) {
        mark("verificationStatus", "请先选择或手动输入模型 ID");
        return Promise.resolve(null);
      }
      if (state.verificationPromise) return state.verificationPromise;
      const revision = state.verificationRevision;
      mark("verificationStatus", "正在发送短句测试翻译…");
      el.verifyProvider.disabled = true;
      let operation;
      operation = (async () => {
        try {
          const result = await send("provider-verify", value, "verify", revision);
          if (!result) return null;
          if (!result.ok) {
            mark("verificationStatus", labelError(result.error), true);
            return result;
          }
          const execution = value.useLocalBackend ? "服务直连；本地后端未验证" : "服务直连";
          mark("verificationStatus", `翻译测试通过：${new Date(result.data.verifiedAt).toLocaleTimeString()}（${execution}）`);
          const successStamp = await signature(value);
          if (state.verificationRevision === revision) state.verificationSuccessStamp = successStamp;
          await saveVerificationHistory(value, result.data);
          return result;
        } catch (error) {
          if (state.verificationRevision === revision) mark("verificationStatus", labelError({ category: error.category || "network_error", message: error.message }), true);
          return null;
        } finally {
          if (state.verificationPromise === operation) {
            state.verificationPromise = null;
            el.verifyProvider.disabled = false;
          }
        }
      })();
      state.verificationPromise = operation;
      return operation;
    }
    function scheduleDiscover() {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => { discover(false); }, 1000);
    }
    function permissionContextKey(value) {
      return JSON.stringify([value.provider, value.apiKey, value.endpoint, value.model, value.target, value.openaiApiProtocol]);
    }
    function requestEndpointPermission(value, resource) {
      if (value.provider === "google-web" || !value.apiKey) return Promise.resolve(true);
      let endpoint;
      try {
        endpoint = value.provider === "deepl"
          ? configApi.deeplEndpointFor(value.endpoint, resource, value.apiKey)
          : configApi.endpointFor(value.provider, value.endpoint, resource, value.model, value.openaiApiProtocol);
      } catch (error) {
        return Promise.reject(error);
      }
      const permissions = extensionApi.raw?.permissions;
      if (!permissions?.request) return Promise.resolve(true);
      const origin = `${new URL(endpoint).origin}/*`;
      const request = { origins: [origin] };
      try {
        if (root.browser && extensionApi.raw === root.browser) {
          return Promise.resolve(permissions.request(request)).then(Boolean);
        }
        return new Promise((resolve) => permissions.request(request, (granted) => resolve(!!granted)));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    function runFromUserGesture(resource, action, statusKind) {
      const value = context();
      const capturedContext = permissionContextKey(value);
      // Call permissions.request synchronously from the click handler so the
      // browser can associate its optional-host prompt with the user gesture.
      return requestEndpointPermission(value, resource).then((granted) => {
        if (permissionContextKey(context()) !== capturedContext) return null;
        if (!granted) {
          const status = "未获准访问此服务地址；可允许访问后重试";
          mark(statusKind, status, true);
          return null;
        }
        return action();
      }).catch((error) => {
        mark(statusKind, labelError({ category: "invalid_configuration", message: error.message }), true);
        return null;
      });
    }
    function changed(reason) {
      invalidate(reason, true);
      const patch = { model: String(el.model.value || "").trim() };
      if (el.endpoint) patch.endpoint = String(el.endpoint.value || "").trim();
      saveProfilePatch(patch);
    }
    function onKeyInput() {
      invalidate("API Key 已更改，等待检查", true);
      if (key()) scheduleDiscover();
    }
    function onEndpointInput() {
      clearTimeout(state.timer);
      changed("服务地址已更改，请离开输入框后重新验证");
    }
    function applyModel(mode, model) {
      const selectedModel = String(model || "").trim();
      const patch = mode === "custom"
        ? { modelMode: "custom", customModel: selectedModel, model: selectedModel }
        : { modelMode: "catalog", catalogModel: selectedModel, model: selectedModel };
      el.model.value = selectedModel;
      saveProfilePatch(patch);
      invalidate("尚未测试此配置", false);
      clearTimeout(state.modelTimer);
    }
    function chooseCatalogModel(model) {
      const selectedModel = String(model || "").trim();
      if (!selectedModel) return;
      applyModel("catalog", selectedModel);
      setModelPickerOpen(false);
      el.modelPickerToggle?.focus();
    }
    function onTargetInput() { invalidate("尚未测试此配置", false); }
    function onProfileParamInput() { invalidate("尚未测试此配置", false); }
    function onOpenAiProtocolInput() {
      invalidate("尚未测试此配置", true);
      showCachedModels();
    }
    function onProviderChange() {
      clearTimeout(state.timer);
      const priorKey = el.apiKey.dataset.forProvider;
      if (priorKey) persistKey(priorKey, el.apiKey.value);
      invalidate("", true);
      syncProvider();
      showCachedModels();
      mark("catalogStatus", key()
        ? "显示本地缓存；点击刷新可读取最新模型目录"
        : configApi.KEYLESS_PROVIDERS.has(provider()) ? "无需 Key；点击验证服务" : "填写 API Key 后自动检查凭据并读取模型");
    }

    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      clearTimeout(state.timer);
      clearTimeout(state.modelTimer);
      cancelCurrent("discover");
      cancelCurrent("verify");
      document.removeEventListener("pointerdown", onOutsidePickerPointer);
      root.removeEventListener?.("pagehide", destroy);
    }

    el.provider.addEventListener("change", onProviderChange);
    el.apiKey.addEventListener("input", onKeyInput);
    el.apiKey.addEventListener("blur", () => { clearTimeout(state.timer); if (key()) discover(false); });
    el.endpoint?.addEventListener("input", onEndpointInput);
    el.endpoint?.addEventListener("blur", () => { if (provider() !== "google-web" && (key() || provider() === "deepl")) discover(true); });
    // Keep integrations that still write the hidden effective-model field in
    // sync; users edit only the visible select or custom text field.
    el.model.addEventListener("input", () => {
      applyModel(el.customModelEnabled?.checked ? "custom" : "catalog", el.model.value);
    });
    el.modelPickerToggle?.addEventListener("click", () => setModelPickerOpen(el.modelPickerPanel?.hidden));
    document.addEventListener("pointerdown", onOutsidePickerPointer);
    el.modelSearch?.addEventListener("input", renderModels);
    el.modelSearch?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setModelPickerOpen(false);
        el.modelPickerToggle?.focus();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        const options = [...el.modelOptions.options];
        const firstEnabledIndex = options.findIndex((option) => !option.disabled && option.value);
        if (el.modelOptions.selectedIndex < 0 || el.modelOptions.value === "") el.modelOptions.selectedIndex = firstEnabledIndex;
        el.modelOptions.focus();
      } else if (event.key === "Enter") {
        const query = String(el.modelSearch.value || "").trim().toLowerCase();
        if (!query) return;
        const exact = [...el.modelOptions.options].find((option) => !option.disabled
          && (option.value.toLowerCase() === query || option.textContent.toLowerCase() === query));
        if (exact) {
          event.preventDefault();
          chooseCatalogModel(exact.value);
        }
      }
    });
    el.modelOptions.addEventListener("change", () => {
      if (!el.modelOptions.value) return;
      chooseCatalogModel(el.modelOptions.value);
    });
    el.customModelEnabled?.addEventListener("change", () => {
      const profile = currentProfile();
      if (el.customModelEnabled.checked) {
        const previousCustom = profile.customModel;
        const custom = String(previousCustom !== null && previousCustom !== undefined
          ? previousCustom
          : el.model.value || profile.catalogModel || "").trim();
        if (el.customModel) el.customModel.value = custom;
        applyModel("custom", custom);
        syncModelControls(currentProfile());
        el.customModel?.focus();
        el.customModel?.select();
      } else {
        const catalog = String(profile.catalogModel || configApi.DEFAULTS[provider()]?.catalogModel || "").trim();
        applyModel("catalog", catalog);
        syncModelControls(currentProfile());
      }
    });
    el.customModel?.addEventListener("input", () => {
      applyModel("custom", el.customModel.value);
    });
    el.showIncompatible?.addEventListener("change", renderModels);
    el.target?.addEventListener("change", onTargetInput);
    el.openaiApiProtocol?.addEventListener("change", onOpenAiProtocolInput);
    for (const id of ["reasoningEffort", "deepseekThinkingMode", "deeplFormality", "timeout", "useLocalBackend"]) {
      el[id]?.addEventListener("input", onProfileParamInput);
      el[id]?.addEventListener("change", onProfileParamInput);
    }
    el.refreshModels?.addEventListener("click", () => runFromUserGesture("models", () => discover(true, { verifyAfter: false }), "catalogStatus"));
    el.verifyProvider.addEventListener("click", () => runFromUserGesture("translate", () => verify(), "verificationStatus"));
    el.apiKey.addEventListener("change", () => { if (el.apiKey.dataset.forProvider) persistKey(el.apiKey.dataset.forProvider, el.apiKey.value); });
    root.addEventListener?.("pagehide", destroy, { once: true });

    return {
      async load(rawConfig) {
        // A load can be caused by another extension surface changing storage.
        // Invalidate in-flight work before exposing the newly loaded context.
        clearTimeout(state.timer);
        clearTimeout(state.modelTimer);
        state.discoveryRevision += 1;
        state.verificationRevision += 1;
        cancelCurrent("discover");
        cancelCurrent("verify");
        state.discoveryPromise = null;
        state.verificationPromise = null;
        state.discoveryStamp = "";
        state.verificationSuccessStamp = "";
        state.models = [];
        state.catalogLoadedFresh = false;
        state.config = configApi.migrate(rawConfig || {});
        state.keys = { ...state.config.apiKeys };
        state.profiles = { ...state.config.providerSettings };
        if (state.config.provider && [...el.provider.options].some((option) => option.value === state.config.provider)) el.provider.value = state.config.provider;
        syncProvider();
        mark("verificationStatus", "尚未测试此配置");
        mark("catalogStatus", configApi.KEYLESS_PROVIDERS.has(provider())
          ? "无需 Key；点击验证服务"
          : key() ? "显示本地缓存；点击刷新可读取最新模型目录" : "填写 API Key 后自动检查凭据并读取模型");
        await Promise.all([showCachedModels(), showVerificationHistory()]);
      },
      getProfiles() { return state.profiles; },
      getKeys() { return state.keys; },
      syncConfiguration({ keys, profiles } = {}) {
        if (keys) state.keys = { ...state.keys, ...keys };
        if (profiles) state.profiles = { ...state.profiles, ...profiles };
      },
      matchesConfig(rawConfig) {
        const current = context();
        const loaded = configApi.resolve(rawConfig || {}, current.provider);
        const expected = {
          provider: current.provider,
          apiKey: configApi.KEYLESS_PROVIDERS.has(current.provider) ? "" : String(loaded.apiKey || "").trim(),
          endpoint: String(loaded.endpoint || "").trim(),
          model: String(loaded.model || "").trim(),
          modelMode: loaded.modelMode === "custom" ? "custom" : "catalog",
          target: String(loaded.target || "ZH").trim().toUpperCase(),
          openaiApiProtocol: current.provider === "openai" ? loaded.openaiApiProtocol || "responses" : "",
          reasoningEffort: loaded.reasoningEffort || "",
          deepseekThinkingMode: loaded.deepseekThinkingMode || "disabled",
          deeplFormality: loaded.deeplFormality || "",
          timeout: Math.min(30, Math.max(1, Number(loaded.timeout) || 30)),
          useLocalBackend: localBackendEnabled && !!loaded.useLocalBackend,
        };
        return Object.keys(expected).every((field) => current[field] === expected[field]);
      },
      getContext: context,
      refresh: discover,
      verify,
      validateModel() {
        if (["openai", "deepseek", "gemini"].includes(provider()) && !String(context().model || "").trim()) {
          return "请输入模型 ID";
        }
        return "";
      },
      invalidate,
      destroy,
    };
  }

  root.Echo360ProviderSetup = { mount };
})();
