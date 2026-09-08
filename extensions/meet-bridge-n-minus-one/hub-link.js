const HUB_BRIDGE_SETTINGS_KEY = "hubBridgeSettingsV1";
const HUB_BRIDGE_PROFILE_KEY = "hubBridgeProfileV1";
const HUB_NATIVE_HOST_NAME = "com.meetbridge.hub";
const HUB_REQUEST_TIMEOUT_MS = 6_000;

let hubPort = null;
let hubConnectionState = "disabled";
let hubLastError = "";
let hubPairChallenge = null;
const hubPendingRequests = new Map();
let hubConnectPromise = null;

function notifyHubStateChanged() {
  chrome.runtime
    .sendMessage({ target: "popup", type: "STATE_CHANGED" })
    .catch(() => {});
}

function rejectPendingHubRequests(error) {
  for (const [requestId, pending] of hubPendingRequests) {
    clearTimeout(pending.timeout);
    hubPendingRequests.delete(requestId);
    pending.reject(error);
  }
}

async function readHubSettings() {
  const stored = await chrome.storage.local.get(HUB_BRIDGE_SETTINGS_KEY);
  return { enabled: Boolean(stored[HUB_BRIDGE_SETTINGS_KEY]?.enabled) };
}

async function getAnonymousProfileId() {
  const stored = await chrome.storage.local.get(HUB_BRIDGE_PROFILE_KEY);
  if (typeof stored[HUB_BRIDGE_PROFILE_KEY] === "string") {
    return stored[HUB_BRIDGE_PROFILE_KEY];
  }
  const profileId = crypto.randomUUID();
  await chrome.storage.local.set({ [HUB_BRIDGE_PROFILE_KEY]: profileId });
  return profileId;
}

function closeHubPort() {
  if (hubPort) {
    try {
      hubPort.disconnect();
    } catch {
      // A disconnected native port is already safe to discard.
    }
  }
  hubPort = null;
  rejectPendingHubRequests(new Error("Hub 连接已关闭。"));
}

async function connectHub() {
  const settings = await readHubSettings();
  if (!settings.enabled) {
    closeHubPort();
    hubConnectionState = "disabled";
    hubLastError = "";
    return getHubStatus();
  }

  // The first Hello response is the actual readiness signal. Returning before
  // it arrives races SessionRequest and makes a first click look paired while
  // no endpoint has yet been authorized.
  if (hubPort) return hubConnectPromise || getHubStatus();

  const connectTask = (async () => {
    let port = null;
    try {
      const profileId = await getAnonymousProfileId();
      port = chrome.runtime.connectNative(HUB_NATIVE_HOST_NAME);
      port.onDisconnect.addListener(() => {
        if (hubPort !== port) return;
        const error = chrome.runtime.lastError?.message || "Hub 已断开";
        hubPort = null;
        hubConnectPromise = null;
        hubConnectionState = "disconnected";
        hubLastError = error;
        rejectPendingHubRequests(new Error(error));
        notifyHubStateChanged();
      });
      port.onMessage.addListener((message) => {
        if (hubPort !== port) return;
        if (message?.type === "Error") {
          hubConnectionState = "error";
          hubLastError = message.payload?.action_required || "Hub 拒绝了请求。";
        } else {
          hubConnectionState = "connected";
          hubLastError = "";
        }
        if (message?.type === "PairChallenge" && message.payload?.confirmation_code) {
          hubPairChallenge = message.payload;
          notifyHubStateChanged();
        }
        if (message?.type === "PairResult" && message.payload?.paired) {
          hubPairChallenge = null;
          notifyHubStateChanged();
        }
        const requestId = message?.payload?.request_id;
        const pending = requestId ? hubPendingRequests.get(requestId) : null;
        if (pending) {
          hubPendingRequests.delete(requestId);
          clearTimeout(pending.timeout);
          pending.resolve(message);
        }
      });
      hubPort = port;
      hubConnectionState = "connecting";
      hubLastError = "";
      const hello = await sendHubRequest({
        type: "Hello",
        payload: {
          request_id: crypto.randomUUID(),
          profile_id: profileId,
          profile_public_key_b64: "",
          extension_version: chrome.runtime.getManifest().version,
          protocol: {
            minimum: { major: 1, minor: 0 },
            maximum: { major: 1, minor: 0 },
          },
          client_nonce_b64: crypto.randomUUID(),
          capabilities: ["TabCapturePcm", "ReceiveHubMix", "ChannelRouting"],
        },
      });
      if (hello?.type === "Error") {
        throw new Error(hello.payload?.action_required || "Hub 拒绝连接。");
      }
      if (hubConnectionState !== "connected") {
        throw new Error("Hub 未确认连接就绪。");
      }
    } catch (error) {
      if (hubPort === port) closeHubPort();
      hubConnectionState = "error";
      hubLastError = error?.message || String(error);
    }
    notifyHubStateChanged();
    return getHubStatus();
  })();
  hubConnectPromise = connectTask;
  try {
    return await connectTask;
  } finally {
    if (hubConnectPromise === connectTask) hubConnectPromise = null;
  }
}
function sendHubRequest(message) {
  if (!hubPort) return Promise.reject(new Error("Meet Bridge Hub 未连接。"));
  const requestId = message.payload?.request_id;
  if (!requestId) return Promise.reject(new Error("Hub 请求缺少 request_id。"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      hubPendingRequests.delete(requestId);
      reject(new Error("Hub 请求超时。"));
    }, HUB_REQUEST_TIMEOUT_MS);
    hubPendingRequests.set(requestId, { resolve, reject, timeout });
    try {
      hubPort.postMessage(message);
    } catch (error) {
      clearTimeout(timeout);
      hubPendingRequests.delete(requestId);
      reject(error);
    }
  });
}

