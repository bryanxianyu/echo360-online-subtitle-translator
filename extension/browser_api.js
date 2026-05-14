(() => {
  const root = globalThis;
  const ns = root.Echo360Translator = root.Echo360Translator || {};
  const rawApi = root.browser || root.chrome;

  if (!rawApi) {
    throw new Error("WebExtension API is not available");
  }

  const usesPromiseApi = !!root.browser && rawApi === root.browser;

  function lastRuntimeError() {
    return rawApi.runtime?.lastError || root.chrome?.runtime?.lastError || null;
  }

  function callApi(fn, thisArg, args) {
    if (usesPromiseApi) {
      try {
        return Promise.resolve(fn.apply(thisArg, args));
      } catch (err) {
        return Promise.reject(err);
      }
    }

    return new Promise((resolve, reject) => {
      try {
        fn.apply(thisArg, [
          ...args,
          (result) => {
            const err = lastRuntimeError();
            if (err) {
              reject(new Error(err.message || String(err)));
              return;
            }
            resolve(result);
          },
        ]);
      } catch (err) {
        reject(err);
      }
    });
  }

  const api = {
    raw: rawApi,
    runtime: {
      getURL(path) {
        return rawApi.runtime.getURL(path);
      },
      sendMessage(message) {
        return callApi(rawApi.runtime.sendMessage, rawApi.runtime, [message]);
      },
      addOnMessageListener(listener) {
        if (usesPromiseApi) {
          rawApi.runtime.onMessage.addListener((message, sender) => listener(message, sender));
          return;
        }

        rawApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
          let result;
          try {
            result = listener(message, sender);
          } catch (err) {
            sendResponse({ ok: false, error: err?.message || String(err) });
            return false;
          }

          if (result && typeof result.then === "function") {
            result
              .then((response) => sendResponse(response))
              .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
            return true;
          }

          if (typeof result !== "undefined") {
            sendResponse(result);
          }
          return false;
        });
      },
    },
    storage: {
      local: {
        get(keys) {
          return callApi(rawApi.storage.local.get, rawApi.storage.local, [keys]);
        },
        set(items) {
          return callApi(rawApi.storage.local.set, rawApi.storage.local, [items]);
        },
        remove(keys) {
          return callApi(rawApi.storage.local.remove, rawApi.storage.local, [keys]);
        },
      },
    },
  };

  ns.browserApi = api;
  root.Echo360ExtensionApi = api;
})();
