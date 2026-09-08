const statusLabels = {
  captured: "已捕获",
  feeding: "送入混音",
  connecting: "连接中",
  awaiting_microphone: "等待麦克风",
  mixing: "混音中",
  disconnected: "已断开",
  error: "错误",
};

const elements = {
  engineState: document.querySelector("#engineState"),
  channelCard: document.querySelector(".channel-card"),
  channelRouteSummary: document.querySelector("#channelRouteSummary"),
  channelVoiceState: document.querySelector("#channelVoiceState"),
  channelHint: document.querySelector("#channelHint"),
  toggleAllMonitor: document.querySelector("#toggleAllMonitor"),
  toggleSelfMute: document.querySelector("#toggleSelfMute"),
  hubState: document.querySelector("#hubState"),
  toggleHub: document.querySelector("#toggleHub"),
  hubPairingForm: document.querySelector("#hubPairingForm"),
  hubPairingCode: document.querySelector("#hubPairingCode"),
  confirmHubPairing: document.querySelector("#confirmHubPairing"),
  currentTitle: document.querySelector("#currentTitle"),
  currentHint: document.querySelector("#currentHint"),
  addCurrent: document.querySelector("#addCurrent"),
  customActions: document.querySelector("#customActions"),
  routeCount: document.querySelector("#routeCount"),
  routeHeading: document.querySelector("#routeHeading"),
  routeList: document.querySelector("#routeList"),
  presetProgress: document.querySelector("#presetProgress"),
  presetHint: document.querySelector("#presetHint"),
  presetNext: document.querySelector("#presetNext"),
  savePreset: document.querySelector("#savePreset"),
  clearPreset: document.querySelector("#clearPreset"),
  eligibleList: document.querySelector("#eligibleList"),
  shortcutCard: document.querySelector("#shortcutCard"),
  shortcutHint: document.querySelector("#shortcutHint"),
  shortcutSettings: document.querySelector("#shortcutSettings"),
  bridgeSafety: document.querySelector("#bridgeSafety"),
  diagnosticState: document.querySelector("#diagnosticState"),
  diagnosticHint: document.querySelector("#diagnosticHint"),
  toggleDiagnostics: document.querySelector("#toggleDiagnostics"),
  message: document.querySelector("#message"),
  micSetup: document.querySelector("#micSetup"),
  exportLog: document.querySelector("#exportLog"),
  exportSettings: document.querySelector("#exportSettings"),
  importSettings: document.querySelector("#importSettings"),
  settingsFile: document.querySelector("#settingsFile"),
  clearLocalData: document.querySelector("#clearLocalData"),
  stopAll: document.querySelector("#stopAll"),
};

let popupData = null;
let busy = false;
let displayedPairingCode = "";

async function callBackground(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type,
    ...payload,
  });
  if (response?.ok === false) {
    const error = new Error(response.error || "操作失败");
    error.code = response.code;
    throw error;
  }
  return response;
}

function showMessage(text = "", isError = false) {
  elements.message.textContent = text;
  elements.message.className = text ? `show${isError ? " error" : ""}` : "";
}

function makeRow(title, meta, actionLabel, onAction, status = "") {
  const row = document.createElement("div");
  row.className = "row";

  const copy = document.createElement("div");
  copy.className = "row-copy";
  const titleElement = document.createElement("div");
  titleElement.className = "row-title";
  titleElement.textContent = title;
  const metaElement = document.createElement("div");
  metaElement.className = "row-meta";
  metaElement.textContent = meta;
  copy.append(titleElement, metaElement);
  row.append(copy);

  if (status) {
    const badge = document.createElement("span");
    badge.className = `status ${status}`;
    badge.textContent = statusLabels[status] || status;
    row.append(badge);
  }

  const button = document.createElement("button");
  button.className = "mini";
  button.textContent = actionLabel;
  button.addEventListener("click", onAction);
  row.append(button);
  return row;
}

function normalizeChannelId(value) {
  const channelId = Number(value);
  return [1, 2, 3].includes(channelId) ? channelId : 1;
}

function channelName(data, channelId) {
  const id = normalizeChannelId(channelId);
  return data.channelConfig?.names?.[id] || `频道 ${id}`;
}

