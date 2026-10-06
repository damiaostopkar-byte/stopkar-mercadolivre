(() => {
  if (window.__STOP_KAR_FULL_SCHEDULER__) return;
  window.__STOP_KAR_FULL_SCHEDULER__ = true;

  const MONTHS = [
    "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"
  ];

  let watcher = null;
  let observer = null;
  let intervalHandle = null;
  let refreshHandle = null;
  let settings = null;
  let attempts = 0;
  let overlay = null;
  let scanBusy = false;

  const normalize = (value) => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const disabled = (el) => {
    return Boolean(
      el.matches?.(":disabled") ||
      el.getAttribute?.("aria-disabled") === "true" ||
      el.getAttribute?.("disabled") !== null
    );
  };

  const dateLabel = (iso) => {
    const [year, month, day] = iso.split("-").map(Number);
    if (!year || !month || !day) return iso;
    return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
  };

  const patternsForDate = (iso) => {
    const [year, month, day] = iso.split("-").map(Number);
    if (!year || !month || !day) return [];
    const dd = String(day).padStart(2, "0");
    const mm = String(month).padStart(2, "0");
    const monthName = MONTHS[month - 1];
    return [
      `${dd}/${mm}/${year}`,
      `${day}/${month}/${year}`,
      `${dd}/${mm}`,
      `${day}/${month}`,
      `${dd} de ${monthName}`,
      `${day} de ${monthName}`,
      `${monthName} ${dd}`,
      `${monthName} ${day}`
    ].map(normalize);
  };

  const getText = (el) => normalize([
    el.getAttribute?.("aria-label"),
    el.getAttribute?.("title"),
    el.getAttribute?.("data-testid"),
    el.textContent
  ].filter(Boolean).join(" "));

  const getClickable = (el) => {
    if (!(el instanceof Element)) return null;
    const direct = el.closest("button, a, [role='button'], [role='option'], [role='gridcell'], [tabindex]");
    if (direct && visible(direct) && !disabled(direct)) return direct;
    if (visible(el) && !disabled(el)) return el;
    return null;
  };

  const candidates = () => {
    const selector = [
      "button", "a", "[role='button']", "[role='option']", "[role='gridcell']",
      "[aria-label]", "[title]", "[data-testid]"
    ].join(",");
    return Array.from(document.querySelectorAll(selector)).filter(visible);
  };

  const setOverlay = (state, detail) => {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "stopkar-full-overlay";
      Object.assign(overlay.style, {
        position: "fixed",
        right: "18px",
        bottom: "18px",
        zIndex: "2147483647",
        width: "280px",
        padding: "12px 14px",
        borderRadius: "12px",
        background: "#0f2f37",
        color: "#fff",
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
        lineHeight: "1.35",
        boxShadow: "0 10px 30px rgba(0,0,0,.25)",
        border: "1px solid rgba(255,255,255,.12)"
      });
      document.documentElement.appendChild(overlay);
    }

    const title = state === "found" ? "DATA ENCONTRADA" : state === "error" ? "ATENCAO" : "MONITORANDO FULL";
    const accent = state === "found" ? "#5dd39e" : state === "error" ? "#ff6577" : "#ff9f1c";
    overlay.innerHTML = `
      <div style="font-weight:800;letter-spacing:.04em;color:${accent};margin-bottom:4px">STOP KAR FULL · ${title}</div>
      <div style="color:#dce8eb">${detail}</div>
    `;
  };

  const report = async (patch) => {
    try {
      await chrome.runtime.sendMessage({ type: "WATCHER_STATUS", patch });
    } catch (_) {}
  };

  const markFound = (el) => {
    el.style.setProperty("outline", "4px solid #ff9f1c", "important");
    el.style.setProperty("outline-offset", "3px", "important");
    el.style.setProperty("box-shadow", "0 0 0 7px rgba(255,159,28,.20)", "important");
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  };

  const findDate = () => {
    const dates = Array.isArray(settings?.targetDates) ? settings.targetDates : [];
    const elems = candidates();

    for (const iso of dates) {
      const patterns = patternsForDate(iso);
      for (const el of elems) {
        const text = getText(el);
        if (!text || text.length > 300) continue;
        if (!patterns.some((pattern) => text.includes(pattern))) continue;
        const clickable = getClickable(el);
        if (!clickable) continue;
        return { iso, el: clickable, text };
      }
    }
    return null;
  };

  const scan = async (reason = "manual") => {
    if (!settings || scanBusy) return null;
    scanBusy = true;
    try {
      attempts += 1;
      const now = Date.now();
      const labels = (settings.targetDates || []).map(dateLabel).join(", ");
      setOverlay("running", `Procurando ${labels || "a data configurada"}. Tentativa ${attempts}.`);
      await report({
        status: "running",
        statusDetail: `Procurando ${labels || "a data configurada"}.`,
        lastCheckAt: now,
        attempts
      });

      const found = findDate();
      if (!found) return null;

      markFound(found.el);
      const mode = settings.mode === "select" ? "select" : "detect";
      if (mode === "select") {
        found.el.dataset.stopKarFullSelected = "true";
        found.el.click();
      }

      setOverlay("found", mode === "select"
        ? `${dateLabel(found.iso)} foi localizada e selecionada. Revise e confirme manualmente.`
        : `${dateLabel(found.iso)} apareceu na pagina. Revise antes de confirmar.`);

      const response = await chrome.runtime.sendMessage({
        type: "FOUND_DATE",
        date: found.iso,
        dateLabel: dateLabel(found.iso),
        text: found.text.slice(0, 220),
        mode,
        reason
      });

      if (response?.stop) stopLocal(false);
      return found;
    } finally {
      scanBusy = false;
    }
  };

  const stopLocal = (removeOverlay = true) => {
    if (intervalHandle) clearInterval(intervalHandle);
    if (refreshHandle) clearInterval(refreshHandle);
    if (observer) observer.disconnect();
    intervalHandle = null;
    refreshHandle = null;
    observer = null;
    watcher = null;
    settings = null;
    if (removeOverlay && overlay) {
      overlay.remove();
      overlay = null;
    }
  };

  const startLocal = async (newSettings) => {
    stopLocal(true);
    settings = newSettings;
    attempts = 0;

    const intervalMs = Math.max(30000, Number(settings.intervalSeconds || 30) * 1000);
    const labels = (settings.targetDates || []).map(dateLabel).join(", ");
    setOverlay("running", `Procurando ${labels}. Deixe esta aba aberta.`);

    observer = new MutationObserver(() => {
      clearTimeout(watcher);
      watcher = setTimeout(() => void scan("mudanca-na-pagina"), 350);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    intervalHandle = setInterval(() => void scan("intervalo"), intervalMs);

    if (settings.autoRefresh) {
      refreshHandle = setInterval(async () => {
        const result = await scan("antes-de-atualizar");
        if (!result && settings) {
          await report({ statusDetail: "Data ainda nao apareceu. Atualizando a pagina..." });
          window.location.reload();
        }
      }, intervalMs);
    }

    await scan("inicio");
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void (async () => {
      if (message?.type === "START_WATCHER") {
        await startLocal(message.settings);
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === "STOP_WATCHER") {
        stopLocal(true);
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === "CHECK_NOW") {
        if (message.settings) settings = message.settings;
        const result = await scan("teste-manual");
        sendResponse({ ok: true, found: Boolean(result) });
        return;
      }
      sendResponse({ ok: false });
    })();
    return true;
  });

  void (async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_CONFIG_FOR_TAB" });
      if (response?.active && response.settings) {
        await startLocal(response.settings);
      }
    } catch (_) {}
  })();
})();
