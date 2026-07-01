(() => {
  const ns = window.Echo360Translator;

  // First-run onboarding: a small speech bubble + pulsing ring on the ball,
  // shown at most once per install so first-time users notice the
  // (intentionally subtle) docked icon. Depends only on the ball's public
  // show/pulse handle, not its DOM — keeps this module swappable/testable
  // independently of how the ball renders.
  //
  // Deliberately does NOT auto-hide on a timer: it only disappears once the
  // user acts on it — either by clicking the ball (which activates the
  // panel) or by explicitly dismissing it via the close button.
  function create(root, ball) {
    let bubble = null;

    function dismiss() {
      ball.stopPulse();
      if (bubble) {
        const el = bubble;
        bubble = null;
        el.classList.remove("echo360-onboarding-visible");
        setTimeout(() => el.remove(), 260);
      }
    }

    // Marks itself seen as soon as it's scheduled to display, so it won't
    // re-trigger from other lesson tabs opened around the same time.
    async function maybeShow() {
      let seen = true;
      try {
        seen = await ns.storage.getOnboardingSeen();
      } catch {
        seen = true;
      }
      if (seen) return;
      ns.storage.setOnboardingSeen().catch(() => {});

      bubble = document.createElement("div");
      bubble.id = "echo360-onboarding-bubble";
      bubble.setAttribute("role", "status");
      bubble.innerHTML = `
        <button id="echo360-onboarding-bubble-close" aria-label="关闭提示" title="关闭提示">×</button>
        <div class="echo360-onboarding-text">点这里展开字幕翻译面板</div>
      `;
      root.appendChild(bubble);
      bubble.querySelector("#echo360-onboarding-bubble-close").addEventListener("click", dismiss);

      setTimeout(() => {
        bubble?.classList.add("echo360-onboarding-visible");
        ball.pulse();
      }, 900);
    }

    return { maybeShow, dismiss };
  }

  ns.uiOnboarding = { create };
})();
