importScripts("hub-link.js");

const OFFSCREEN_PATH = "offscreen.html";
const DIAGNOSTIC_KEY = "diagnosticLogV1";
const DIAGNOSTIC_SESSION_KEY = "diagnosticSessionV2";
const CUSTOM_SITE_RULES_KEY = "customSiteRulesV1";
const SELF_MUTED_KEY = "selfMutedV1";
const BRIDGE_PRESET_KEY = "bridgePresetV1";
const CHANNEL_CONFIG_KEY = "channelConfigV1";
const MIGRATABLE_SETTINGS_KEYS = [
  CHANNEL_CONFIG_KEY,
  SELF_MUTED_KEY,
  BRIDGE_PRESET_KEY,
  CUSTOM_SITE_RULES_KEY,
  "microphoneDeviceId",
];
const DIAGNOSTIC_DURATION_MS = 10 * 60 * 1_000;
const MAX_DIAGNOSTIC_ENTRIES = 400;
const CUSTOM_CONTENT_SCRIPT_IDS = [
  "meet-bridge-custom-isolated",
  "meet-bridge-custom-main",
];
const HUB_ENDPOINT_STORAGE_KEY = "hubEndpointIdsV1";
const hubRouteRestores = new Map();

async function getHubEndpointId(tabId) {
  const key = String(Number(tabId));
  const stored = await chrome.storage.session.get(HUB_ENDPOINT_STORAGE_KEY);
  const endpoints = stored[HUB_ENDPOINT_STORAGE_KEY] || {};
  if (typeof endpoints[key] === "string" && /^[0-9a-f-]{36}$/i.test(endpoints[key])) {
    return endpoints[key];
  }
  const endpointId = crypto.randomUUID();
  endpoints[key] = endpointId;
  await chrome.storage.session.set({ [HUB_ENDPOINT_STORAGE_KEY]: endpoints });
  return endpointId;
}

async function forgetHubEndpointId(tabId) {
  const key = String(Number(tabId));
  const stored = await chrome.storage.session.get(HUB_ENDPOINT_STORAGE_KEY);
  const endpoints = stored[HUB_ENDPOINT_STORAGE_KEY] || {};
  if (!(key in endpoints)) return;
  delete endpoints[key];
  await chrome.storage.session.set({ [HUB_ENDPOINT_STORAGE_KEY]: endpoints });
}

async function clearHubEndpointIds() {
  await chrome.storage.session.remove(HUB_ENDPOINT_STORAGE_KEY);
}
let diagnosticEntries = [];
let diagnosticEnabledUntil = 0;
let diagnosticSessionLoaded = false;
let diagnosticSessionPromise = null;

const SAFE_DIAGNOSTIC_STRING_KEYS = new Set([
  "event",
  "name",
  "code",
  "state",
  "status",
  "role",
  "micMode",
  "mode",
  "source",
  "renderer",
  "channel",
  "descriptionType",
  "constructor",
  "kind",
  "trackKind",
  "trackState",
  "outputState",
  "contextState",
  "trackRole",
]);