function makeRouteRow(route, data) {
  const hubDetail = route.hubState && route.hubState !== "local"
    ? ` · Hub：${route.hubState === "ready" ? "音频已认证" : route.hubState === "authenticating" ? "认证中" : route.hubState === "connecting" ? "连接中" : route.hubState === "error" ? route.hubError || "连接失败" : route.hubState}`
    : "";
  const row = makeRow(
    route.title,
    route.error ||
      `${route.role === "source" ? "媒体音频源" : route.role === "receiver" ? "识别接收端 · Web Speech" : "会议收发端"} · 标签页 ${route.tabId}${hubDetail}`,
    "移除",
    () => removeRoute(route.tabId),
    route.status,
  );
  const removeButton = row.lastElementChild;
  const controls = document.createElement("div");
  controls.className = "route-controls";
  const select = document.createElement("select");
  select.className = "route-channel-select";
  select.title = "移动到其他频道";
  for (const id of [1, 2, 3]) {
    const option = document.createElement("option");
    option.value = String(id);
    option.textContent = `${id} · ${channelName(data, id)}`;
    option.selected = normalizeChannelId(route.channelId) === id;
    select.append(option);
  }
  select.addEventListener("change", () =>
    moveRoute(route.tabId, Number(select.value)),
  );
  controls.append(select, removeButton);
  row.append(controls);
  return row;
}

