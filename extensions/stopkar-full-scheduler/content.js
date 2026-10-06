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
    const monthRegex = new RegExp("^(" + MONTHS.join("|") + ")\\s+\\d{4}$", "i");
    const headings = Array.from(document.querySelectorAll("div,span,p,h1,h2,h3,h4,[role='heading']"))
      .filter(visible)
      .filter((el) => monthRegex.test(normalize(el.textContent)));

    const roots = [];
    for (const heading of headings) {
      let node = heading;
      for (let depth = 0; depth < 8 && node?.parentElement; depth += 1) {
        node = node.parentElement;
        if (!visible(node)) continue;

        const confirmButton = Array.from(node.querySelectorAll("button,[role='button']"))
          .find((el) => visible(el) && normalize(el.textContent) === "confirmar");

        if (confirmButton) {
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

    const sections = Array.from(document.querySelectorAll("section,div,form")).filter(visible);
    for (const section of sections) {
      const sectionText = normalize(section.textContent);
      if (!sectionText.includes("quando quer que a coleta")) continue;

      const trigger = Array.from(section.querySelectorAll("button,input,[role='button']"))
        .filter((el) => visible(el) && !disabled(el))
        .find((el) => {
          const text = getText(el);
          return text.includes("dia") || text.includes("data") || el.getAttribute("type") === "date";
        });

      if (trigger) return trigger;
    }

    return null;
  };

  const ensureCalendarOpen = async () => {
    if (calendarLooksOpen()) return true;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const trigger = findDatePickerTrigger();
      if (!trigger) {
        await sleep(600);
        continue;
      }

      try {
        trigger.scrollIntoView({ block: "center", inline: "nearest" });
        trigger.click();
      } catch (_) {}

      for (let poll = 0; poll < 12; poll += 1) {
        await sleep(250);
        if (calendarLooksOpen()) return true;
      }
    }

    return false;
  };

  const restoreCalendarAfterReload = async () => {
    const shouldRestore = sessionStorage.getItem("stopkar-full-reopen-calendar") === "1";
    if (!shouldRestore) return false;

    sessionStorage.removeItem("stopkar-full-reopen-calendar");
    setOverlay("running", "Pagina atualizada. Reabrindo o calendario...");
    await report({ statusDetail: "Pagina atualizada. Reabrindo o calendario..." });

    await sleep(900);
    const opened = await ensureCalendarOpen();

    if (!opened) {
      await report({
        status: "error",
        statusDetail: "A pagina carregou, mas nao consegui abrir o calendario automaticamente."
      });
    }
    return opened;
  };

  const unavailable = (el) => {
    if (!(el instanceof Element)) return true;

    let node = el;
    for (let depth = 0; depth < 4 && node; depth += 1) {
      const cls = normalize(node.className);
      const aria = normalize(node.getAttribute?.("aria-disabled"));
      const dataDisabled = normalize(node.getAttribute?.("data-disabled"));
      const dataUnavailable = normalize(node.getAttribute?.("data-unavailable"));
      const style = window.getComputedStyle(node);

      if (
        node.matches?.(":disabled") ||
        node.hasAttribute?.("disabled") ||
        aria === "true" ||
        dataDisabled === "true" ||
        dataUnavailable === "true" ||
        cls.includes("disabled") ||
        cls.includes("unavailable") ||
        cls.includes("blocked") ||
        cls.includes("not-available") ||
        style.pointerEvents === "none"
      ) return true;

      node = node.parentElement;
    }

    return false;
  };

  const clickableCalendarDay = (el, root) => {
    if (!(el instanceof Element)) return null;

    let node = el;
    for (let depth = 0; depth < 4 && node && root.contains(node); depth += 1) {
      if (
        node.matches?.("button,[role='button'],[role='gridcell'],[tabindex]") ||
        typeof node.onclick === "function"
      ) return node;
      node = node.parentElement;
    }

    return el;
  };

  const parseRgb = (value) => {
    const match = String(value || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const nearestBackground = (el) => {
    let node = el;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      const color = parseRgb(window.getComputedStyle(node).backgroundColor);
      if (color && !(color[0] === 0 && color[1] === 0 && color[2] === 0)) {
        const raw = window.getComputedStyle(node).backgroundColor;
        if (!raw.includes("rgba(0, 0, 0, 0)") && raw !== "transparent") return color;
      }
      node = node.parentElement;
    }
    return [255, 255, 255];
  };

  const visuallyUnavailable = (el) => {
    if (!(el instanceof Element)) return true;
    const style = window.getComputedStyle(el);
    const fg = parseRgb(style.color);
    const bg = nearestBackground(el);

    if (Number(style.opacity) < 0.65) return true;
    if (style.cursor === "not-allowed") return true;

    if (fg && bg) {
      const fgLight = (fg[0] + fg[1] + fg[2]) / 3;
      const bgLight = (bg[0] + bg[1] + bg[2]) / 3;
      if (fgLight > 135 && bgLight > 220) return true;
    }

    return false;
  };

  const selectedLike = (el) => {
    let node = el;
    for (let depth = 0; depth < 5 && node; depth += 1) {
      const cls = normalize(node.className);
      if (
        node.getAttribute?.("aria-selected") === "true" ||
        node.getAttribute?.("data-selected") === "true" ||
        cls.includes("selected") ||
        cls.includes("is-selected") ||
        cls.includes("active")
      ) return true;
      node = node.parentElement;
    }
    return false;
  };

  const styleSignature = (el) => {
    if (!(el instanceof Element)) return "";
    const style = window.getComputedStyle(el);
    return [
      style.color,
      style.backgroundColor,
      style.borderColor,
      style.fontWeight,
      style.opacity
    ].join("|");
  };

  const confirmState = (root) => {
    if (!(root instanceof Element)) return null;
    const button = Array.from(root.querySelectorAll("button,[role='button']"))
      .find((el) => visible(el) && normalize(el.textContent) === "confirmar");
    if (!button) return null;
    return {
      disabled: disabled(button),
      cls: normalize(button.className),
      style: styleSignature(button)
    };
  };

  const selectionFieldText = () => {
    const trigger = findDatePickerTrigger();
    return trigger ? getText(trigger) : "";
  };

  const verifySelectionAfterClick = async (target) => {
    if (!target?.clickTarget) return false;

    const before = {
      field: selectionFieldText(),
      dayStyle: styleSignature(target.clickTarget),
      confirm: confirmState(target.root)
    };

    try {
      target.clickTarget.click();
    } catch (_) {
      return false;
    }

    await sleep(600);

    if (selectedLike(target.dayNode) || selectedLike(target.clickTarget)) return true;

    const afterField = selectionFieldText();
    if (
      afterField &&
      afterField !== before.field &&
      !afterField.includes("escolha um dia") &&
      !afterField.includes("selecionar um dia")
    ) return true;

    const afterConfirm = confirmState(target.root);
    if (
      before.confirm &&
      afterConfirm &&
      before.confirm.disabled &&
      !afterConfirm.disabled
    ) return true;

    const afterStyle = styleSignature(target.clickTarget);
    if (afterStyle && before.dayStyle && afterStyle !== before.dayStyle) return true;

    return false;
  };

  const findTargetDay = () => {
    const dates = Array.isArray(settings?.targetDates) ? settings.targetDates : [];
    const calendars = calendarContainers();

    for (const iso of dates) {
      const [year, month, day] = iso.split("-").map(Number);
      if (!year || !month || !day) continue;

      const monthName = normalize(MONTHS[month - 1]);
      const expectedHeader = monthName + " " + year;

      for (const root of calendars) {
        const rootText = normalize(root.textContent);
        if (!rootText.includes(expectedHeader)) continue;

        const nodes = Array.from(root.querySelectorAll(
          "button,[role='button'],[role='gridcell'],[tabindex],[aria-label],[title],span,div"
        )).filter(visible);

        const exact = nodes.filter((el) => {
          const text = normalize(el.textContent);
          if (text !== String(day) && text !== String(day).padStart(2, "0")) return false;

          const rect = el.getBoundingClientRect();
          return rect.width <= 80 && rect.height <= 80;
        });

        for (const dayNode of exact) {
          const clickTarget = clickableCalendarDay(dayNode, root);
          const isUnavailable =
            unavailable(dayNode) ||
            unavailable(clickTarget) ||
            visuallyUnavailable(dayNode) ||
            visuallyUnavailable(clickTarget);

          return {
            iso,
            root,
            dayNode,
            clickTarget,
            available: !isUnavailable,
            text: normalize(dayNode.textContent)
          };
        }
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

      const opened = await ensureCalendarOpen();
      if (!opened) {
        setOverlay("error", "Nao consegui abrir o calendario do Mercado Livre.");
        await report({
          status: "error",
          statusDetail: "Nao consegui abrir o calendario do Mercado Livre.",
          lastCheckAt: now,
          attempts
        });
        return null;
      }

      const target = findTargetDay();

      if (!target) {
        setOverlay("running", `Calendario aberto. Procurando ${labels}. Tentativa ${attempts}.`);
        await report({
          status: "running",
          statusDetail: "Calendario aberto, mas a data configurada nao apareceu no mes exibido.",
          lastCheckAt: now,
          attempts
        });
        return null;
      }

      if (!target.available) {
        setOverlay("running", `${dateLabel(target.iso)} esta visivel, mas ainda indisponivel. Tentativa ${attempts}.`);
        await report({
          status: "running",
          statusDetail: `${dateLabel(target.iso)} esta visivel, mas ainda indisponivel.`,
          lastCheckAt: now,
          attempts
        });
        return null;
      }

      const mode = settings.mode === "select" ? "select" : "detect";

      if (mode === "select") {
        const selected = await verifySelectionAfterClick(target);

        if (!selected) {
          setOverlay("running", `${dateLabel(target.iso)} esta visivel, mas o Mercado Livre nao aceitou a selecao. Continuando a busca.`);
          await report({
            status: "running",
            statusDetail: `${dateLabel(target.iso)} esta visivel, mas ainda nao esta selecionavel.`,
            lastCheckAt: now,
            attempts
          });
          return null;
        }
      }

      markFound(target.clickTarget || target.dayNode);

      setOverlay("found", mode === "select"
        ? `${dateLabel(target.iso)} ficou disponivel e a selecao foi confirmada na tela. Revise e confirme manualmente.`
        : `${dateLabel(target.iso)} ficou disponivel. Revise antes de confirmar.`);

      const response = await chrome.runtime.sendMessage({
        type: "FOUND_DATE",
        date: target.iso,
        dateLabel: dateLabel(target.iso),
        text: target.text,
        mode,
        reason
      });

      if (response?.stop) stopLocal(false);
      return target;
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
        await report({
          statusDetail: "Data ainda nao esta disponivel. Atualizando a pagina..."
        });
        window.location.reload();
      }
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