function sanitizeDiagnosticValue(value, key = "", depth = 0) {
  if (depth > 3 || value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (!SAFE_DIAGNOSTIC_STRING_KEYS.has(key)) return undefined;
    return value.slice(0, 80);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeDiagnosticValue(item, key, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return undefined;
  const result = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
    if (/url|href|title|room|text|label|device|credential|username|token|sdp|candidate|stack|constraint|message/i.test(childKey)) {
      continue;
    }
    const sanitized = sanitizeDiagnosticValue(childValue, childKey, depth + 1);
    if (sanitized !== undefined) result[childKey] = sanitized;
  }
  return result;
}

async function loadDiagnosticSession() {
  if (diagnosticSessionLoaded) return;
  if (!diagnosticSessionPromise) {
    diagnosticSessionPromise = chrome.storage.session
      .get(DIAGNOSTIC_SESSION_KEY)
      .then((stored) => {
        const value = Number(stored[DIAGNOSTIC_SESSION_KEY]?.enabledUntil) || 0;
        diagnosticEnabledUntil = value > Date.now() ? value : 0;
        diagnosticSessionLoaded = true;
      })
      .finally(() => {
        diagnosticSessionPromise = null;
      });
  }
  await diagnosticSessionPromise;
}

async function getDiagnosticState() {
  await loadDiagnosticSession();
  if (diagnosticEnabledUntil && diagnosticEnabledUntil <= Date.now()) {
    await setDiagnosticsEnabled(false);
  }
  return {
    enabled: diagnosticEnabledUntil > Date.now(),
    enabledUntil: diagnosticEnabledUntil || null,
    count: diagnosticEntries.length,
    persistent: false,
  };
}

async function notifyDiagnosticMode(enabled) {
  if (!(await hasOffscreenDocument())) return;
  await askOffscreen("SET_DIAGNOSTICS", { enabled }).catch(() => {});
}

async function setDiagnosticsEnabled(enabled) {
  await loadDiagnosticSession();
  if (enabled) {
    diagnosticEntries = [];
    diagnosticEnabledUntil = Date.now() + DIAGNOSTIC_DURATION_MS;
    await chrome.storage.session.set({
      [DIAGNOSTIC_SESSION_KEY]: { enabledUntil: diagnosticEnabledUntil },
    });
  } else {
    diagnosticEnabledUntil = 0;
    diagnosticEntries = [];
    await chrome.storage.session.remove(DIAGNOSTIC_SESSION_KEY);
  }
  await notifyDiagnosticMode(Boolean(enabled));
  return getDiagnosticState();
}

function normalizeChannelId(value) {
  const channelId = Number(value);
  return [1, 2, 3].includes(channelId) ? channelId : 1;
}

function defaultChannelConfig() {
  return {
    selected: 1,
    names: { 1: "频道 1", 2: "频道 2", 3: "频道 3" },
    // New installations start muted. The user explicitly enables a channel
    // before its physical microphone can enter a meeting mix.
    micMuted: { 1: true, 2: true, 3: true },
    monitorMuted: { 1: false, 2: false, 3: false },
    monitorAllMuted: false,
  };
}

async function getChannelConfig() {
  const defaults = defaultChannelConfig();
  const stored = await chrome.storage.local.get(CHANNEL_CONFIG_KEY);
  const saved = stored[CHANNEL_CONFIG_KEY];
  if (!saved || typeof saved !== "object") return defaults;
  const names = { ...defaults.names };
  const micMuted = { ...defaults.micMuted };
  const monitorAllMuted =
    typeof saved.monitorAllMuted === "boolean"
      ? saved.monitorAllMuted
      : [1, 2, 3].every((id) => Boolean(saved.monitorMuted?.[id]));
  const monitorMuted = { ...defaults.monitorMuted };
  for (const id of [1, 2, 3]) {
    const name = saved.names?.[id];
    if (typeof name === "string" && name.trim()) {
      names[id] = name.trim().slice(0, 18);
    }
    micMuted[id] =
      typeof saved.micMuted?.[id] === "boolean"
        ? saved.micMuted[id]
        : defaults.micMuted[id];
    monitorMuted[id] = Boolean(saved.monitorMuted?.[id]);
  }
  return {
    selected: normalizeChannelId(saved.selected),
    names,
    micMuted,
    monitorMuted,
    monitorAllMuted,
  };
}

async function storeChannelConfig(config) {
  await chrome.storage.local.set({ [CHANNEL_CONFIG_KEY]: config });
  return config;
}

async function selectChannel(channelId) {
  const config = await getChannelConfig();
  config.selected = normalizeChannelId(channelId);
  await storeChannelConfig(config);
  return { ok: true, channelConfig: config };
}

async function renameChannel(channelId, name) {
  const id = normalizeChannelId(channelId);
  const normalizedName = typeof name === "string" ? name.trim().slice(0, 18) : "";
  if (!normalizedName) throw new Error("频道名称不能为空。");
  const config = await getChannelConfig();
  config.names[id] = normalizedName;
  await storeChannelConfig(config);
  return { ok: true, channelConfig: config };
}

async function setChannelMicMuted(channelId, muted) {
  const id = normalizeChannelId(channelId);
  const config = await getChannelConfig();
  const previous = Boolean(config.micMuted[id]);
  config.micMuted[id] = Boolean(muted);
  await storeChannelConfig(config);
  try {
    if (await hasOffscreenDocument()) {
      const result = await askOffscreen("SET_CHANNEL_MIC_MUTED", {
        channelId: id,
        muted: config.micMuted[id],
      });
      if (!result?.ok) throw new Error(result?.error || "频道发言状态切换失败。");
    }
    return { ok: true, channelId: id, muted: config.micMuted[id] };
  } catch (error) {
    config.micMuted[id] = previous;
    await storeChannelConfig(config);
    throw error;
  }
}

async function setChannelMonitorMuted(channelId, muted) {
  const id = normalizeChannelId(channelId);
  const config = await getChannelConfig();
  const previous = Boolean(config.monitorMuted[id]);
  config.monitorMuted[id] = Boolean(muted);
  config.monitorAllMuted = [1, 2, 3].every((channelId) =>
    Boolean(config.monitorMuted[channelId]),
  );
  await storeChannelConfig(config);
  try {
    if (await hasOffscreenDocument()) {
      const result = await askOffscreen("SET_CHANNEL_MONITOR_MUTED", {
        channelId: id,
        muted: config.monitorMuted[id],
      });
      if (!result?.ok) throw new Error(result?.error || "频道监听状态切换失败。");
    }
    return { ok: true, channelId: id, muted: config.monitorMuted[id] };
  } catch (error) {
    config.monitorMuted[id] = previous;
    await storeChannelConfig(config);
    throw error;
  }
}

async function setAllMonitorMuted(muted) {
  const config = await getChannelConfig();
  const previous = {
    monitorAllMuted: config.monitorAllMuted,
    monitorMuted: { ...config.monitorMuted },
  };
  config.monitorAllMuted = Boolean(muted);
  for (const id of [1, 2, 3]) config.monitorMuted[id] = config.monitorAllMuted;
  await storeChannelConfig(config);
  try {
    if (await hasOffscreenDocument()) {
      const result = await askOffscreen("SET_CHANNEL_MONITOR_STATES", {
        states: config.monitorMuted,
      });
      if (!result?.ok) throw new Error(result?.error || "会议收听状态切换失败。");
    }
    return { ok: true, muted: config.monitorAllMuted };
  } catch (error) {
    config.monitorAllMuted = previous.monitorAllMuted;
    config.monitorMuted = previous.monitorMuted;
    await storeChannelConfig(config);
    throw error;
  }
}

async function appendDiagnostic(entry, sender) {
  const state = await getDiagnosticState();
  if (!state.enabled || !entry || typeof entry !== "object") return;
  const event =
    typeof entry.event === "string"
      ? entry.event.replace(/[^a-z0-9._:-]/gi, "").slice(0, 80)
      : "unknown";
  diagnosticEntries.push({
    at: new Date().toISOString(),
    event,
    detail: sanitizeDiagnosticValue(entry.detail || {}),
    tabId: sender.tab?.id ?? null,
    frameId: sender.frameId ?? 0,
  });
  if (diagnosticEntries.length > MAX_DIAGNOSTIC_ENTRIES) {
    diagnosticEntries.splice(
      0,
      diagnosticEntries.length - MAX_DIAGNOSTIC_ENTRIES,
    );
  }
}

async function getDiagnosticLog() {
  const state = await getDiagnosticState();
  return state.enabled ? diagnosticEntries.map((entry) => ({ ...entry })) : [];
}

const TAB_TYPES = [
  {
    role: "meeting",
    micMode: "page",
    patterns: [
      /^https:\/\/([^.]+\.)*facebook\.com\//i,
      /^https:\/\/([^.]+\.)*messenger\.com\//i,
      /^https:\/\/meet\.jit\.si\//i,
    ],
  },
  {
    role: "meeting",
    micMode: "shared",
    patterns: [
      /^https:\/\/([^.]+\.)*instagram\.com\//i,
      /^https:\/\/([^.]+\.)*teams\.microsoft\.com\//i,
      /^https:\/\/([^.]+\.)*teams\.cloud\.microsoft\//i,
      /^https:\/\/teams\.live\.com\//i,
      /^https:\/\/meet\.google\.com\//i,
    ],
  },
  {
    role: "source",
    micMode: "none",
    patterns: [
      /^https:\/\/([^.]+\.)*youtube\.com\//i,
      /^https:\/\/youtu\.be\//i,
      /^https:\/\/([^.]+\.)*youtube-nocookie\.com\//i,
    ],
  },
];

let creatingOffscreen = null;

function getBuiltInTabType(url = "") {
  return TAB_TYPES.find(({ patterns }) =>
    patterns.some((pattern) => pattern.test(url)),
  );
}

function getHttpOrigin(url = "") {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.origin : "";
  } catch {
    return "";
  }
}