function render(data) {
  popupData = data;
  const bridgeTabs = data.bridge?.tabs || [];
  const selectedChannelId = normalizeChannelId(data.channelConfig?.selected);
  const selectedChannelName = channelName(data, selectedChannelId);
  const selectedRoutes = bridgeTabs.filter(
    (route) => normalizeChannelId(route.channelId) === selectedChannelId,
  );
  const active = data.currentTab?.role ? data.currentTab : null;
  const activeRoute = bridgeTabs.find((route) => route.tabId === data.activeTabId);

  const activeChannelCount = [1, 2, 3].filter((id) =>
    bridgeTabs.some((route) => normalizeChannelId(route.channelId) === id),
  ).length;
  elements.engineState.textContent = bridgeTabs.length
    ? `${activeChannelCount} 个频道运行`
    : "未运行";
  elements.engineState.className = `pill ${bridgeTabs.length ? "running" : "idle"}`;
  elements.routeCount.textContent = String(selectedRoutes.length);
  elements.routeHeading.textContent = `${selectedChannelName}的标签页`;
  elements.stopAll.disabled = busy || bridgeTabs.length === 0;
  const hub = data.hub || { enabled: false, state: "disabled", error: "" };
  const hubReadyRoutes = bridgeTabs.filter((route) => route.hubState === "ready").length;
  const hubStateLabel = hub.enabled
    ? hub.state === "connected"
      ? bridgeTabs.length === 0
        ? "控制已连接 · 等待会议"
        : hubReadyRoutes === bridgeTabs.length
          ? `音频已就绪 · ${hubReadyRoutes}/${bridgeTabs.length}`
          : `控制已连接 · 音频 ${hubReadyRoutes}/${bridgeTabs.length}`
      : hub.state === "connecting"
        ? "控制连接中"
        : hub.state === "error" || hub.state === "disconnected"
          ? "需要 Hub"
          : "已启用"
    : "关闭";
  elements.hubState.textContent = hubStateLabel;
  elements.toggleHub.textContent = hub.enabled
    ? "关闭跨 Profile Hub"
    : "启用跨 Profile Hub";
  elements.toggleHub.disabled = busy;
  elements.toggleHub.className = hub.enabled ? "quiet" : "secondary";
  elements.hubPairingForm.hidden = !hub.pairingCode;
  if (hub.pairingCode !== displayedPairingCode) {
    displayedPairingCode = hub.pairingCode || "";
    elements.hubPairingCode.value = "";
  }
  elements.hubPairingCode.disabled = busy;
  elements.confirmHubPairing.disabled = busy;
  elements.bridgeSafety.hidden = ![1, 2, 3].some(
    (id) =>
      bridgeTabs.filter(
        (route) =>
          route.role === "meeting" && normalizeChannelId(route.channelId) === id,
      ).length >= 2,
  );
  const diagnosticState = data.diagnosticState || {};
  const diagnosticsEnabled = Boolean(diagnosticState.enabled);
  const remainingMinutes = diagnosticsEnabled
    ? Math.max(1, Math.ceil((Number(diagnosticState.enabledUntil) - Date.now()) / 60_000))
    : 0;
  elements.diagnosticState.textContent = diagnosticsEnabled
    ? `${remainingMinutes} 分钟`
    : "关闭";
  elements.diagnosticHint.textContent = diagnosticsEnabled
    ? `临时诊断已开启，内存中 ${diagnosticState.count || 0} 条；到期自动清除，不写入磁盘。`
    : "默认不记录。需要排查时可临时开启 10 分钟，记录只保存在内存中。";
  elements.toggleDiagnostics.textContent = diagnosticsEnabled
    ? "关闭并清除诊断"
    : "开启诊断 10 分钟";
  elements.toggleDiagnostics.disabled = busy;
  elements.exportLog.disabled = busy || !diagnosticsEnabled;
  elements.clearLocalData.disabled = busy;

  for (const button of document.querySelectorAll("[data-channel-id]")) {
    const id = normalizeChannelId(button.dataset.channelId);
    const count = bridgeTabs.filter(
      (route) => normalizeChannelId(route.channelId) === id,
    ).length;
    button.classList.toggle("active", id === selectedChannelId);
    button.disabled = busy;
    button.setAttribute("aria-selected", String(id === selectedChannelId));
    document.querySelector(`#channelTabName${id}`).textContent = channelName(data, id);
    document.querySelector(`#channelTabCount${id}`).textContent = `${count} 路`;
  }
  elements.channelRouteSummary.textContent = `${selectedRoutes.length} 路 / 共 ${bridgeTabs.length}`;
  const speakingChannels = Boolean(data.selfMuted)
    ? []
    : [1, 2, 3].filter((id) => !Boolean(data.channelConfig?.micMuted?.[id]));
  const listeningChannels = [1, 2, 3].filter(
    (id) => !Boolean(data.channelConfig?.monitorMuted?.[id]),
  );
  elements.channelCard.classList.toggle("is-muted", speakingChannels.length === 0);
  elements.channelVoiceState.textContent = speakingChannels.length
    ? `频道 ${speakingChannels.join("、")}：接收我的声音`
    : "所有频道不接收我的声音";
  elements.channelHint.textContent = listeningChannels.length
    ? `频道 ${listeningChannels.join("、")}：向我播放声音`
    : "所有频道不向我播放声音";
  elements.channelVoiceState.classList.toggle("is-on", speakingChannels.length > 0);
  elements.channelVoiceState.classList.toggle("is-off", speakingChannels.length === 0);
  elements.channelHint.classList.toggle("is-on", listeningChannels.length > 0);
  elements.channelHint.classList.toggle("is-off", listeningChannels.length === 0);
  for (const button of document.querySelectorAll("[data-channel-mic]")) {
    const id = normalizeChannelId(button.dataset.channelMic);
    const muted = Boolean(data.selfMuted) || Boolean(data.channelConfig?.micMuted?.[id]);
    button.classList.toggle("is-muted", muted);
    button.disabled = busy || Boolean(data.selfMuted);
    button.setAttribute("aria-label", muted ? `恢复${channelName(data, id)}麦克风` : `关闭${channelName(data, id)}麦克风`);
    button.title = muted ? `恢复${channelName(data, id)}麦克风` : `关闭${channelName(data, id)}麦克风`;
  }
  for (const button of document.querySelectorAll("[data-channel-monitor]")) {
    const id = normalizeChannelId(button.dataset.channelMonitor);
    const muted = Boolean(data.channelConfig?.monitorMuted?.[id]);
    button.classList.toggle("is-muted", muted);
    button.disabled = busy;
    button.setAttribute("aria-label", muted ? `恢复${channelName(data, id)}扬声器` : `关闭${channelName(data, id)}扬声器`);
    button.title = muted ? `恢复${channelName(data, id)}扬声器` : `关闭${channelName(data, id)}扬声器`;
  }
  const monitorMuted = listeningChannels.length === 0;
  elements.toggleAllMonitor.querySelector(".global-control-label").textContent =
    "总开关（向我播放声音）";
  elements.toggleAllMonitor.className = monitorMuted
    ? "monitor-off"
    : "monitor-on";
  elements.toggleAllMonitor.disabled = busy;

  const selfMuted = Boolean(data.selfMuted);
  elements.toggleSelfMute.querySelector(".global-control-label").textContent =
    "总开关（接收我的声音）";
  elements.toggleSelfMute.className = selfMuted ? "talk-stop" : "talk-start";
  elements.toggleSelfMute.disabled = busy;

  const preset = data.preset;
  const presetPlan = data.presetPlan;
  elements.savePreset.disabled = busy || bridgeTabs.length === 0;
  elements.savePreset.textContent = preset ? "更新为当前组合" : "保存当前组合";
  elements.clearPreset.hidden = !preset;
  elements.clearPreset.disabled = busy;
  elements.presetNext.hidden = true;
  elements.presetNext.disabled = busy;
  elements.presetNext.dataset.tabId = "";
  elements.presetNext.dataset.channelId = "";
  if (!preset || !presetPlan) {
    elements.presetProgress.textContent = "未保存";
    elements.presetHint.textContent = "配置三个频道后保存，下次按提示快速恢复。";
  } else {
    elements.presetProgress.textContent = `${presetPlan.joined}/${presetPlan.total}`;
    const names = preset.entries
      .map((entry) => `[${channelName(data, entry.channelId)}] ${entry.label}${entry.count > 1 ? `×${entry.count}` : ""}`)
      .join("、");
    if (presetPlan.complete) {
      elements.presetHint.textContent = `组合已完整：${names}`;
    } else if (presetPlan.nextTabId) {
      const isCurrent = presetPlan.nextTabId === data.activeTabId;
      elements.presetHint.textContent = isCurrent
        ? "当前页面属于常用组合，可以立即加入。"
        : `下一步：${presetPlan.nextTitle}`;
      elements.presetNext.hidden = false;
      elements.presetNext.dataset.tabId = String(presetPlan.nextTabId);
      elements.presetNext.dataset.channelId = String(presetPlan.nextChannelId);
      elements.presetNext.textContent = isCurrent
        ? "加入当前匹配页"
        : "切换到下一页";
    } else {
      elements.presetHint.textContent = `还缺 ${presetPlan.unavailable} 个页面，请先打开对应网站：${names}`;
    }
  }

  if (!active) {
    const current = data.currentTab;
    elements.currentTitle.textContent = current?.title || "当前站点暂不支持";
    elements.currentHint.textContent = current?.customizable
      ? "可以授权并自定义该网站在混音中的用途。"
      : "Chrome 内部页面和扩展商店无法注入或捕获。";
    elements.addCurrent.hidden = true;
    elements.addCurrent.disabled = true;
    elements.customActions.hidden = !current?.customizable;
  } else if (activeRoute) {
    elements.addCurrent.hidden = false;
    elements.customActions.hidden = !active.custom;
    elements.currentTitle.textContent = active.title;
    const currentRouteChannel = normalizeChannelId(activeRoute.channelId);
    const moving = currentRouteChannel !== selectedChannelId;
    elements.currentHint.textContent = moving
      ? `当前属于${channelName(data, currentRouteChannel)}；移动频道不会刷新页面。`
      : active.role === "source"
        ? `已作为${selectedChannelName}的只发送音频源。`
        : active.role === "receiver"
          ? `已作为${selectedChannelName}的识别接收端，可向 Chrome 语音识别直接送入音轨。`
          : `已加入${selectedChannelName}；点击可重新连接。`;
    elements.addCurrent.textContent = moving
      ? `移入${selectedChannelName}`
      : active.role === "source"
        ? "音频源已加入"
        : "重新连接并刷新";
    elements.addCurrent.disabled = busy;
  } else {
    elements.addCurrent.hidden = false;
    elements.customActions.hidden = !active.custom;
    elements.currentTitle.textContent = active.title;
    elements.currentHint.textContent =
      active.role === "source"
        ? `只捕获该标签页声音并送入${selectedChannelName}；不会刷新。`
        : active.role === "receiver"
          ? `接收${selectedChannelName}的音频，并直接送入兼容的 Chrome 语音识别。`
        : `将加入${selectedChannelName}；页面会刷新一次。`;
    elements.addCurrent.textContent =
      active.role === "source"
        ? "加入为音频源"
        : active.role === "receiver"
          ? `加入${selectedChannelName}`
          : `加入${selectedChannelName}并刷新`;
    elements.addCurrent.disabled = busy;
  }

  elements.routeList.replaceChildren();
  elements.routeList.className = selectedRoutes.length ? "list" : "list empty";
  if (!selectedRoutes.length) {
    elements.routeList.textContent = "当前频道尚未加入标签页";
  } else {
    for (const route of selectedRoutes) {
      elements.routeList.append(makeRouteRow(route, data));
    }
  }

  const joinedIds = new Set(bridgeTabs.map((route) => route.tabId));
  const otherTabs = data.eligibleTabs.filter(
    (tab) => tab.id !== data.activeTabId && !joinedIds.has(tab.id),
  );
  const messengerCallTabs = data.eligibleTabs.filter((tab) => {
    const url = new URL(tab.url);
    return /(^|\.)facebook\.com$/i.test(url.hostname) &&
      /\/groupcall\//i.test(url.pathname);
  });
  elements.shortcutCard.hidden = messengerCallTabs.length === 0;
  elements.shortcutHint.textContent = data.captureShortcut
    ? `将加入${selectedChannelName}：聚焦呼叫窗口后按 ${data.captureShortcut}`
    : "Chrome 尚未给扩展分配快捷键，请先设置。";
  elements.eligibleList.replaceChildren();
  elements.eligibleList.className = otherTabs.length ? "list" : "list empty";
  if (!otherTabs.length) {
    elements.eligibleList.textContent = "没有其他支持的标签页";
  } else {
    for (const tab of otherTabs) {
      const host = new URL(tab.url).hostname;
      const isMessengerCall = /(^|\.)facebook\.com$/i.test(host) &&
        /\/groupcall\//i.test(new URL(tab.url).pathname);
      elements.eligibleList.append(
        makeRow(
          tab.title,
          isMessengerCall
            ? `Messenger 呼叫窗口 · ${data.captureShortcut || "快捷键未设置"}`
            : host,
          isMessengerCall
            ? data.captureShortcut
              ? "授权加入"
              : "设置按键"
            : "切换",
          () => isMessengerCall ? addTabById(tab.id) : activateTab(tab.id),
        ),
      );
    }
  }
}

