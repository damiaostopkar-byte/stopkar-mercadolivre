(() => {
  if (window.__STOP_KAR_FULL_SCHEDULER_V4__) return;
  window.__STOP_KAR_FULL_SCHEDULER_V4__ = true;

  const MONTHS = [
    "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"
  ];

  const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

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

  const explicitlyDisabled = (el) => {
    if (!(el instanceof Element)) return true;
    const style = window.getComputedStyle(el);
    const cls = normalize(el.className);
    return Boolean(
      el.matches?.(":disabled") ||
      el.hasAttribute?.("disabled") ||
      el.getAttribute?.("aria-disabled") === "true" ||
      el.getAttribute?.("data-disabled") === "true" ||
      el.getAttribute?.("data-unavailable") === "true" ||
      cls.includes("disabled") ||
      cls.includes("unavailable") ||
      cls.includes("not-available") ||
      cls.includes("blocked") ||
      style.pointerEvents === "none"
    );
  };

  const getText = (el) => normalize([
    el?.getAttribute?.("aria-label"),
    el?.getAttribute?.("title"),
    el?.getAttribute?.("placeholder"),
    el?.getAttribute?.("data-testid"),
    el?.textContent,
    el?.value
  ].filter(Boolean).join(" "));

  const dateParts = (iso) => {
    const [year, month, day] = String(iso).split("-").map(Number);
    return { year, month, day };
  };

  const dateLabel = (iso) => {
    const { year, month, day } = dateParts(iso);
    if (!year || !month || !day) return String(iso || "");
    return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
  };

  const datePatterns = (iso) => {
    const { year, month, day } = dateParts(iso);
    if (!year || !month || !day) return [];
    const dd = String(day).padStart(2, "0");
    const mm = String(month).padStart(2, "0");
    const monthName = MONTHS[month - 1];
    return [
      `${dd}/${mm}/${year}`,
      `${day}/${month}/${year}`,
      `${dd}/${mm}`,
      `${day}/${month}`,
      `${day} de ${monthName}`,
      `${dd} de ${monthName}`
    ].map(normalize);
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
        width: "300px",
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

    const title = state === "found" ? "DATA CONFIRMADA" : state === "error" ? "ATENCAO" : "MONITORANDO FULL";
    const accent = state === "found" ? "#5dd39e" : state === "error" ? "#ff6577" : "#ff9f1c";
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
        <img src="${logoUrl}" alt="Stop Kar" style="width:112px;height:auto;display:block" />
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

  const appointmentSection = () => {
    const nodes = Array.from(document.querySelectorAll("section,form,div")).filter(visible);
    const hits = nodes.filter((el) => normalize(el.textContent).includes("quando quer que a coleta"));
    if (!hits.length) return null;
    return hits.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
  };

  const appointmentField = () => {
    const section = appointmentSection();
    if (!section) return null;

    const controls = Array.from(section.querySelectorAll("input,button,[role='button'],[tabindex]")).filter(visible);
    const byText = controls.find((el) => {
      const text = getText(el);
      return text.includes("escolha um dia") || text.includes("selecione um dia") || text.includes("selecionar um dia");
    });
    if (byText) return byText;

    const dateInput = controls.find((el) => el.getAttribute?.("type") === "date");
    if (dateInput) return dateInput;

    const formattedDate = controls.find((el) => /\b\d{1,2}\/\d{1,2}(?:\/\d{4})?\b/.test(getText(el)));
    if (formattedDate) return formattedDate;

    return controls.find((el) => {
      const text = getText(el);
      return text.includes("dia") || text.includes("data");
    }) || controls[0] || null;
  };

  const appointmentFieldMatches = (iso) => {
    const field = appointmentField();
    if (!field) return false;
    const text = getText(field);
    return datePatterns(iso).some((pattern) => text.includes(pattern));
  };

  const calendarRoot = () => {
    const monthRegex = new RegExp(`^(${MONTHS.join("|")})\\s+\\d{4}$`, "i");
    const headings = Array.from(document.querySelectorAll("div,span,p,h1,h2,h3,h4,[role='heading']"))
      .filter(visible)
      .filter((el) => monthRegex.test(normalize(el.textContent)));

    const candidates = [];
    for (const heading of headings) {
      let node = heading;
      for (let depth = 0; depth < 9 && node?.parentElement; depth += 1) {
        node = node.parentElement;
        if (!visible(node)) continue;

        const confirm = Array.from(node.querySelectorAll("button,[role='button']"))
          .find((el) => visible(el) && normalize(el.textContent) === "confirmar");

        if (!confirm) continue;

        const rect = node.getBoundingClientRect();
        if (rect.width < 180 || rect.height < 180 || rect.width > 700 || rect.height > 800) continue;

        candidates.push(node);
        break;
      }
    }

    if (!candidates.length) return null;
    return candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    })[0];
  };

  const calendarConfirm = (root) => {
    if (!(root instanceof Element)) return null;
    return Array.from(root.querySelectorAll("button,[role='button']"))
      .find((el) => visible(el) && normalize(el.textContent) === "confirmar") || null;
  };

  const ensureCalendarOpen = async () => {
    if (calendarRoot()) return true;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const field = appointmentField();
      if (field && !explicitlyDisabled(field)) {
        try {
          field.scrollIntoView({ block: "center", inline: "nearest" });
          field.click();
        } catch (_) {}
      }

      for (let poll = 0; poll < 12; poll += 1) {
        await sleep(250);
        if (calendarRoot()) return true;
      }
    }

    return false;
  };

  const leafDayNodes = (root) => {
    if (!(root instanceof Element)) return [];
    const raw = Array.from(root.querySelectorAll(
      "button,[role='button'],[role='gridcell'],[tabindex],[aria-label],[title],span,div"
    )).filter(visible).filter((el) => {
      const text = normalize(el.textContent);
      if (!/^([1-9]|[12][0-9]|3[01])$/.test(text)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8 || rect.width > 90 || rect.height > 90) return false;
      const childHasSameNumber = Array.from(el.children || []).some((child) => normalize(child.textContent) === text);
      return !childHasSameNumber;
    });

    const byPosition = new Map();
    for (const el of raw) {
      const rect = el.getBoundingClientRect();
      const key = `${Math.round((rect.left + rect.width / 2) / 3)}:${Math.round((rect.top + rect.height / 2) / 3)}`;
      const existing = byPosition.get(key);
      if (!existing || (rect.width * rect.height) < existing.area) {
        byPosition.set(key, { el, area: rect.width * rect.height });
      }
    }

    return Array.from(byPosition.values()).map((x) => x.el).sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const ay = ar.top + ar.height / 2;
      const by = br.top + br.height / 2;
      if (Math.abs(ay - by) > 8) return ay - by;
      return (ar.left + ar.width / 2) - (br.left + br.width / 2);
    });
  };

  const detectWeekStart = (root) => {
    if (!(root instanceof Element)) return 0;
    const labels = Array.from(root.querySelectorAll("span,div,p,th"))
      .filter(visible)
      .map((el) => ({ el, text: normalize(el.textContent) }))
      .filter((x) => WEEKDAYS.includes(x.text));

    if (!labels.length) return 0;
    labels.sort((a, b) => a.el.getBoundingClientRect().left - b.el.getBoundingClientRect().left);
    return labels[0].text === "seg" ? 1 : 0;
  };

  const clickableDay = (node, root) => {
    let el = node;
    for (let depth = 0; depth < 5 && el && root.contains(el); depth += 1) {
      if (el.matches?.("button,[role='button'],[role='gridcell'],[tabindex]")) return el;
      el = el.parentElement;
    }
    return node;
  };

  const targetDay = (root, iso) => {
    const { year, month, day } = dateParts(iso);
    if (!year || !month || !day || !(root instanceof Element)) return null;

    const heading = `${MONTHS[month - 1]} ${year}`;
    if (!normalize(root.textContent).includes(normalize(heading))) return null;

    const cells = leafDayNodes(root);
    if (!cells.length) return null;

    const weekStart = detectWeekStart(root);
    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const offset = (firstWeekday - weekStart + 7) % 7;
    const index = offset + day - 1;

    let node = cells[index] || null;
    if (node && Number(normalize(node.textContent)) !== day) node = null;

    if (!node) {
      const exact = cells.filter((el) => Number(normalize(el.textContent)) === day);
      if (exact.length === 1) node = exact[0];
      if (exact.length > 1) {
        node = exact.reduce((best, el) => {
          const i = cells.indexOf(el);
          if (!best) return { el, distance: Math.abs(i - index) };
          const distance = Math.abs(i - index);
          return distance < best.distance ? { el, distance } : best;
        }, null)?.el || null;
      }
    }

    if (!node) return null;
    const clickTarget = clickableDay(node, root);
    return { iso, root, dayNode: node, clickTarget };
  };

  const rgb = (value) => {
    const match = String(value || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const saturatedBackground = (el) => {
    if (!(el instanceof Element)) return false;
    let node = el;
    for (let depth = 0; depth < 4 && node; depth += 1) {
      const color = rgb(window.getComputedStyle(node).backgroundColor);
      if (color) {
        const max = Math.max(...color);
        const min = Math.min(...color);
        if (max - min > 45 && max > 120) return true;
      }
      node = node.parentElement;
    }
    return false;
  };

  const selectedState = (el) => {
    if (!(el instanceof Element)) return false;
    let node = el;
    for (let depth = 0; depth < 5 && node; depth += 1) {
      const cls = normalize(node.className);
      if (
        node.getAttribute?.("aria-selected") === "true" ||
        node.getAttribute?.("data-selected") === "true" ||
        cls.includes("selected") ||
        cls.includes("is-selected")
      ) return true;
      node = node.parentElement;
    }
    return saturatedBackground(el);
  };

  const probeTargetSelection = async (target) => {
    if (!target?.clickTarget || explicitlyDisabled(target.clickTarget) || explicitlyDisabled(target.dayNode)) {
      return false;
    }

    const wasSelected = selectedState(target.clickTarget) || selectedState(target.dayNode);
    if (wasSelected) return true;

    try {
      target.clickTarget.click();
    } catch (_) {
      return false;
    }

    await sleep(450);
    return selectedState(target.clickTarget) || selectedState(target.dayNode);
  };

  const commitCalendarSelection = async (target) => {
    const confirm = calendarConfirm(target.root);
    if (!confirm || explicitlyDisabled(confirm)) return false;

    try {
      confirm.click();
    } catch (_) {
      return false;
    }

    for (let poll = 0; poll < 12; poll += 1) {
      await sleep(250);
      if (appointmentFieldMatches(target.iso)) return true;
    }

    return false;
  };

  const markFound = (el) => {
    if (!(el instanceof Element)) return;
    el.style.setProperty("outline", "4px solid #ff9f1c", "important");
    el.style.setProperty("outline-offset", "3px", "important");
    el.style.setProperty("box-shadow", "0 0 0 7px rgba(255,159,28,.20)", "important");
  };

  const scan = async (reason = "manual") => {
    if (!settings || scanBusy) return { status: "busy" };
    scanBusy = true;

    try {
      attempts += 1;
      const now = Date.now();
      const labels = (settings.targetDates || []).map(dateLabel).join(", ");

      setOverlay("running", `Procurando ${labels}. Tentativa ${attempts}.`);
      await report({
        status: "running",
        statusDetail: `Procurando ${labels}.`,
        lastCheckAt: now,
        attempts
      });

      const opened = await ensureCalendarOpen();
      if (!opened) {
        const detail = "Nao consegui abrir o calendario do Mercado Livre.";
        setOverlay("error", detail);
        await report({ status: "error", statusDetail: detail, lastCheckAt: now, attempts });
        return { status: "calendar_error", detail };
      }

      const root = calendarRoot();
      if (!root) return { status: "calendar_error" };

      for (const iso of settings.targetDates || []) {
        const target = targetDay(root, iso);
        if (!target) continue;

        if (explicitlyDisabled(target.dayNode) || explicitlyDisabled(target.clickTarget)) {
          const detail = `${dateLabel(iso)} esta visivel, mas indisponivel.`;
          setOverlay("running", `${detail} Tentativa ${attempts}.`);
          await report({ status: "running", statusDetail: detail, lastCheckAt: now, attempts });
          return { status: "unavailable", iso, detail };
        }

        const selected = await probeTargetSelection(target);
        if (!selected) {
          const detail = `${dateLabel(iso)} ainda nao pode ser selecionada.`;
          setOverlay("running", `${detail} Tentativa ${attempts}.`);
          await report({ status: "running", statusDetail: detail, lastCheckAt: now, attempts });
          return { status: "unavailable", iso, detail };
        }

        if (settings.mode !== "select") {
          const detail = `${dateLabel(iso)} esta selecionavel.`;
          markFound(target.clickTarget || target.dayNode);
          setOverlay("found", `${detail} Revise a tela antes de confirmar.`);
          const response = await chrome.runtime.sendMessage({
            type: "FOUND_DATE",
            date: iso,
            dateLabel: dateLabel(iso),
            text: detail,
            mode: "detect",
            reason
          });
          if (response?.stop) stopLocal(false);
          return { status: "found", iso, detail };
        }

        const committed = await commitCalendarSelection(target);
        if (!committed) {
          const detail = `${dateLabel(iso)} nao foi confirmada pelo seletor de data. Continuando a busca.`;
          setOverlay("running", detail);
          await report({ status: "running", statusDetail: detail, lastCheckAt: now, attempts });
          return { status: "unavailable", iso, detail };
        }

        const detail = `${dateLabel(iso)} foi aceita pelo Mercado Livre e aplicada no campo de coleta.`;
        markFound(appointmentField());
        setOverlay("found", `${detail} Falta apenas a confirmacao final da pagina.`);

        const response = await chrome.runtime.sendMessage({
          type: "FOUND_DATE",
          date: iso,
          dateLabel: dateLabel(iso),
          text: detail,
          mode: "select",
          reason
        });
        if (response?.stop) stopLocal(false);
        return { status: "found", iso, detail };
      }

      const detail = "Calendario aberto, mas a data configurada nao foi localizada no mes exibido.";
      setOverlay("running", detail);
      await report({ status: "running", statusDetail: detail, lastCheckAt: now, attempts });
      return { status: "not_visible", detail };
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
    setOverlay("running", `Procurando ${labels}.`);

    const restoreAfterReload = sessionStorage.getItem("stopkar-full-reopen-calendar") === "1";
    sessionStorage.removeItem("stopkar-full-reopen-calendar");
    if (restoreAfterReload) await sleep(1100);

    const first = await scan(restoreAfterReload ? "apos-reload" : "inicio");
    if (first?.status === "found") return;

    intervalHandle = setInterval(async () => {
      if (!settings || scanBusy) return;

      const result = await scan("intervalo");
      if (!settings || result?.status === "found") return;

      if (settings.autoRefresh) {
        sessionStorage.setItem("stopkar-full-reopen-calendar", "1");
        await report({ statusDetail: "Data ainda indisponivel. Atualizando a pagina para consultar novamente..." });
        window.location.reload();
      }
    }, intervalMs);
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void (async () => {
      if (message?.type === "START_WATCHER") {
        await startLocal(message.settings, 0);
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "STOP_WATCHER") {
        stopLocal(true);
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "CHECK_NOW") {
        settings = message.settings || settings;
        const result = await scan("teste-manual");
        sendResponse({ ok: true, ...result, found: result?.status === "found" });
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
