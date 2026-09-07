const CHANNEL = "meet-bridge-n-minus-one";
let pageReadySent = false;
let diagnosticsEnabled = false;

function diagnostic(event, detail = {}) {
  if (!diagnosticsEnabled) return;
  tellBackground("PAGE_DIAGNOSTIC", {
    entry: {
      at: new Date().toISOString(),
      event,
      detail: {
        ...detail,
        isTopFrame: window === window.top,
      },
    },
  });
}

function postToPage(type, payload = {}) {
  window.postMessage({ channel: CHANNEL, direction: "to-main", type, ...payload }, "*");
}

function showCommandStatus(message, isError = false) {
  const render = () => {
    document.querySelector("#meet-bridge-command-status")?.remove();
    const toast = document.createElement("div");
    toast.id = "meet-bridge-command-status";
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      zIndex: "2147483647",
      top: "18px",
      left: "50%",
      transform: "translateX(-50%)",
      maxWidth: "min(560px, calc(100vw - 32px))",
      padding: "11px 16px",
      borderRadius: "10px",
      background: isError ? "#b42318" : "#18794e",
      color: "white",
      font: "600 13px/1.4 system-ui, sans-serif",
      boxShadow: "0 8px 30px rgba(0,0,0,.28)",
    });
    document.documentElement.append(toast);
    setTimeout(() => toast.remove(), isError ? 8_000 : 3_000);
  };
  if (document.documentElement) render();
  else addEventListener("DOMContentLoaded", render, { once: true });
}

async function tellBackground(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({
      target: "background",
      type,
      ...payload,
    });
  } catch {
    return null;
  }
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (
    event.source !== window ||
    message?.channel !== CHANNEL ||
    message?.direction !== "to-extension"
  ) {
    return;
  }

  if (message.type === "MAIN_READY") {
    diagnostic("content-received-main-ready");
    if (!pageReadySent) {
      pageReadySent = true;
      tellBackground("PAGE_READY");
    }
  } else if (message.type === "SIGNAL_FROM_MAIN") {
    diagnostic("content-forward-main-signal", {
      channel: message.signal?.channel || "output",
      descriptionType: message.signal?.description?.type || null,
      hasCandidate: Boolean(message.signal?.candidate),
    });
    tellBackground("SIGNAL_FROM_TAB", { signal: message.signal });
  } else if (message.type === "DIAGNOSTIC") {
    tellBackground("PAGE_DIAGNOSTIC", { entry: message.entry });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SIGNAL_FROM_OFFSCREEN") {
    diagnostic("content-received-offscreen-signal", {
      channel: message.signal?.channel || "output",
      descriptionType: message.signal?.description?.type || null,
      hasCandidate: Boolean(message.signal?.candidate),
    });
    postToPage("SIGNAL_FROM_OFFSCREEN", { signal: message.signal });
  } else if (message?.type === "BRIDGE_CONFIG") {
    diagnosticsEnabled = Boolean(message.diagnosticsEnabled);
    diagnostic("content-received-bridge-config", {
      active: Boolean(message.active),
      micMode: message.micMode || "shared",
      role: message.role || "meeting",
      diagnosticsEnabled,
    });
    postToPage("BRIDGE_CONFIG", {
      active: Boolean(message.active),
      micMode: message.micMode || "shared",
      role: message.role || "meeting",
      pageWorkletUrl: chrome.runtime.getURL("pcm-page-output-worklet.js"),
      diagnosticsEnabled,
    });
  } else if (message?.type === "COMMAND_STATUS") {
    showCommandStatus(message.message || "Meet Bridge", Boolean(message.error));
  }
});

// Both sides send a handshake so injection ordering between MAIN and ISOLATED
// worlds cannot lose the initial ready notification.
postToPage("EXTENSION_READY");
diagnostic("content-script-ready");
