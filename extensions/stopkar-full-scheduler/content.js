(() => {
  if (window.__STOP_KAR_FULL_SCHEDULER__) return;
  window.__STOP_KAR_FULL_SCHEDULER__ = true;

  const MONTHS = [
    "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"
  ];

  let intervalHandle = null;
  let settings = null;
  let attempts = 0;
  let overlay = null;
  let scanBusy = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    el.getAttribute?.("placeholder"),
    el.getAttribute?.("data-testid"),
    el.textContent,
    el.value
  ].filter(Boolean).join(" "));

  const getClickable = (el) => {
    if (!(el instanceof Element)) return null;
    const direct = el.closest("button, a, input, [role='button'], [role='option'], [role='gridcell'], [tabindex]");
    if (direct && visible(direct) && !disabled(direct)) return direct;
    if (visible(el) && !disabled(el)) return el;
    return null;
  };

  const candidates = () => {
    const selector = [
      "button", "a", "input", "[role='button']", "[role='option']", "[role='gridcell']",
      "[aria-label]", "[title]", "[placeholder]", "[data-testid]"
    ].join(",");
    return Array.from(document.querySelectorAll(selector)).filter(visible);
  };

  const setOverlay = (state, detail) => {
    const logoUrl = chrome.runtime.getURL("assets/stopkar-logo-compact.png");
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
        background: "#151515",
        color: "#fff",
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
        lineHeight: "1.35",
        boxShadow: "0 10px 30px rgba(0,0,0,.25)",
        border: "1px solid rgba(243,160,0,.38)"
      });
      document.documentElement.appendChild(overlay);
    }

    const title = state === "found" ? "DATA ENCONTRADA" : state === "error" ? "ATENCAO" : "MONITORANDO FULL";
    const accent = state === "found" ? "#5dd39e" : state === "error" ? "#ff6577" : "#ff9f1c";
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
        <img src="${logoUrl}" alt="Stop Kar" style="width:108px;height:auto;display:block" />
        <span style="font-weight:800;font-size:10px;letter-spacing:.06em;color:${accent};text-align:right">${title}</span>
      </div>
      <div style="height:1px;background:rgba(255,255,255,.12);margin-bottom:8px"></div>
      <div style="color:#ececec">${detail}</div>
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

  const calendarContainers = () => {
    const monthRegex = new RegExp(`^(${MONTHS.join("|")})\\s+\\d{4}(() => {
  if (window.__STOP_KAR_FULL_SCHEDULER__) return;
  window.__STOP_KAR_FULL_SCHEDULER__ = true;

  const MONTHS = [
    "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"
  ];

  let intervalHandle = null;
  let settings = null;
  let attempts = 0;
  let overlay = null;
  let scanBusy = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    el.getAttribute?.("placeholder"),
    el.getAttribute?.("data-testid"),
    el.textContent,
    el.value
  ].filter(Boolean).join(" "));

  const getClickable = (el) => {
    if (!(el instanceof Element)) return null;
    const direct = el.closest("button, a, input, [role='button'], [role='option'], [role='gridcell'], [tabindex]");
    if (direct && visible(direct) && !disabled(direct)) return direct;
    if (visible(el) && !disabled(el)) return el;
    return null;
  };

  const candidates = () => {
    const selector = [
      "button", "a", "input", "[role='button']", "[role='option']", "[role='gridcell']",
      "[aria-label]", "[title]", "[placeholder]", "[data-testid]"
    ].join(",");
    return Array.from(document.querySelectorAll(selector)).filter(visible);
  };

  const setOverlay = (state, detail) => {
    const logoUrl = chrome.runtime.getURL("assets/stopkar-logo-compact.png");
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
        background: "#151515",
        color: "#fff",
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
        lineHeight: "1.35",
        boxShadow: "0 10px 30px rgba(0,0,0,.25)",
        border: "1px solid rgba(243,160,0,.38)"
      });
      document.documentElement.appendChild(overlay);
    }

    const title = state === "found" ? "DATA ENCONTRADA" : state === "error" ? "ATENCAO" : "MONITORANDO FULL";
    const accent = state === "found" ? "#5dd39e" : state === "error" ? "#ff6577" : "#ff9f1c";
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
        <img src="${logoUrl}" alt="Stop Kar" style="width:108px;height:auto;display:block" />
        <span style="font-weight:800;font-size:10px;letter-spacing:.06em;color:${accent};text-align:right">${title}</span>
      </div>
      <div style="height:1px;background:rgba(255,255,255,.12);margin-bottom:8px"></div>
      <div style="color:#ececec">${detail}</div>
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

, "i");
    const headings = Array.from(document.querySelectorAll("div,span,p,h1,h2,h3,h4,[role='heading']"))
      .filter(visible)
      .filter((el) => monthRegex.test(normalize(el.textContent)));

    const roots = [];
    for (const heading of headings) {
      let node = heading;
      for (let depth = 0; depth < 7 && node?.parentElement; depth += 1) {
        node = node.parentElement;
        if (!visible(node)) continue;

        const confirmButton = Array.from(node.querySelectorAll("button,[role='button']"))
          .find((el) => visible(el) && normalize(el.textContent) === "confirmar");

        const dayCells = Array.from(node.querySelectorAll("button,[role='gridcell'],[role='button'],[tabindex],span,div"))
          .filter(visible)
          .filter((cell) => /^([1-9]|[12][0-9]|3[01])$/.test(normalize(cell.textContent))).length;

        if (confirmButton && dayCells >= 14) {
          roots.push(node);
          break;
        }
      }
    }

    return Array.from(new Set(roots));
  };

  const calendarLooksOpen = () => calendarContainers().length > 0;

  const findDatePickerTrigger = () => {
    const exactTerms = [
      "escolha um dia",
      "escolher um dia",
      "selecione um dia",
      "selecionar um dia"
    ];

    for (const el of candidates()) {
      const text = getText(el);
      if (!text) continue;
      if (exactTerms.some((term) => text.includes(term))) {
        return getClickable(el);
      }
    }

    const sectionTexts = [
      "escolha quando quer que a coleta passe",
      "escolha quando quer que a coleta",
      "quando quer que a coleta passe"
    ];
    const sections = Array.from(document.querySelectorAll("section,div,form")).filter(visible);
    for (const section of sections) {
      const sectionText = normalize(section.textContent);
      if (!sectionTexts.some((term) => sectionText.includes(term))) continue;
      const trigger = Array.from(section.querySelectorAll("button,input,[role='button']")).find((el) => {
        if (!visible(el) || disabled(el)) return false;
        const text = getText(el);
        return text.includes("dia") || text.includes("data") || el.getAttribute("type") === "date";
      });
      if (trigger) return trigger;
    }

    return null;
  };

  const ensureCalendarOpen = async (maxAttempts = 16) => {
    if (calendarLooksOpen()) return true;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const trigger = findDatePickerTrigger();
      if (trigger) {
        try {
          trigger.scrollIntoView({ block: "center", inline: "nearest" });
          trigger.click();
          await sleep(650);
          if (calendarLooksOpen()) return true;
        } catch (_) {}
      }
      await sleep(350);
    }

    return false;
  };

  const restoreCalendarAfterReload = async () => {
    const shouldRestore = sessionStorage.getItem("stopkar-full-reopen-calendar") === "1";
    if (!shouldRestore) return false;

    sessionStorage.removeItem("stopkar-full-reopen-calendar");
    setOverlay("running", "Pagina atualizada. Reabrindo o calendario...");
    await report({ statusDetail: "Pagina atualizada. Reabrindo o calendario..." });

    const opened = await ensureCalendarOpen(24);
    if (!opened) {
      await report({ statusDetail: "Nao consegui reabrir o calendario ainda. Vou tentar novamente no proximo ciclo." });
    }
    return opened;
  };

  const findDateByFullText = () => {
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

  const findDateByCalendarContext = () => {
    const dates = Array.isArray(settings?.targetDates) ? settings.targetDates : [];
    const containers = calendarContainers();

    for (const iso of dates) {
      const [year, month, day] = iso.split("-").map(Number);
      if (!year || !month || !day) continue;
      const monthName = normalize(MONTHS[month - 1]);

      for (const container of containers) {
        const context = normalize(container.textContent);
        const contextMatchesMonth = context.includes(monthName) || context.includes(String(year));
        if (!contextMatchesMonth) continue;

        const dayCandidates = Array.from(container.querySelectorAll("button,[role='button'],[role='gridcell'],[tabindex]"))
          .filter((el) => visible(el) && !disabled(el));

        for (const el of dayCandidates) {
          const text = normalize(el.textContent);
          if (text === String(day) || text === String(day).padStart(2, "0")) {
            return { iso, el, text: normalize(container.textContent).slice(0, 220) };
          }
        }
      }
    }
    return null;
  };

  const findDate = () => findDateByFullText() || findDateByCalendarContext();

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

      let found = findDate();
      if (!found) {
        const opened = await ensureCalendarOpen();
        if (opened) {
          await sleep(250);
          found = findDate();
        }
      }

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
    intervalHandle = null;
    settings = null;
    if (removeOverlay && overlay) {
      overlay.remove();
      overlay = null;
    }
  };

  const startLocal = async (newSettings, initialAttempts = 0) => {
    stopLocal(true);
    settings = newSettings;
    attempts = Number(initialAttempts || 0);

    const intervalMs = Math.max(30000, Number(settings.intervalSeconds || 30) * 1000);
    const labels = (settings.targetDates || []).map(dateLabel).join(", ");
    setOverlay("running", `Procurando ${labels}. Deixe esta aba aberta.`);

    await restoreCalendarAfterReload();
    await scan("inicio");

    intervalHandle = setInterval(async () => {
      if (!settings || scanBusy) return;

      const result = await scan("intervalo");
      if (result || !settings) return;

      if (settings.autoRefresh) {
        sessionStorage.setItem("stopkar-full-reopen-calendar", "1");
        await report({ statusDetail: "Data ainda nao apareceu. Atualizando e reabrindo o calendario..." });
        window.location.reload();
        return;
      }

      await ensureCalendarOpen(3);
    }, intervalMs);
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
        await startLocal(response.settings, Number(response.runtime?.attempts || 0));
      }
    } catch (_) {}
  })();
})();