function originMatchPattern(origin = "") {
  try {
    const parsed = new URL(origin);
    if (!["https:", "http:"].includes(parsed.protocol)) return "";
    // Chrome match patterns do not contain ports. Host permission therefore
    // applies to the selected host while the stored routing rule remains tied
    // to the page's exact origin (including a development port, if present).
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return "";
  }
}

async function getCustomSiteRules() {
  const stored = await chrome.storage.local.get(CUSTOM_SITE_RULES_KEY);
  const rules = stored[CUSTOM_SITE_RULES_KEY];
  return rules && typeof rules === "object" && !Array.isArray(rules) ? rules : {};
}

function getTabType(url = "", customRules = {}) {
  const builtIn = getBuiltInTabType(url);
  if (builtIn) return { ...builtIn, builtIn: true };
  const origin = getHttpOrigin(url);
  const role = customRules[origin];
  if (!["meeting", "source", "receiver"].includes(role)) return null;
  return {
    role,
    micMode: role === "source" ? "none" : "shared",
    custom: true,
    origin,
  };
}

let customRegistrationQueue = Promise.resolve();
function syncCustomContentScripts(customRules) {
  const run = async () => {
    const rules = customRules || (await getCustomSiteRules());
    const candidates = [...new Set(Object.keys(rules).map(originMatchPattern))]
      .filter(Boolean);
    const permitted = await Promise.all(
      candidates.map(async (pattern) => ({
        pattern,
        allowed: await chrome.permissions.contains({ origins: [pattern] }),
      })),
    );
    const matches = permitted
      .filter(({ allowed }) => allowed)
      .map(({ pattern }) => pattern);
    await chrome.scripting
      .unregisterContentScripts({ ids: CUSTOM_CONTENT_SCRIPT_IDS })
      .catch(() => {});
    if (!matches.length) return;
    await chrome.scripting.registerContentScripts([
      {
        id: CUSTOM_CONTENT_SCRIPT_IDS[0],
        matches,
        js: ["content-bridge.js"],
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: "document_start",
        world: "ISOLATED",
        persistAcrossSessions: true,
      },
      {
        id: CUSTOM_CONTENT_SCRIPT_IDS[1],
        matches,
        js: ["main-world.js"],
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: "document_start",
        world: "MAIN",
        persistAcrossSessions: true,
      },
    ]);
  };
  customRegistrationQueue = customRegistrationQueue.catch(() => {}).then(run);
  return customRegistrationQueue;
}

async function setCustomSiteRole(origin, role) {
  const normalizedOrigin = getHttpOrigin(origin);
  if (!normalizedOrigin || !["meeting", "source", "receiver"].includes(role)) {
    throw new Error("自定义网站类型无效。");
  }
  if (getBuiltInTabType(`${normalizedOrigin}/`)) {
    throw new Error("内置支持的网站不需要自定义规则。");
  }
  const pattern = originMatchPattern(normalizedOrigin);
  const permitted = await chrome.permissions.contains({ origins: [pattern] });
  if (!permitted) throw new Error("尚未授权该网站，请重新选择并允许访问。");
  const rules = await getCustomSiteRules();
  rules[normalizedOrigin] = role;
  await chrome.storage.local.set({ [CUSTOM_SITE_RULES_KEY]: rules });
  await syncCustomContentScripts(rules);
  return { ok: true, origin: normalizedOrigin, role };
}

