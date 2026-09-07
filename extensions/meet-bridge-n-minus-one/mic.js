const authorizeButton = document.querySelector("#authorize");
const applyButton = document.querySelector("#apply");
const deviceSelect = document.querySelector("#deviceSelect");
const status = document.querySelector("#status");

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

async function callBackground(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type,
    ...payload,
  });
  if (response?.ok === false) {
    throw new Error(response.error || "操作失败");
  }
  return response;
}

async function getStoredDeviceId() {
  const response = await callBackground("GET_MICROPHONE_DEVICE");
  return response.deviceId || "";
}

async function loadDevices() {
  const [devices, selectedDeviceId] = await Promise.all([
    navigator.mediaDevices.enumerateDevices(),
    getStoredDeviceId(),
  ]);
  const microphones = devices.filter((device) => device.kind === "audioinput");

  deviceSelect.replaceChildren();
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "系统默认麦克风";
  deviceSelect.append(defaultOption);

  microphones.forEach((device, index) => {
    if (!device.deviceId || device.deviceId === "default") return;
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `麦克风 ${index + 1}`;
    deviceSelect.append(option);
  });

  const storedOptionExists = [...deviceSelect.options].some(
    (option) => option.value === selectedDeviceId,
  );
  deviceSelect.value = storedOptionExists ? selectedDeviceId : "";
  deviceSelect.disabled = false;
  applyButton.disabled = false;
  return microphones.length;
}

async function requestPermissionAndLoad() {
  authorizeButton.disabled = true;
  setStatus("正在请求麦克风权限…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    stream.getTracks().forEach((track) => track.stop());
    const count = await loadDevices();
    setStatus(`已读取 ${count} 个麦克风。请选择后点击应用。`, "ok");
  } catch (error) {
    setStatus(`麦克风授权失败：${error.message}`, "error");
  } finally {
    authorizeButton.disabled = false;
  }
}

async function applySelectedDevice() {
  applyButton.disabled = true;
  deviceSelect.disabled = true;
  const deviceId = deviceSelect.value;
  const label = deviceSelect.selectedOptions[0]?.textContent || "系统默认麦克风";
  setStatus(`正在切换到：${label}…`);

  let testStream = null;
  try {
    testStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
    testStream.getTracks().forEach((track) => track.stop());
    testStream = null;

    const result = await callBackground("SET_MICROPHONE_DEVICE", { deviceId });
    const activeLabel = result.label || label;
    setStatus(
      result.deferred
        ? `已保存：${activeLabel}。加入会议时生效。`
        : `切换成功：${activeLabel}。当前混音已热更新。`,
      "ok",
    );
  } catch (error) {
    testStream?.getTracks().forEach((track) => track.stop());
    setStatus(`切换失败：${error.message}`, "error");
  } finally {
    applyButton.disabled = false;
    deviceSelect.disabled = false;
  }
}

authorizeButton.addEventListener("click", requestPermissionAndLoad);
applyButton.addEventListener("click", applySelectedDevice);
navigator.mediaDevices.addEventListener("devicechange", () => {
  loadDevices().catch(() => {});
});

(async () => {
  try {
    const permission = await navigator.permissions.query({ name: "microphone" });
    if (permission.state === "granted") {
      const count = await loadDevices();
      setStatus(`已读取 ${count} 个麦克风。`, "ok");
    } else if (permission.state === "denied") {
      setStatus("麦克风已被拒绝，请在 Chrome 权限设置中重新允许。", "error");
    } else {
      setStatus("请先点击“授权并刷新设备列表”。");
    }
  } catch {
    setStatus("请点击“授权并刷新设备列表”。");
  }
})();