async function refresh() {
  try {
    const data = await callBackground("GET_POPUP_DATA");
    render(data);
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function withBusy(action) {
  if (busy) return;
  busy = true;
  if (popupData) render(popupData);
  try {
    await action();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    busy = false;
    await refresh();
  }
}

async function removeRoute(tabId) {
  await withBusy(async () => {
    showMessage("正在移除音频路由…");
    await callBackground("REMOVE_TAB", { tabId });
    showMessage("已移除。");
  });
}

async function moveRoute(tabId, channelId) {
  await withBusy(async () => {
    await callBackground("MOVE_TAB_CHANNEL", { tabId, channelId });
    showMessage(`已移动到${channelName(popupData, channelId)}，无需刷新页面。`);
  });
}

async function activateTab(tabId) {
  try {
    await callBackground("ACTIVATE_TAB", { tabId });
    window.close();
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function addTabById(tabId) {
  await withBusy(async () => {
    showMessage("正在聚焦 Messenger 呼叫窗口…");
    const result = await callBackground("ADD_TAB_BY_ID", { tabId });
    if (result.needsShortcut) {
      showMessage("Chrome 没有分配加入快捷键，请点击“设置快捷键”。", true);
      return;
    }
    if (result.needsCaptureAuthorization) {
      showMessage(`已聚焦呼叫窗口；请按 ${result.shortcut} 授权并直接加入。`);
    }
    window.close();
  });
}

for (const button of document.querySelectorAll("[data-channel-id]")) {
  button.addEventListener("click", () =>
    withBusy(async () => {
      const channelId = normalizeChannelId(button.dataset.channelId);
      await callBackground("SELECT_CHANNEL", { channelId });
    }),
  );
  button.addEventListener("dblclick", (event) => {
    event.preventDefault();
    const channelId = normalizeChannelId(button.dataset.channelId);
    const current = channelName(popupData, channelId);
    const nextName = window.prompt("频道名称（最多 18 个字符）", current);
    if (nextName === null || nextName.trim() === current) return;
    withBusy(async () => {
      await callBackground("RENAME_CHANNEL", { channelId, name: nextName });
      showMessage("频道名称已保存。");
    });
  });
}

for (const button of document.querySelectorAll("[data-channel-mic]")) {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    return withBusy(async () => {
      const channelId = normalizeChannelId(button.dataset.channelMic);
      const muted = !Boolean(popupData?.channelConfig?.micMuted?.[channelId]);
      await callBackground("SET_CHANNEL_MIC_MUTED", { channelId, muted });
      showMessage(muted ? `${channelName(popupData, channelId)}已关闭麦克风。` : `${channelName(popupData, channelId)}已恢复麦克风。`);
    });
  });
}

for (const button of document.querySelectorAll("[data-channel-monitor]")) {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    return withBusy(async () => {
      const channelId = normalizeChannelId(button.dataset.channelMonitor);
      const muted = !Boolean(popupData?.channelConfig?.monitorMuted?.[channelId]);
      await callBackground("SET_CHANNEL_MONITOR_MUTED", { channelId, muted });
      showMessage(muted ? `${channelName(popupData, channelId)}已关闭扬声器。` : `${channelName(popupData, channelId)}已恢复扬声器。`);
    });
  });
}