async function hasOffscreenDocument() {
  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }

  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    // The offscreen document renders the Web Audio mix into a
    // MediaStreamDestination before it is sent over WebRTC. USER_MEDIA and
    // WEB_RTC alone permit capture/transport but do not declare audio
    // rendering; AUDIO_PLAYBACK keeps that render graph active.
    reasons: ["USER_MEDIA", "WEB_RTC", "AUDIO_PLAYBACK"],
    justification:
      "Capture the physical microphone, mix captured meeting audio, and send mix-minus tracks through local WebRTC connections.",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function askOffscreen(type, payload = {}) {
  return chrome.runtime.sendMessage({
    target: "offscreen",
    type,
    ...payload,
  });
}

async function getMicrophoneDeviceId() {
  const stored = await chrome.storage.local.get("microphoneDeviceId");
  return typeof stored.microphoneDeviceId === "string"
    ? stored.microphoneDeviceId
    : "";
}

async function getSelfMuted() {
  const stored = await chrome.storage.local.get(SELF_MUTED_KEY);
  return Boolean(stored[SELF_MUTED_KEY]);
}

async function setSelfMuted(muted) {
  const nextMuted = Boolean(muted);
  const previousMuted = await getSelfMuted();
  await chrome.storage.local.set({ [SELF_MUTED_KEY]: nextMuted });
  try {
    if (await hasOffscreenDocument()) {
      const result = await askOffscreen("SET_SELF_MUTED", { muted: nextMuted });
      if (!result?.ok) throw new Error(result?.error || "本人声音切换失败。");
    }
    return { ok: true, muted: nextMuted };
  } catch (error) {
    await chrome.storage.local.set({ [SELF_MUTED_KEY]: previousMuted });
    throw error;
  }
}

async function getBridgePreset() {
  const stored = await chrome.storage.local.get(BRIDGE_PRESET_KEY);
  const preset = stored[BRIDGE_PRESET_KEY];
  return preset && Array.isArray(preset.entries) ? preset : null;
}

function summarizePresetRoutes(tabs = []) {
  const groups = new Map();
  for (const tab of tabs) {
    const origin = getHttpOrigin(tab.url);
    if (!origin || !["meeting", "source", "receiver"].includes(tab.role)) continue;
    const channelId = normalizeChannelId(tab.channelId);
    const key = `${origin}\n${tab.role}\n${channelId}`;
    const current = groups.get(key) || {
      origin,
      role: tab.role,
      channelId,
      count: 0,
      label: "",
    };
    current.count += 1;
    if (!current.label) {
      try {
        current.label = new URL(origin).hostname;
      } catch {
        current.label = origin;
      }
    }
    groups.set(key, current);
  }
  return [...groups.values()];
}

async function saveCurrentPreset() {
  const bridge = await getBridgeState();
  const entries = summarizePresetRoutes(bridge.tabs);
  if (!entries.length) throw new Error("请先加入至少一个会议或音频源。");
  const preset = {
    savedAt: new Date().toISOString(),
    entries,
  };
  await chrome.storage.local.set({ [BRIDGE_PRESET_KEY]: preset });
  return { ok: true, preset };
}

async function clearBridgePreset() {
  await chrome.storage.local.remove(BRIDGE_PRESET_KEY);
  return { ok: true };
}

