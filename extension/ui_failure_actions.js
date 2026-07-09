(() => {
  const ns = window.Echo360Translator;
  const { SUBTITLE_FAILURE_LABEL } = ns.constants;

  // Shown below the video when incremental preview ends in failure. WebVTT /
  // native CC text cannot host real links, so this bar carries the interactive
  // 重试 / 取消 actions while failed cues keep the plain [翻译失败] label.
  function create(root) {
    const bar = document.createElement("div");
    bar.id = "echo360-translator-failure-actions";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    bar.style.display = "none";
    bar.innerHTML = `
      <span class="echo360-failure-label"></span>
      <button type="button" class="echo360-failure-link" data-action="retry">重试</button>
      <span class="echo360-failure-sep" aria-hidden="true">·</span>
      <button type="button" class="echo360-failure-link" data-action="cancel">取消</button>
    `;
    root.appendChild(bar);

    const label = bar.querySelector(".echo360-failure-label");
    const retryBtn = bar.querySelector('[data-action="retry"]');
    const cancelBtn = bar.querySelector('[data-action="cancel"]');
    const actionHandlers = { onRetry: null, onCancel: null };

    retryBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      actionHandlers.onRetry?.();
    });
    cancelBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      actionHandlers.onCancel?.();
    });

    return {
      show(handlers = {}) {
        actionHandlers.onRetry = handlers.onRetry || null;
        actionHandlers.onCancel = handlers.onCancel || null;
        label.textContent = SUBTITLE_FAILURE_LABEL;
        bar.style.display = "flex";
      },
      hide() {
        bar.style.display = "none";
        actionHandlers.onRetry = null;
        actionHandlers.onCancel = null;
      },
      isVisible() {
        return bar.style.display !== "none";
      },
    };
  }

  ns.uiFailureActions = { create };
})();