elements.toggleAllMonitor.addEventListener("click", () =>
  withBusy(async () => {
    const muted = !Boolean(popupData?.channelConfig?.monitorAllMuted);
    await callBackground("SET_ALL_MONITOR_MUTED", { muted });
    showMessage(
      muted
        ? "已暂停全部会议声音；远端桥接不受影响。"
        : "正在收听全部频道的会议声音。",
    );
  }),
);

elements.toggleSelfMute.addEventListener("click", () =>
  withBusy(async () => {
    const nextMuted = !Boolean(popupData?.selfMuted);
    showMessage(nextMuted ? "正在暂停本人声音…" : "正在恢复本人声音…");
    await callBackground("SET_SELF_MUTED", { muted: nextMuted });
    showMessage(
      nextMuted
        ? "本人已静音；其他会议和媒体仍继续转发。"
        : "本人声音已恢复。",
    );
  }),
);

elements.savePreset.addEventListener("click", () =>
  withBusy(async () => {
    await callBackground("SAVE_CURRENT_PRESET");
    showMessage("当前组合已保存。下次插件会引导你依次加入。");
  }),
);

elements.clearPreset.addEventListener("click", () =>
  withBusy(async () => {
    await callBackground("CLEAR_BRIDGE_PRESET");
    showMessage("常用组合已清除。");
  }),
);