async function clearAllLocalData() {
  const rules = await getCustomSiteRules();
  const removableOrigins = [
    ...new Set(Object.keys(rules).map(originMatchPattern).filter(Boolean)),
  ];
  if (await hasOffscreenDocument()) {
    await askOffscreen("STOP_ALL").catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  await setDiagnosticsEnabled(false);
  await chrome.storage.local.clear();
  await syncCustomContentScripts({});
  if (removableOrigins.length) {
    await chrome.permissions.remove({ origins: removableOrigins }).catch(() => {});
  }
  return { ok: true };
}

async function exportSettings() {
  const stored = await chrome.storage.local.get(MIGRATABLE_SETTINGS_KEYS);
  const settings = {};
  for (const key of MIGRATABLE_SETTINGS_KEYS) {
    if (stored[key] !== undefined) settings[key] = stored[key];
  }
  return { ok: true, format: "meet-bridge-settings-v1", settings };
}

async function importSettings(payload) {
  if (payload?.format !== "meet-bridge-settings-v1" || !payload.settings || typeof payload.settings !== "object") {
    throw new Error("不是有效的 Meet Bridge 设置文件。");
  }
  const accepted = {};
  for (const key of MIGRATABLE_SETTINGS_KEYS) {
    if (payload.settings[key] !== undefined) accepted[key] = payload.settings[key];
  }
  await chrome.storage.local.set(accepted);
  await syncCustomContentScripts(accepted[CUSTOM_SITE_RULES_KEY]).catch(() => {});
  return { ok: true };
}

function buildPresetPlan(preset, eligibleTabs, bridgeTabs) {
  if (!preset?.entries?.length) return null;
  const joinedIds = new Set(bridgeTabs.map((tab) => tab.tabId));
  let joined = 0;
  let total = 0;
  let unavailable = 0;
  let nextTab = null;
  let nextChannelId = null;
  const reservedIds = new Set();

  for (const entry of preset.entries) {
    const wanted = Math.max(1, Number(entry.count) || 1);
    const channelId = normalizeChannelId(entry.channelId);
    total += wanted;
    const joinedCandidates = bridgeTabs.filter(
      (tab) =>
        getHttpOrigin(tab.url) === entry.origin &&
        tab.role === entry.role &&
        normalizeChannelId(tab.channelId) === channelId,
    );
    joined += Math.min(wanted, joinedCandidates.length);
    const stillNeeded = Math.max(0, wanted - joinedCandidates.length);
    const available = eligibleTabs.filter(
      (tab) =>
        getHttpOrigin(tab.url) === entry.origin &&
        tab.role === entry.role &&
        !joinedIds.has(tab.id) &&
        !reservedIds.has(tab.id),
    );
    const assigned = available.slice(0, stillNeeded);
    for (const tab of assigned) reservedIds.add(tab.id);
    if (assigned.length > 0 && !nextTab) {
      nextTab = assigned[0];
      nextChannelId = channelId;
    }
    unavailable += Math.max(0, stillNeeded - assigned.length);
  }

  return {
    joined,
    total,
    unavailable,
    complete: joined >= total,
    nextTabId: nextTab?.id ?? null,
    nextTitle: nextTab?.title || "",
    nextChannelId,
  };
}

async function setMicrophoneDevice(deviceId) {
  const normalizedDeviceId = typeof deviceId === "string" ? deviceId : "";
  const previousDeviceId = await getMicrophoneDeviceId();
  await chrome.storage.local.set({ microphoneDeviceId: normalizedDeviceId });

  try {
    if (await hasOffscreenDocument()) {
      const result = await askOffscreen("SET_MICROPHONE_DEVICE", {
        deviceId: normalizedDeviceId,
      });
      if (!result?.ok) {
        throw new Error(result?.error || "切换麦克风失败。");
      }
      return result;
    }

    return { ok: true, deferred: true };
  } catch (error) {
    await chrome.storage.local.set({ microphoneDeviceId: previousDeviceId });
    throw error;
  }
}

async function getBridgeState() {
  if (!(await hasOffscreenDocument())) {
    return { running: false, microphone: "unknown", tabs: [] };
  }

  try {
    return await askOffscreen("GET_STATE");
  } catch {
    return { running: false, microphone: "unknown", tabs: [] };
  }
}

async function getCaptureShortcut() {
  const commands = await chrome.commands.getAll();
  return (
    commands.find((command) => command.name === "capture-active-meeting")
      ?.shortcut || ""
  );
}

async function getPopupData() {
  const [
    tabs,
    activeTabs,
    bridge,
    captureShortcut,
    customRules,
    selfMuted,
    preset,
    channelConfig,
    diagnosticState,
  ] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, currentWindow: true }),
    getBridgeState(),
    getCaptureShortcut(),
    getCustomSiteRules(),
    getSelfMuted(),
    getBridgePreset(),
    getChannelConfig(),
    getDiagnosticState(),
  ]);

  const activeTabId = activeTabs[0]?.id ?? null;
  const eligibleTabs = tabs
    .map((tab) => ({ tab, type: getTabType(tab.url, customRules) }))
    .filter(({ tab, type }) => Number.isInteger(tab.id) && type)
    .map(({ tab, type }) => ({
      id: tab.id,
      title: tab.title || "未命名标签页",
      url: tab.url,
      role: type.role,
      micMode: type.micMode,
      custom: Boolean(type.custom),
      active: tab.id === activeTabId,
    }));
  const current = activeTabs[0];
  const currentType = getTabType(current?.url, customRules);
  const currentTab = Number.isInteger(current?.id)
    ? {
        id: current.id,
        title: current.title || "未命名标签页",
        url: current.url || "",
        role: currentType?.role || null,
        micMode: currentType?.micMode || "none",
        custom: Boolean(currentType?.custom),
        customizable: Boolean(getHttpOrigin(current.url)) && !getBuiltInTabType(current.url),
        origin: getHttpOrigin(current.url),
        permissionPattern: originMatchPattern(getHttpOrigin(current.url)),
      }
    : null;

  return {
    activeTabId,
    currentTab,
    eligibleTabs,
    bridge,
    captureShortcut,
    selfMuted,
    preset,
    channelConfig,
    diagnosticState,
    presetPlan: buildPresetPlan(preset, eligibleTabs, bridge.tabs || []),
  };
}