async function requestSession(endpointId, channelId) {
  const profileId = await getAnonymousProfileId();
  const requestId = crypto.randomUUID();
  const response = await sendHubRequest({
    type: "SessionRequest",
    payload: {
      request_id: requestId,
      profile_id: profileId,
      endpoint_id: endpointId,
      channel_id: channelId,
      protocol: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } },
      client_nonce_b64: crypto.randomUUID(),
    },
  });
  if (response?.type !== "SessionGrant") throw new Error(response?.payload?.action_required || "Hub 未授权该标签页会话。");
  return response.payload;
}

async function confirmPairing(confirmationCode) {
  if (!hubPort || !hubPairChallenge) throw new Error("没有待确认的 Hub 配对。");
  if (typeof confirmationCode !== "string" || !/^\d{6}$/.test(confirmationCode)) {
    throw new Error("必须输入六位确认码才能配对。");
  }
  if (confirmationCode !== hubPairChallenge.confirmation_code) {
    throw new Error("确认码与 Hub 显示的代码不一致。");
  }
  const profileId = await getAnonymousProfileId();
  const response = await sendHubRequest({
    type: "PairDecision",
    payload: {
      request_id: hubPairChallenge.request_id,
      profile_id: profileId,
      approved: true,
      confirmation_code: confirmationCode,
    },
  });
  if (response?.type !== "PairResult" || !response.payload?.paired) {
    throw new Error("Hub 拒绝了该 Profile 配对。");
  }
  hubPairChallenge = null;
  return getHubStatus();
}

async function setHubEnabled(enabled) {
  await chrome.storage.local.set({ [HUB_BRIDGE_SETTINGS_KEY]: { enabled } });
  if (!enabled) {
    closeHubPort();
    hubConnectionState = "disabled";
    hubLastError = "";
    return getHubStatus();
  }
  return connectHub();
}

async function getHubStatus() {
  const settings = await readHubSettings();
  return {
    enabled: settings.enabled,
    state: hubConnectionState,
    error: hubLastError || "",
    pairingCode: hubPairChallenge?.confirmation_code || "",
  };
}

globalThis.MeetBridgeHubLink = {
  connect: connectHub,
  confirmPairing,
  requestSession,
  getStatus: getHubStatus,
  setEnabled: setHubEnabled,
};