elements.presetNext.addEventListener("click", () =>
  withBusy(async () => {
    const tabId = Number(elements.presetNext.dataset.tabId);
    const channelId = normalizeChannelId(
      elements.presetNext.dataset.channelId,
    );
    if (!Number.isInteger(tabId)) throw new Error("没有可继续加入的页面。");
    await callBackground("SELECT_CHANNEL", { channelId });
    if (tabId === popupData?.activeTabId) {
      showMessage("正在加入当前组合页面…");
      await callBackground("ADD_CURRENT_TAB", { channelId });
    } else {
      await callBackground("ACTIVATE_TAB", { tabId });
    }
    window.close();
  }),
);

elements.addCurrent.addEventListener("click", () =>
  withBusy(async () => {
    const active = popupData?.currentTab;
    showMessage(
      active?.role === "source"
        ? `正在捕获网页声音并送入${channelName(popupData, popupData?.channelConfig?.selected)}…`
        : active?.role === "receiver"
          ? "正在建立网页语音识别输入…"
        : "正在捕获、建立 N-1 混音并刷新页面…",
    );
    await callBackground("ADD_CURRENT_TAB", {
      channelId: normalizeChannelId(popupData?.channelConfig?.selected),
    });
    window.close();
  }),
);

for (const button of document.querySelectorAll("[data-custom-role]")) {
  button.addEventListener("click", () =>
    withBusy(async () => {
      const current = popupData?.currentTab;
      const role = button.dataset.customRole;
      if (!current?.customizable || !current.origin) {
        throw new Error("当前页面不能设置为自定义音频网站。");
      }
      const granted = await chrome.permissions.request({
        origins: [current.permissionPattern || `${current.origin}/*`],
      });
      if (!granted) throw new Error("用户未授权访问该网站。");
      showMessage("正在保存网站类型并建立音频路由…");
      await callBackground("SET_CUSTOM_SITE_ROLE", {
        origin: current.origin,
        role,
      });
      await callBackground("ADD_CURRENT_TAB", {
        channelId: normalizeChannelId(popupData?.channelConfig?.selected),
      });
      window.close();
    }),
  );
}