async function addTab(tab, { focusTarget = false, channelId = null } = {}) {
  const customRules = await getCustomSiteRules();
  const tabType = getTabType(tab?.url, customRules);
  const role = tabType?.role || null;
  const micMode = tabType?.micMode || "none";
  const channelConfig = await getChannelConfig();
  const targetChannelId = normalizeChannelId(channelId ?? channelConfig.selected);
  if (!tab?.id || !role) {
    throw new Error("目标标签页尚未设置为会议、音频源或识别端。");
  }

  if (focusTarget) {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  }

  await ensureOffscreenDocument();

  await askOffscreen("SET_DIAGNOSTICS", {
    enabled: (await getDiagnosticState()).enabled,
  });

  await askOffscreen("SET_SELF_MUTED", { muted: await getSelfMuted() });
  await askOffscreen("SET_CHANNEL_MIC_STATES", {
    states: channelConfig.micMuted,
  });
  await askOffscreen("SET_CHANNEL_MONITOR_STATES", {
    states: channelConfig.monitorMuted,
  });

  const hubStatusBeforeCapture = await MeetBridgeHubLink.getStatus();
  const useHubMicrophone =
    hubStatusBeforeCapture.enabled && hubStatusBeforeCapture.state === "connected";

  if (role === "meeting" && !useHubMicrophone) {
    const deviceId = await getMicrophoneDeviceId();
    const microphone = await askOffscreen("ENSURE_MICROPHONE", { deviceId });
    if (!microphone?.ok) {
      const permissionDenied = microphone?.code === "NotAllowedError";
      const error = new Error(
        permissionDenied
          ? "尚未获得麦克风权限。请先点击“选择麦克风”，在新页面完成授权。"
          : `麦克风打开失败：${microphone?.error || "请重新选择输入设备。"}`,
      );
      error.code = permissionDenied
        ? "MIC_PERMISSION_REQUIRED"
        : microphone?.code || "MICROPHONE_ERROR";
      throw error;
    }
  }

  const existing = await getBridgeState();
  const existingTab = existing.tabs.find((item) => item.tabId === tab.id);
  if (existingTab?.role === role && existingTab?.micMode === micMode) {
    if (normalizeChannelId(existingTab.channelId) !== targetChannelId) {
      await askOffscreen("SET_TAB_CHANNEL", {
        tabId: tab.id,
        channelId: targetChannelId,
      });
      return {
        ok: true,
        tabId: tab.id,
        role,
        channelId: targetChannelId,
        moved: true,
      };
    }
    if (role === "meeting" || role === "receiver") {
      await chrome.tabs.reload(tab.id);
    }
    return { ok: true, tabId: tab.id, role, alreadyAdded: true };
  }
  if (existingTab) {
    await askOffscreen("REMOVE_TAB", { tabId: tab.id });
  }

  // Current Chrome recommendation: obtain the single-use ID in the service
  // worker after an explicit action invocation, then consume it immediately in
  // the extension's offscreen document. Omitting consumerTabId makes Chrome 116+
  // scope the ID to the extension origin instead of one renderer process.
  const streamId =
    role === "receiver"
      ? ""
      : await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const added = await askOffscreen("ADD_TAB", {
    tab: {
      tabId: tab.id,
      title: tab.title || "未命名会议标签页",
      url: tab.url,
      role,
      micMode,
      channelId: targetChannelId,
      streamId,
    },
  });

  if (!added?.ok) {
    throw new Error(added?.error || "标签页音频捕获失败。");
  }

  const hubStatus = await MeetBridgeHubLink.getStatus();
  if (hubStatus.enabled && hubStatus.state === "connected") {
    try {
      const endpointId = await getHubEndpointId(tab.id);
      const grant = await MeetBridgeHubLink.requestSession(endpointId, targetChannelId);
      const hubRoute = await askOffscreen("SET_HUB_SESSION", { tabId: tab.id, endpointId, grant });
      if (!hubRoute?.ok) throw new Error(hubRoute?.error || "Hub 音频路由未建立。");
    } catch (error) {
      appendDiagnostic({ event: "hub-session-unavailable", detail: { code: error?.name || "HUB_SESSION_ERROR" } }, { tab }).catch(() => {});
    }
  }

  if (role === "meeting" || role === "receiver") {
    // Meeting pages reload so their code obtains the bridged microphone from
    // the document_start override. Source-only media tabs must not reload.
    await chrome.tabs.reload(tab.id);
  }
  return {
    ok: true,
    tabId: tab.id,
    role,
    micMode,
    channelId: targetChannelId,
  };
}

async function addCurrentTab(channelId = null) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return addTab(tab, { channelId });
}

