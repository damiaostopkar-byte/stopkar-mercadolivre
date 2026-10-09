const VERSION = "0.5.0";

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

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["settings", "runtime", "configVersion"]);
  const settings = { ...DEFAULT_SETTINGS, ...(current.settings || {}) };

  if (current.configVersion !== VERSION) {
    settings.mode = "select";
    settings.autoRefresh = true;
    settings.stopAfterFound = true;
  }

  await chrome.storage.local.set({
    settings,
    runtime: DEFAULT_RUNTIME,
    configVersion: VERSION
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (message?.type === "GET_CONFIG_FOR_TAB") {
      const data = await chrome.storage.local.get(["settings", "runtime"]);
      const tabId = sender.tab?.id ?? null;
      const runtime = data.runtime || DEFAULT_RUNTIME;
      const active = Boolean(runtime.enabled && runtime.boundTabId === tabId);
      sendResponse({ active, settings: active ? data.settings : null, runtime });
      return;
    }

    if (message?.type === "WATCHER_STATUS") {
      const data = await chrome.storage.local.get(["runtime"]);
      const runtime = { ...(data.runtime || DEFAULT_RUNTIME) };
      if (sender.tab?.id !== runtime.boundTabId) {
        sendResponse({ ok: false });
        return;
      }

      Object.assign(runtime, message.patch || {});
      await chrome.storage.local.set({ runtime });
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "FOUND_DATE") {
      const data = await chrome.storage.local.get(["settings", "runtime"]);
      const settings = data.settings || {};
      const runtime = { ...(data.runtime || DEFAULT_RUNTIME) };
      if (sender.tab?.id !== runtime.boundTabId) {
        sendResponse({ ok: false });
        return;
      }

      runtime.status = "found";
      runtime.statusDetail = message.mode === "select"
        ? "Data confirmada no campo de coleta. Falta apenas a confirmacao final da pagina."
        : "Data selecionavel localizada. Abra a aba do Mercado Livre para revisar.";
      runtime.foundDate = message.date || null;
      runtime.foundText = message.text || null;
      runtime.lastCheckAt = Date.now();
      if (settings.stopAfterFound !== false) runtime.enabled = false;
      await chrome.storage.local.set({ runtime });

      await chrome.notifications.create(`stopkar-full-${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("assets/icon128.png"),
        title: message.mode === "select"
          ? "Stop Kar Full: data confirmada"
          : "Stop Kar Full: data disponivel",
        message: message.mode === "select"
          ? `A data ${message.dateLabel || message.date || "desejada"} foi aplicada no campo de coleta. Falta confirmar a pagina.`
          : `A data ${message.dateLabel || message.date || "desejada"} esta selecionavel.`
      });

      sendResponse({ ok: true, stop: settings.stopAfterFound !== false });
      return;
    }

    sendResponse({ ok: false });
  })();
  return true;
});