elements.stopAll.addEventListener("click", () =>
  withBusy(async () => {
    showMessage("正在停止全部桥接…");
    await callBackground("STOP_ALL");
    showMessage("全部桥接已停止。");
  }),
);

elements.toggleHub.addEventListener("click", () =>
  withBusy(async () => {
    const enabled = !Boolean(popupData?.hub?.enabled);
    const result = await callBackground("SET_HUB_ENABLED", { enabled });
    if (enabled && result.state !== "connecting" && result.state !== "connected") {
      throw new Error(result.error || "无法连接 Meet Bridge Hub。");
    }
    showMessage(enabled ? "Hub 控制已连接，正在为频道中的会议建立音频会话…" : "跨 Profile Hub 已关闭；单 Profile 桥接保持不变。");
  }),
);

elements.confirmHubPairing.addEventListener("click", () =>
  withBusy(async () => {
    const confirmationCode = elements.hubPairingCode.value.replace(/\D/g, "");
    if (!/^\d{6}$/.test(confirmationCode)) {
      throw new Error("请输入 Hub 中显示的六码确认码。");
    }
    if (confirmationCode !== popupData?.hub?.pairingCode) {
      throw new Error("确认码与 Hub 显示的代码不一致。");
    }
    await callBackground("CONFIRM_HUB_PAIRING", { confirmationCode });
    showMessage("配对完成，正在为频道中的会议建立音频会话…");
  }),
);

elements.hubPairingCode.addEventListener("input", () => {
  elements.hubPairingCode.value = elements.hubPairingCode.value.replace(/\D/g, "").slice(0, 6);
});

elements.micSetup.addEventListener("click", async () => {
  try {
    await callBackground("OPEN_MIC_SETUP");
    window.close();
  } catch (error) {
    showMessage(error.message, true);
  }
});

elements.shortcutSettings.addEventListener("click", async () => {
  try {
    await callBackground("OPEN_SHORTCUT_SETTINGS");
    window.close();
  } catch (error) {
    showMessage(error.message, true);
  }
});

elements.exportLog.addEventListener("click", async () => {
  try {
    const { entries = [] } = await callBackground("GET_DIAGNOSTIC_LOG");
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `meet-bridge-diagnostic-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    showMessage(`已下载 ${entries.length} 条诊断记录。`);
  } catch (error) {
    showMessage(error.message, true);
  }
});

elements.exportSettings.addEventListener("click", async () => {
  try {
    const payload = await callBackground("EXPORT_SETTINGS");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "meet-bridge-settings.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    showMessage("已导出设置；不包含标签页、网址、账号或音频。");
  } catch (error) {
    showMessage(error.message, true);
  }
});

elements.importSettings.addEventListener("click", () => elements.settingsFile.click());
elements.settingsFile.addEventListener("change", async () => {
  const file = elements.settingsFile.files?.[0];
  elements.settingsFile.value = "";
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    await callBackground("IMPORT_SETTINGS", { payload });
    showMessage("设置已导入；请手动重新加入需要桥接的标签页。");
    await refresh();
  } catch (error) {
    showMessage(error.message || "导入失败。", true);
  }
});

elements.toggleDiagnostics.addEventListener("click", () =>
  withBusy(async () => {
    const enabled = !Boolean(popupData?.diagnosticState?.enabled);
    await callBackground("SET_DIAGNOSTICS", { enabled });
    showMessage(
      enabled
        ? "诊断已临时开启 10 分钟；不会保存网页内容或完整网址。"
        : "诊断已关闭，内存记录已经清除。",
    );
  }),
);

elements.clearLocalData.addEventListener("click", () => {
  const confirmed = confirm(
    "这会停止全部桥接，并清除麦克风选择、频道名称、常用组合、自定义网站权限和诊断记录。是否继续？",
  );
  if (!confirmed) return;
  return withBusy(async () => {
    await callBackground("CLEAR_ALL_LOCAL_DATA");
    showMessage("全部本地数据和自定义网站授权已经清除。");
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target === "popup" && message.type === "STATE_CHANGED") {
    refresh();
  }
});

refresh();