async function addTabById(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const shortcut = await getCaptureShortcut();
  if (!shortcut) {
    return {
      ok: true,
      needsCaptureAuthorization: true,
      needsShortcut: true,
      tabId: tab.id,
    };
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  // activeTab is deliberately scoped by Chrome to the tab that received the
  // user invocation. A popup opened for another tab cannot transfer that grant.
  // The keyboard command below is the authorized one-step continuation.
  return {
    ok: true,
    needsCaptureAuthorization: true,
    shortcut,
    tabId: tab.id,
  };
}

async function removeTab(tabId) {
  if (!(await hasOffscreenDocument())) return { ok: true };
  return askOffscreen("REMOVE_TAB", { tabId });
}

async function moveTabToChannel(tabId, channelId) {
  if (!(await hasOffscreenDocument())) throw new Error("桥接尚未运行。");
  return askOffscreen("SET_TAB_CHANNEL", {
    tabId,
    channelId: normalizeChannelId(channelId),
  });
}

async function stopChannel(channelId) {
  if (!(await hasOffscreenDocument())) return { ok: true };
  return askOffscreen("STOP_CHANNEL", {
    channelId: normalizeChannelId(channelId),
  });
}

async function stopAll() {
  if (await hasOffscreenDocument()) {
    await askOffscreen("STOP_ALL");
    await chrome.offscreen.closeDocument();
  }
  await clearHubEndpointIds();
  await setDiagnosticsEnabled(false);
  return { ok: true };
}

async function setHubEnabledForExistingRoutes(enabled) {
  const status = await MeetBridgeHubLink.setEnabled(enabled);
  const bridge = await getBridgeState();
  const routes = bridge.tabs || [];
  if (!enabled) {
    for (const route of routes) {
      await askOffscreen("CLEAR_HUB_SESSION", { tabId: route.tabId }).catch(() => {});
    }
    await clearHubEndpointIds();
    return { ...status, audioRoutesRequested: 0 };
  }

  // A first-time Profile still needs the explicit confirmation. A previously
  // paired Profile has no challenge and can attach every existing route now.
  if (status.state !== "connected" || status.pairingCode) {
    return { ...status, audioRoutesRequested: 0 };
  }
  const results = [];
  for (const route of routes) {
    results.push(await restoreHubRoute(route.tabId, route.channelId));
  }
  return {
    ...status,
    audioRoutesRequested: routes.length,
    audioRoutesReady: results.filter((result) => result?.ok).length,
  };
}

async function confirmHubPairingForExistingRoutes(confirmationCode) {
  const status = await MeetBridgeHubLink.confirmPairing(confirmationCode);
  const bridge = await getBridgeState();
  const results = [];
  for (const route of bridge.tabs || []) {
    results.push(await restoreHubRoute(route.tabId, route.channelId));
  }
  return {
    ...status,
    audioRoutesRequested: results.length,
    audioRoutesReady: results.filter((result) => result?.ok).length,
  };
}
async function restoreHubRoute(tabId, channelId = null) {
  const key = String(Number(tabId));
  if (hubRouteRestores.has(key)) return hubRouteRestores.get(key);
  const task = (async () => {
    const bridge = await getBridgeState();
    const route = bridge.tabs?.find((item) => item.tabId === Number(tabId));
    if (!route) return { ok: true, missing: true };
    const targetChannelId = normalizeChannelId(channelId ?? route.channelId);
    const hubStatus = await MeetBridgeHubLink.getStatus();
    if (hubStatus.enabled) await MeetBridgeHubLink.connect();
    const connected = (await MeetBridgeHubLink.getStatus()).state === "connected";
    if (connected) {
      try {
        // Close the old socket before asking the Hub for a replacement. This
        // prevents a transient third endpoint from being mixed during retries.
        await askOffscreen("CLEAR_HUB_SESSION", { tabId: route.tabId });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const endpointId = await getHubEndpointId(route.tabId);
        const grant = await MeetBridgeHubLink.requestSession(endpointId, targetChannelId);
        return askOffscreen("SET_HUB_SESSION", { tabId: route.tabId, endpointId, grant });
      } catch (error) {
        appendDiagnostic({ event: "hub-route-reconnect-failed", detail: { code: error?.name || "HUB_RECONNECT_ERROR" } }).catch(() => {});
      }
    }
    await askOffscreen("CLEAR_HUB_SESSION", { tabId: route.tabId });
    if (route.role === "meeting") {
      const microphone = await askOffscreen("ENSURE_MICROPHONE", { deviceId: await getMicrophoneDeviceId() });
      if (!microphone?.ok) {
        appendDiagnostic({ event: "hub-route-local-fallback-unavailable", detail: { code: microphone?.code || "MICROPHONE_ERROR" } }).catch(() => {});
      }
    }
    return { ok: false, recoveredLocally: true };
  })();
  hubRouteRestores.set(key, task);
  try {
    return await task;
  } finally {
    if (hubRouteRestores.get(key) === task) hubRouteRestores.delete(key);
  }
}
async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // The page may be navigating. Its document_start bridge announces itself
    // again, which causes a fresh negotiation.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") return undefined;

  const run = async () => {
    switch (message.type) {
      case "GET_POPUP_DATA":
        return {
          ...(await getPopupData()),
          hub: await MeetBridgeHubLink.getStatus(),
        };

      case "GET_HUB_STATUS":
        return MeetBridgeHubLink.getStatus();

      case "SET_HUB_ENABLED":
        return setHubEnabledForExistingRoutes(Boolean(message.enabled));

      case "CONFIRM_HUB_PAIRING":
        return confirmHubPairingForExistingRoutes(message.confirmationCode);

      case "REQUEST_HUB_SESSION":
        return MeetBridgeHubLink.requestSession(message.endpointId, normalizeChannelId(message.channelId));

      case "HUB_AUDIO_DISCONNECTED":
        return restoreHubRoute(Number(message.tabId));

      case "HUB_CHANNEL_CHANGED":
        return restoreHubRoute(Number(message.tabId), message.channelId);

      case "GET_DIAGNOSTIC_LOG":
        return { ok: true, entries: await getDiagnosticLog() };

      case "CLEAR_DIAGNOSTIC_LOG":
        diagnosticEntries = [];
        return { ok: true };

      case "SET_DIAGNOSTICS":
        return setDiagnosticsEnabled(Boolean(message.enabled));

      case "CLEAR_ALL_LOCAL_DATA":
        return clearAllLocalData();

      case "EXPORT_SETTINGS":
        return exportSettings();

      case "IMPORT_SETTINGS":
        return importSettings(message.payload);

      case "ADD_CURRENT_TAB":
        return addCurrentTab(message.channelId);

      case "ADD_TAB_BY_ID":
        return addTabById(Number(message.tabId));

      case "SET_CUSTOM_SITE_ROLE":
        return setCustomSiteRole(message.origin, message.role);

      case "SET_SELF_MUTED":
        return setSelfMuted(message.muted);

      case "SAVE_CURRENT_PRESET":
        return saveCurrentPreset();

      case "CLEAR_BRIDGE_PRESET":
        return clearBridgePreset();

      case "SELECT_CHANNEL":
        return selectChannel(message.channelId);

      case "RENAME_CHANNEL":
        return renameChannel(message.channelId, message.name);

      case "SET_CHANNEL_MIC_MUTED":
        return setChannelMicMuted(message.channelId, message.muted);

      case "SET_CHANNEL_MONITOR_MUTED":
        return setChannelMonitorMuted(message.channelId, message.muted);

      case "SET_ALL_MONITOR_MUTED":
        return setAllMonitorMuted(message.muted);

      case "MOVE_TAB_CHANNEL":
        return moveTabToChannel(Number(message.tabId), message.channelId);

      case "STOP_CHANNEL":
        return stopChannel(message.channelId);

      case "REMOVE_TAB":
        return removeTab(Number(message.tabId));

      case "STOP_ALL":
        return stopAll();

      case "ACTIVATE_TAB":
        {
          const tab = await chrome.tabs.get(Number(message.tabId));
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(tab.id, { active: true });
        }
        return { ok: true };

      case "OPEN_MIC_SETUP":
        await chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
        return { ok: true };

      case "OPEN_SHORTCUT_SETTINGS":
        await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
        return { ok: true };

      case "GET_MICROPHONE_DEVICE":
        return { ok: true, deviceId: await getMicrophoneDeviceId() };

      case "SET_MICROPHONE_DEVICE":
        return setMicrophoneDevice(message.deviceId);

      case "PAGE_READY": {
        const tabId = sender.tab?.id;
        if (!Number.isInteger(tabId)) return { ok: false };

        if (await hasOffscreenDocument()) {
          await askOffscreen("TAB_READY", { tabId });
        } else {
          await sendToTab(tabId, {
            type: "BRIDGE_CONFIG",
            active: false,
          });
        }
        return { ok: true };
      }

      case "SIGNAL_FROM_TAB": {
        const tabId = sender.tab?.id;
        if (!Number.isInteger(tabId) || !(await hasOffscreenDocument())) {
          return { ok: false };
        }
        await appendDiagnostic(
          {
            at: new Date().toISOString(),
            event: "background-received-tab-signal",
            detail: {
              channel: message.signal?.channel || "output",
              descriptionType: message.signal?.description?.type || null,
              hasCandidate: Boolean(message.signal?.candidate),
            },
          },
          sender,
        );
        return askOffscreen("SIGNAL_FROM_TAB", {
          tabId,
          signal: message.signal,
        });
      }

      case "PAGE_DIAGNOSTIC":
        if (message.entry && typeof message.entry === "object") {
          await appendDiagnostic(message.entry, sender);
        }
        return { ok: true };

      case "SIGNAL_TO_TAB":
        await sendToTab(Number(message.tabId), {
          type: "SIGNAL_FROM_OFFSCREEN",
          signal: message.signal,
        });
        return { ok: true };

      case "CONFIG_TO_TAB":
        await sendToTab(Number(message.tabId), {
          type: "BRIDGE_CONFIG",
          active: Boolean(message.active),
          micMode: message.micMode || "shared",
          role: message.role || "meeting",
          diagnosticsEnabled: Boolean(message.diagnosticsEnabled),
        });
        return { ok: true };

      default:
        return { ok: false, error: `Unknown message: ${message.type}` };
    }
  };

  run()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || String(error),
        code: error?.code,
      });
    });
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-self-mute") {
    void getSelfMuted()
      .then((muted) => setSelfMuted(!muted))
      .then(({ muted }) => {
        if (!Number.isInteger(tab?.id)) return;
        return sendToTab(tab.id, {
          type: "COMMAND_STATUS",
          message: muted
            ? "Meet Bridge：本人已静音，会议转发继续。"
            : "Meet Bridge：本人可以发言。",
        });
      })
      .catch(() => {});
    return;
  }
  if (command !== "capture-active-meeting") return;
  if (!Number.isInteger(tab?.id)) return;
  sendToTab(tab.id, {
    type: "COMMAND_STATUS",
    message: "Meet Bridge：正在加入当前呼叫窗口…",
  });
  appendDiagnostic(
    {
      at: new Date().toISOString(),
      event: "capture-command-invoked",
      detail: { tabId: tab.id, title: tab.title || "", url: tab.url || "" },
    },
    { tab, url: tab.url },
  ).catch(() => {});
  addTab(tab)
    .then(() => {
      appendDiagnostic(
        {
          at: new Date().toISOString(),
          event: "capture-command-succeeded",
          detail: { tabId: tab.id },
        },
        { tab, url: tab.url },
      ).catch(() => {});
    })
    .catch((error) => {
      const message = error?.message || String(error);
      sendToTab(tab.id, {
        type: "COMMAND_STATUS",
        message: `Meet Bridge 加入失败：${message}`,
        error: true,
      });
      appendDiagnostic(
        {
          at: new Date().toISOString(),
          event: "capture-command-failed",
          detail: { tabId: tab.id, message },
        },
        { tab, url: tab.url },
      ).catch(() => {});
    });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await forgetHubEndpointId(tabId);
  if (await hasOffscreenDocument()) {
    await askOffscreen("REMOVE_TAB", { tabId }).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(DIAGNOSTIC_KEY).catch(() => {});
  syncCustomContentScripts().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  syncCustomContentScripts().catch(() => {});
});

// Service workers can restart independently of Chrome startup. Reconcile the
// persisted registrations whenever this worker is evaluated as well.
chrome.storage.local.remove(DIAGNOSTIC_KEY).catch(() => {});
syncCustomContentScripts().catch(() => {});
