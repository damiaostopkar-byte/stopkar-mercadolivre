const DEFAULT_SETTINGS = {
  targetDates: [],
  intervalSeconds: 30,
  mode: "select",
  autoRefresh: true,
  stopAfterFound: true
};

const DEFAULT_RUNTIME = {
  enabled: false,
  boundTabId: null,
  status: "idle",
  statusDetail: "Configure uma data para iniciar.",
  lastCheckAt: null,
  attempts: 0,
  foundDate: null,
  foundText: null,
  startedAt: null
};

const $ = (id) => document.getElementById(id);
const els = {
  targetDate: $("targetDate"),
  addDate: $("addDate"),
  dateList: $("dateList"),
  intervalSeconds: $("intervalSeconds"),
  mode: $("mode"),
  autoRefresh: $("autoRefresh"),
  stopAfterFound: $("stopAfterFound"),
  start: $("start"),
  stop: $("stop"),
  checkNow: $("checkNow"),
  message: $("message"),
  statusDot: $("statusDot"),
  statusLabel: $("statusLabel"),
  statusDetail: $("statusDetail"),
  lastCheck: $("lastCheck"),
  attempts: $("attempts")
};

let settings = { ...DEFAULT_SETTINGS };
let runtime = { ...DEFAULT_RUNTIME };

const dateLabel = (iso) => {
  const [year, month, day] = String(iso).split("-");
  return year && month && day ? `${day}/${month}/${year}` : iso;
};

const formatTime = (timestamp) => {
  if (!timestamp) return "--";
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(timestamp));
};

const isMlUrl = (url = "") => /^https:\/\/([^/]+\.)?mercadolivre\.com(\.br)?\//i.test(url);

const showMessage = (text, type = "") => {
  els.message.hidden = !text;
  els.message.textContent = text || "";
  els.message.className = `message ${type}`.trim();
};

const renderDates = () => {
  els.dateList.innerHTML = "";
  if (!settings.targetDates.length) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "Nenhuma data adicionada.";
    els.dateList.appendChild(empty);
    return;
  }

  for (const iso of settings.targetDates) {
    const chip = document.createElement("span");
    chip.className = "date-chip";
    chip.append(document.createTextNode(dateLabel(iso)));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = `Remover ${dateLabel(iso)}`;
    remove.textContent = "x";
    remove.addEventListener("click", async () => {
      settings.targetDates = settings.targetDates.filter((value) => value !== iso);
      await saveSettings();
      renderDates();
    });
    chip.appendChild(remove);
    els.dateList.appendChild(chip);
  }
};

const renderStatus = () => {
  const labels = {
    idle: "Parado",
    running: "Monitorando",
    found: "Data encontrada",
    error: "Atencao"
  };
  els.statusLabel.textContent = labels[runtime.status] || labels.idle;
  els.statusDetail.textContent = runtime.statusDetail || "";
  els.statusDot.className = `dot ${runtime.status || "idle"}`;
  els.lastCheck.textContent = formatTime(runtime.lastCheckAt);
  els.attempts.textContent = String(runtime.attempts || 0);
  els.start.disabled = Boolean(runtime.enabled);
  els.stop.disabled = !runtime.enabled;
};

const saveSettings = async () => {
  settings.intervalSeconds = Number(els.intervalSeconds.value || settings.intervalSeconds || 30);
  settings.mode = els.mode.value || settings.mode;
  settings.autoRefresh = Boolean(els.autoRefresh.checked);
  settings.stopAfterFound = Boolean(els.stopAfterFound.checked);
  await chrome.storage.local.set({ settings });
};

const activeTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const load = async () => {
  const data = await chrome.storage.local.get(["settings", "runtime"]);
  settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  runtime = { ...DEFAULT_RUNTIME, ...(data.runtime || {}) };

  els.intervalSeconds.value = String(settings.intervalSeconds);
  els.mode.value = settings.mode;
  els.autoRefresh.checked = settings.autoRefresh;
  els.stopAfterFound.checked = settings.stopAfterFound;
  renderDates();
  renderStatus();
};

els.addDate.addEventListener("click", async () => {
  const iso = els.targetDate.value;
  if (!iso) {
    showMessage("Escolha uma data primeiro.", "error");
    return;
  }
  if (!settings.targetDates.includes(iso)) settings.targetDates.push(iso);
  settings.targetDates.sort();
  await saveSettings();
  renderDates();
  showMessage("");
});

for (const el of [els.intervalSeconds, els.mode, els.autoRefresh, els.stopAfterFound]) {
  el.addEventListener("change", () => void saveSettings());
}

els.start.addEventListener("click", async () => {
  showMessage("");
  await saveSettings();
  if (!settings.targetDates.length) {
    showMessage("Adicione pelo menos uma data antes de iniciar.", "error");
    return;
  }

  const tab = await activeTab();
  if (!tab?.id || !isMlUrl(tab.url || "")) {
    showMessage("Abra a pagina de agendamento do Mercado Livre nesta aba e tente novamente.", "error");
    return;
  }

  runtime = {
    ...DEFAULT_RUNTIME,
    enabled: true,
    boundTabId: tab.id,
    status: "running",
    statusDetail: `Procurando ${settings.targetDates.map(dateLabel).join(", ")}.`,
    startedAt: Date.now(),
    attempts: 0
  };
  await chrome.storage.local.set({ settings, runtime });

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "START_WATCHER", settings });
    showMessage("Monitoramento iniciado nesta aba.", "success");
  } catch (error) {
    runtime.enabled = false;
    runtime.status = "error";
    runtime.statusDetail = "Recarregue a pagina do Mercado Livre depois de instalar a extensao.";
    await chrome.storage.local.set({ runtime });
    showMessage("Nao consegui ativar nesta pagina. Recarregue a aba do Mercado Livre e tente novamente.", "error");
  }
  renderStatus();
});

els.stop.addEventListener("click", async () => {
  const tabId = runtime.boundTabId;
  runtime.enabled = false;
  runtime.status = "idle";
  runtime.statusDetail = "Monitoramento interrompido manualmente.";
  await chrome.storage.local.set({ runtime });
  if (tabId) {
    try { await chrome.tabs.sendMessage(tabId, { type: "STOP_WATCHER" }); } catch (_) {}
  }
  renderStatus();
  showMessage("Monitoramento parado.", "success");
});

els.checkNow.addEventListener("click", async () => {
  showMessage("");
  await saveSettings();
  if (!settings.targetDates.length) {
    showMessage("Adicione uma data para testar.", "error");
    return;
  }

  const tab = await activeTab();
  if (!tab?.id || !isMlUrl(tab.url || "")) {
    showMessage("Abra uma pagina do Mercado Livre para fazer o teste.", "error");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "CHECK_NOW", settings: { ...settings } });
    if (response?.found) {
      showMessage("A data foi validada pelo Mercado Livre.", "success");
    } else {
      showMessage(response?.detail || "A data ainda nao esta disponivel nesta pagina.", "");
    }
  } catch (_) {
    showMessage("Recarregue a pagina do Mercado Livre e teste novamente.", "error");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.runtime?.newValue) {
    runtime = { ...DEFAULT_RUNTIME, ...changes.runtime.newValue };
    renderStatus();
  }
});

void load();
