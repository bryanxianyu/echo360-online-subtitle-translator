(() => {
  const ns = window.Echo360Translator;

  console.log("[echo360-translator] content script loaded:", location.href);

  ns.controller.init();
})();
