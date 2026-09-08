const routes = new Map();

let audioContext = null;
let audioWorkletReady = null;
let microphoneStream = null;
let microphoneSource = null;
let microphoneState = "unknown";
let microphoneDeviceId = "";
let activeMicrophoneDeviceId = "";
let microphoneLabel = "";
let selfMuted = false;
let diagnosticsEnabled = false;
const channelMicMuted = { 1: false, 2: false, 3: false };
const channelMonitorMuted = { 1: false, 2: false, 3: false };

function normalizeChannelId(value) {
  const channelId = Number(value);
  return [1, 2, 3].includes(channelId) ? channelId : 1;
}

function isRouteMicrophoneMuted(route) {
  return selfMuted || Boolean(channelMicMuted[normalizeChannelId(route.channelId)]);
}

function isOutputRole(role) {
  return role === "meeting" || role === "receiver";
}

function serializeDescription(description) {
  return description
    ? { type: description.type, sdp: description.sdp }
    : null;
}

function serializeCandidate(candidate) {
  return candidate
    ? {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      }
    : null;
}

async function notifyPopup() {
  await chrome.runtime
    .sendMessage({ target: "popup", type: "STATE_CHANGED" })
    .catch(() => {});
}

async function sendToBackground(type, payload = {}) {
  if (type === "PAGE_DIAGNOSTIC" && !diagnosticsEnabled) {
    return { ok: true, skipped: true };
  }
  return chrome.runtime.sendMessage({
    target: "background",
    type,
    ...payload,
  });
}

async function ensureAudioContext() {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext({
      latencyHint: "interactive",
      // Hub PCM is exactly 48 kHz / 480 frames every 10 ms. Pin the producer
      // context to that clock so a Windows device default cannot drift the
      // Hub frame cadence.
      sampleRate: 48_000,
    });
    audioWorkletReady = Promise.all([
      audioContext.audioWorklet.addModule(chrome.runtime.getURL("pcm-output-worklet.js")),
      audioContext.audioWorklet.addModule(chrome.runtime.getURL("pcm-page-output-worklet.js")),
    ]);
  }
  await audioWorkletReady;
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  return audioContext;
}

function createPcmGeneratorOutput(context, mixBus, tabId) {
  if (
    typeof MediaStreamTrackGenerator !== "function" ||
    typeof AudioData !== "function"
  ) {
    return null;
  }

  // Chromium's audio implementation is still the proprietary insertable-
  // streams API. Its official WebRTC sample uses the string constructor. The
  // object form is accepted by some builds but has produced a live track that
  // encodes only silence, so prefer the exact official audio signature.
  let generator;
  let generatorConstructor = "string";
  try {
    generator = new MediaStreamTrackGenerator("audio");
  } catch {
    generatorConstructor = "object";
    generator = new MediaStreamTrackGenerator({ kind: "audio" });
  }
  const outputTrack = generator.track || generator;
  const writer = generator.writable.getWriter();
  const worklet = new AudioWorkletNode(context, "meet-bridge-pcm-output", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
  });
  const renderSink = context.createGain();
  renderSink.gain.value = 0;
  mixBus.connect(worklet);
  worklet.connect(renderSink);
  renderSink.connect(context.destination);

  let closed = false;
  let writeQueue = Promise.resolve();
  let lastLevelAt = 0;
  let framesWritten = 0;
  const pcmConsumers = new Set();
  let probeTrack = null;
  let probeReader = null;
  let probeRunning = false;

  // Read a clone of the generated track back before WebRTC. This is a
  // diagnostic tap, not part of the signal path. It separates "generator
  // emitted silence" from "RTCRtpSender encoded silence" conclusively.
  if (diagnosticsEnabled && typeof MediaStreamTrackProcessor === "function") {
    try {
      probeTrack = outputTrack.clone();
      const processor = new MediaStreamTrackProcessor(probeTrack);
      probeReader = processor.readable.getReader();
      probeRunning = true;
      void (async () => {
        let lastProbeAt = 0;
        while (probeRunning) {
          const { value: frame, done } = await probeReader.read();
          if (done || !frame) break;
          try {
            const samples = new Float32Array(frame.numberOfFrames);
            frame.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
            const now = Date.now();
            if (now - lastProbeAt >= 1_000) {
              lastProbeAt = now;
              let sum = 0;
              for (const sample of samples) sum += sample * sample;
              sendToBackground("PAGE_DIAGNOSTIC", {
                entry: {
                  at: new Date().toISOString(),
                  event: "pcm-generator-readback-level",
                  detail: {
                    tabId,
                    rms: Number(Math.sqrt(sum / samples.length).toFixed(5)),
                    timestamp: frame.timestamp,
                    numberOfFrames: frame.numberOfFrames,
                    generatorConstructor,
                    trackKind: outputTrack.kind,
                  },
                },
              }).catch(() => {});
            }
          } finally {
            frame.close();
          }
        }
      })().catch((error) => {
        if (!probeRunning) return;
        sendToBackground("PAGE_DIAGNOSTIC", {
          entry: {
            at: new Date().toISOString(),
            event: "pcm-generator-readback-failed",
            detail: { tabId, message: error?.message || String(error) },
          },
        }).catch(() => {});
      });
    } catch (error) {
      sendToBackground("PAGE_DIAGNOSTIC", {
        entry: {
          at: new Date().toISOString(),
          event: "pcm-generator-readback-failed",
          detail: { tabId, message: error?.message || String(error) },
        },
      }).catch(() => {});
    }
  }
  worklet.port.onmessage = ({ data }) => {
    if (closed || !data?.samples) return;
    const samples = new Float32Array(data.samples);
    for (const consumer of pcmConsumers) consumer(samples, data.sampleRate, data.timestamp);
    const now = Date.now();
    if (diagnosticsEnabled && now - lastLevelAt >= 1_000) {
      lastLevelAt = now;
      let sum = 0;
      let peak = 0;
      let nearClipSamples = 0;
      for (const sample of samples) {
        sum += sample * sample;
        const absolute = Math.abs(sample);
        peak = Math.max(peak, absolute);
        if (absolute >= 0.999) nearClipSamples += 1;
      }
      sendToBackground("PAGE_DIAGNOSTIC", {
        entry: {
          at: new Date().toISOString(),
          event: "pcm-generator-level",
          detail: {
            tabId,
            rms: Number(Math.sqrt(sum / samples.length).toFixed(5)),
            peak: Number(peak.toFixed(5)),
            nearClipSamples,
            sampleRate: data.sampleRate,
            timestamp: data.timestamp,
            framesWritten,
            desiredSize: writer.desiredSize ?? null,
            generatorConstructor,
            trackKind: outputTrack.kind,
            trackEnabled: outputTrack.enabled,
            trackMuted: outputTrack.muted,
            trackState: outputTrack.readyState,
          },
        },
      }).catch(() => {});
    }
    writeQueue = writeQueue
      .catch(() => {})
      .then(async () => {
        if (closed) return;
        const frame = new AudioData({
          format: "f32-planar",
          sampleRate: data.sampleRate,
          numberOfFrames: samples.length,
          numberOfChannels: 1,
          timestamp: data.timestamp,
          data: samples,
        });
        await writer.write(frame);
        framesWritten += samples.length;
      })
      .catch((error) => {
        if (closed) return;
        closed = true;
        worklet.port.onmessage = null;
        sendToBackground("PAGE_DIAGNOSTIC", {
          entry: {
            at: new Date().toISOString(),
            event: "pcm-generator-write-failed",
            detail: { tabId, message: error?.message || String(error) },
          },
        }).catch(() => {});
      });
  };

  return {
    outputTrack,
    outputStream: new MediaStream([outputTrack]),
    setPcmConsumer: (consumer) => {
      pcmConsumers.clear();
      if (typeof consumer === "function") pcmConsumers.add(consumer);
    },
    addPcmConsumer: (consumer) => {
      if (typeof consumer !== "function") return () => {};
      pcmConsumers.add(consumer);
      return () => pcmConsumers.delete(consumer);
    },
    close: () => {
      if (closed) return;
      closed = true;
      pcmConsumers.clear();
      worklet.port.onmessage = null;
      worklet.disconnect();
      renderSink.disconnect();
      probeRunning = false;
      probeReader?.cancel().catch(() => {});
      probeTrack?.stop();
      writer.close().catch(() => {});
    },
  };
}

function createHubPcmTap(context, source) {
  const worklet = new AudioWorkletNode(context, "meet-bridge-pcm-output", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    // Hub's authenticated PCM protocol is fixed at 10 ms / 480 samples.
    // The normal output worklet keeps its 1280-sample default for local
    // WebRTC; this dedicated tap must emit protocol-sized upload frames.
    processorOptions: { chunkFrames: 480 },
  });
  const silentSink = context.createGain();
  silentSink.gain.value = 0;
  const consumers = new Set();
  source.connect(worklet);
  worklet.connect(silentSink);
  silentSink.connect(context.destination);
  worklet.port.onmessage = ({ data }) => {
    if (!data?.samples) return;
    const samples = new Float32Array(data.samples);
    for (const consumer of consumers) consumer(samples, data.sampleRate, data.timestamp);
  };
  return {
    addPcmConsumer(consumer) {
      if (typeof consumer !== "function") return () => {};
      consumers.add(consumer);
      return () => consumers.delete(consumer);
    },
    close() {
      consumers.clear();
      worklet.port.onmessage = null;
      worklet.disconnect();
      silentSink.disconnect();
    },
  };
}

async function ensureMicrophone(
  requestedDeviceId = microphoneDeviceId,
  forceReopen = false,
) {
  const nextDeviceId =
    typeof requestedDeviceId === "string" ? requestedDeviceId : "";

  if (
    microphoneStream?.active &&
    microphoneSource &&
    nextDeviceId === activeMicrophoneDeviceId &&
    !forceReopen
  ) {
    microphoneState = "ready";
    return {
      ok: true,
      deviceId: activeMicrophoneDeviceId,
      label: microphoneLabel,
    };
  }

  try {
    const context = await ensureAudioContext();
    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(nextDeviceId
          ? { deviceId: { exact: nextDeviceId } }
          : {}),
      },
      video: false,
    });
    const nextSource = context.createMediaStreamSource(nextStream);
    const nextTrack = nextStream.getAudioTracks()[0];

    microphoneSource?.disconnect();
    microphoneStream?.getTracks().forEach((track) => track.stop());
    microphoneStream = nextStream;
    microphoneSource = nextSource;
    microphoneDeviceId = nextDeviceId;
    activeMicrophoneDeviceId = nextDeviceId;
    microphoneLabel = nextTrack?.label || "系统默认麦克风";
    microphoneState = "ready";
    rebuildMixMatrix();
    await notifyPopup();
    return {
      ok: true,
      deviceId: activeMicrophoneDeviceId,
      label: microphoneLabel,
    };
  } catch (error) {
    const oldStreamStillActive = microphoneStream?.active && microphoneSource;
    microphoneState = oldStreamStillActive
      ? "ready"
      : error?.name === "NotAllowedError"
        ? "denied"
        : "error";
    await notifyPopup();
    return {
      ok: false,
      error: error?.message || String(error),
      code: error?.name || "MICROPHONE_ERROR",
    };
  }
}

function clearRouteInputs(route) {
  for (const connection of route.inputs.values()) {
    try {
      connection.source.disconnect(connection.gain);
    } catch {
      // It may already be disconnected during teardown.
    }
    try {
      connection.source.disconnect(connection.analyser);
    } catch {
      // It may already be disconnected during teardown.
    }
    connection.gain.disconnect();
    connection.analyser?.disconnect();
  }
  route.inputs.clear();
}

function connectInput(route, key, source, gainValue) {
  const gain = audioContext.createGain();
  const analyser = audioContext.createAnalyser();
  gain.gain.value =
    isRouteMicrophoneMuted(route) &&
    (key === "microphone" || key === "page-microphone")
      ? 0
      : gainValue;
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.1;
  source.connect(gain);
  // Measure activity before route gain so normalization cannot make a quiet
  // source repeatedly enter and leave the active set. Keep analysis off the
  // real output path because inline analysers have caused silent RTP in some
  // Chromium offscreen-document builds.
  source.connect(analyser);
  gain.connect(route.mixBus);
  route.inputs.set(key, { source, gain, analyser });
}

async function setSelfMuted(muted) {
  selfMuted = Boolean(muted);
  const now = audioContext?.currentTime || 0;
  for (const route of routes.values()) {
    for (const key of ["microphone", "page-microphone"]) {
      const connection = route.inputs.get(key);
      if (!connection) continue;
      connection.gain.gain.cancelScheduledValues(now);
      connection.gain.gain.setTargetAtTime(
        isRouteMicrophoneMuted(route) ? 0 : 0.9,
        now,
        0.015,
      );
    }
  }
  await sendToBackground("PAGE_DIAGNOSTIC", {
    entry: {
      at: new Date().toISOString(),
      event: "self-microphone-changed",
      detail: { muted: selfMuted },
    },
  }).catch(() => {});
  await notifyPopup();
  return { ok: true, muted: selfMuted };
}

async function setChannelMicMuted(channelId, muted, notify = true) {
  const id = normalizeChannelId(channelId);
  channelMicMuted[id] = Boolean(muted);
  const now = audioContext?.currentTime || 0;
  for (const route of routes.values()) {
    if (normalizeChannelId(route.channelId) !== id) continue;
    for (const key of ["microphone", "page-microphone"]) {
      const connection = route.inputs.get(key);
      if (!connection) continue;
      connection.gain.gain.cancelScheduledValues(now);
      connection.gain.gain.setTargetAtTime(
        isRouteMicrophoneMuted(route) ? 0 : 0.9,
        now,
        0.015,
      );
    }
  }
  if (notify) await notifyPopup();
  return { ok: true, channelId: id, muted: channelMicMuted[id] };
}

async function setChannelMicStates(states = {}) {
  for (const id of [1, 2, 3]) {
    await setChannelMicMuted(id, Boolean(states[id]), false);
  }
  await notifyPopup();
  return { ok: true, states: { ...channelMicMuted } };
}

async function setChannelMonitorMuted(channelId, muted, notify = true) {
  const id = normalizeChannelId(channelId);
  channelMonitorMuted[id] = Boolean(muted);
  for (const route of routes.values()) {
    if (normalizeChannelId(route.channelId) !== id || !route.monitorGain) continue;
    const now = audioContext?.currentTime || 0;
    route.monitorGain.gain.cancelScheduledValues(now);
    route.monitorGain.gain.setTargetAtTime(
      channelMonitorMuted[id] ? 0 : 1,
      now,
      0.015,
    );
  }
  if (notify) await notifyPopup();
  return { ok: true, channelId: id, muted: channelMonitorMuted[id] };
}

async function setChannelMonitorStates(states = {}) {
  for (const id of [1, 2, 3]) {
    await setChannelMonitorMuted(id, Boolean(states[id]), false);
  }
  await notifyPopup();
  return { ok: true, states: { ...channelMonitorMuted } };
}

async function setDiagnosticsEnabled(enabled) {
  diagnosticsEnabled = Boolean(enabled);
  for (const route of routes.values()) {
    if (!isOutputRole(route.role)) continue;
    await sendToBackground("CONFIG_TO_TAB", {
      tabId: route.tabId,
      active: true,
      micMode: route.micMode,
      role: route.role,
      diagnosticsEnabled,
    }).catch(() => {});
  }
  await notifyPopup();
  return { ok: true, enabled: diagnosticsEnabled };
}

function audioLevel(analyser) {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  let peak = 0;
  for (const sample of samples) {
    sum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
}

function startRouteMeter(route) {
  if (!isOutputRole(route.role)) return;
  let lastDiagnosticAt = 0;
  route.meterTimer = setInterval(() => {
    const now = Date.now();
    const levels = new Map(
      [...route.inputs.entries()].map(([key, connection]) => [
        key,
        audioLevel(connection.analyser),
      ]),
    );
    for (const [key, level] of levels) {
      if (key.startsWith("tab:") && level.rms >= 0.003) {
        route.activeRemoteUntil.set(key, now + 1_200);
      }
    }
    for (const key of [...route.activeRemoteUntil.keys()]) {
      if (!route.inputs.has(key) || route.activeRemoteUntil.get(key) < now) {
        route.activeRemoteUntil.delete(key);
      }
    }
    const activeRemoteCount = route.activeRemoteUntil.size;
    const targetRemoteGain = Math.min(
      0.85,
      0.9 / Math.sqrt(Math.max(1, activeRemoteCount)),
    );
    if (
      route.targetRemoteGain === null ||
      Math.abs(route.targetRemoteGain - targetRemoteGain) >= 0.005
    ) {
      route.targetRemoteGain = targetRemoteGain;
      for (const [key, connection] of route.inputs) {
        if (!key.startsWith("tab:")) continue;
        connection.gain.gain.cancelScheduledValues(audioContext.currentTime);
        connection.gain.gain.setTargetAtTime(
          targetRemoteGain,
          audioContext.currentTime,
          0.12,
        );
      }
    }
    if (!diagnosticsEnabled || now - lastDiagnosticAt < 1_000) return;
    lastDiagnosticAt = now;
    const inputs = Object.fromEntries(
      [...levels.entries()].map(([key, level]) => [
        key,
        Number(level.rms.toFixed(5)),
      ]),
    );
    const mixLevel = audioLevel(route.mixAnalyser);
    sendToBackground("PAGE_DIAGNOSTIC", {
      entry: {
        at: new Date().toISOString(),
        event: "offscreen-mix-level",
        detail: {
          tabId: route.tabId,
          mixRms: Number(mixLevel.rms.toFixed(5)),
          mixPeak: Number(mixLevel.peak.toFixed(5)),
          limiterReduction: route.limiter?.reduction ?? 0,
          selfMuted,
          channelId: normalizeChannelId(route.channelId),
          channelMicMuted: Boolean(
            channelMicMuted[normalizeChannelId(route.channelId)],
          ),
          channelMonitorMuted: Boolean(
            channelMonitorMuted[normalizeChannelId(route.channelId)],
          ),
          activeRemoteCount,
          targetRemoteGain: Number(targetRemoteGain.toFixed(4)),
          inputs,
        },
      },
    }).catch(() => {});
  }, 200);
}

function rebuildMixMatrix() {
  if (!audioContext) return;

  for (const route of routes.values()) {
    if (!isOutputRole(route.role)) continue;
    clearRouteInputs(route);
    route.activeRemoteUntil.clear();
    route.targetRemoteGain = null;

    // Use one extension-owned dry physical microphone for every meeting.
    // Jitsi/Messenger still open their native microphone so their UI and
    // lifecycle remain intact, but their page-to-offscreen WebRTC microphone
    // can be encoded as silence. Keep that page source only as a fallback.
    if (route.role === "meeting" && !route.hubSession) {
      if (microphoneSource) {
        connectInput(route, "microphone", microphoneSource, 0.9);
      } else if (route.pageMicSource && route.micMode === "page") {
        connectInput(route, "page-microphone", route.pageMicSource, 0.9);
      }
    }

    for (const sourceRoute of routes.values()) {
      if (
        sourceRoute.tabId === route.tabId ||
        !sourceRoute.source ||
        normalizeChannelId(sourceRoute.channelId) !==
          normalizeChannelId(route.channelId)
      ) {
        continue;
      }
      connectInput(
        route,
        `tab:${sourceRoute.tabId}`,
        sourceRoute.source,
        0.85,
      );
    }
  }
}

function closePeer(route) {
  if (route.outputStatsTimer) clearInterval(route.outputStatsTimer);
  route.outputStatsTimer = null;
  route.generatedOutput?.setPcmConsumer(null);
  if (route.outputDataChannel) {
    route.outputDataChannel.onopen = null;
    route.outputDataChannel.onclose = null;
    route.outputDataChannel.close();
    route.outputDataChannel = null;
  }
  if (!route.pc) return;
  route.pc.onicecandidate = null;
  route.pc.onconnectionstatechange = null;
  route.pc.close();
  route.pc = null;
  route.pendingCandidates = [];
}

function clearPageMicSource(route) {
  route.pageMicSource?.disconnect();
  route.pageMicStream?.getTracks().forEach((track) => track.stop());
  route.pageMicSource = null;
  route.pageMicStream = null;
}

function closePageMicPeer(route, preserveCandidates = false) {
  if (route.pageMicPc) {
    route.pageMicPc.onicecandidate = null;
    route.pageMicPc.ontrack = null;
    route.pageMicPc.onconnectionstatechange = null;
    route.pageMicPc.close();
  }
  route.pageMicPc = null;
  if (!preserveCandidates) route.pageMicPendingCandidates = [];
  clearPageMicSource(route);
}

async function updateRouteStatus(route, status, error = "") {
  route.status = status;
  route.error = error;
  await notifyPopup();
}

async function startPeer(route) {
  if (!isOutputRole(route.role) || !route.outputTrack || !route.outputStream) {
    return;
  }
  closePeer(route);
  route.pendingCandidates = [];

  const pc = new RTCPeerConnection({ iceServers: [] });
  route.pc = pc;
  pc.addTrack(route.outputTrack, route.outputStream);

  // Do not use the received WebRTC audio track as the meeting microphone.
  // Chrome identifies it as "remote audio" and wide echo cancellation can
  // suppress it completely when it is sent back upstream. Carry the exact
  // N-1 PCM over a local data channel and rebuild a page-local WebAudio track.
  const pcmChannel = pc.createDataChannel("meet-bridge-pcm", {
    ordered: false,
    maxRetransmits: 0,
  });
  pcmChannel.binaryType = "arraybuffer";
  route.outputDataChannel = pcmChannel;
  let pcmSequence = 0;
  let lastPcmDiagnosticAt = 0;
  route.generatedOutput?.setPcmConsumer((samples, sampleRate) => {
    if (route.pc !== pc || pcmChannel.readyState !== "open") return;
    // Bound latency rather than accumulating stale audio if the page stalls.
    if (pcmChannel.bufferedAmount > 256 * 1024) return;
    const packet = new ArrayBuffer(8 + samples.length * 2);
    const header = new DataView(packet, 0, 8);
    header.setUint32(0, sampleRate, true);
    header.setUint32(4, pcmSequence++, true);
    const pcm = new Int16Array(packet, 8);
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = Math.round(sample * 32767);
      sum += sample * sample;
    }
    pcmChannel.send(packet);
    const now = Date.now();
    if (now - lastPcmDiagnosticAt >= 1_000) {
      lastPcmDiagnosticAt = now;
      sendToBackground("PAGE_DIAGNOSTIC", {
        entry: {
          at: new Date().toISOString(),
          event: "pcm-datachannel-sent",
          detail: {
            tabId: route.tabId,
            sequence: pcmSequence - 1,
            frames: samples.length,
            sampleRate,
            rms: Number(Math.sqrt(sum / samples.length).toFixed(5)),
            bufferedAmount: pcmChannel.bufferedAmount,
          },
        },
      }).catch(() => {});
    }
  });
  pcmChannel.onopen = () => {
    sendToBackground("PAGE_DIAGNOSTIC", {
      entry: {
        at: new Date().toISOString(),
        event: "pcm-datachannel-open",
        detail: { tabId: route.tabId },
      },
    }).catch(() => {});
  };

  route.outputStatsTimer = setInterval(async () => {
    if (
      !diagnosticsEnabled ||
      route.pc !== pc ||
      pc.connectionState !== "connected"
    ) return;
    try {
      const report = await pc.getStats();
      report.forEach((stat) => {
        if (
          stat.type === "outbound-rtp" &&
          (stat.kind === "audio" || stat.mediaType === "audio")
        ) {
          sendToBackground("PAGE_DIAGNOSTIC", {
            entry: {
              at: new Date().toISOString(),
              event: "bridge-output-sender-stats",
              detail: {
                tabId: route.tabId,
                bytesSent: stat.bytesSent || 0,
                audioLevel: stat.audioLevel ?? null,
                totalAudioEnergy: stat.totalAudioEnergy ?? null,
                packetsSent: stat.packetsSent || 0,
              },
            },
          }).catch(() => {});
        }
      });
    } catch {
      // A diagnostic meter must never interrupt the bridge.
    }
  }, 2_000);

  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    sendToBackground("SIGNAL_TO_TAB", {
      tabId: route.tabId,
      signal: { candidate: serializeCandidate(candidate) },
    }).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (route.pc !== pc) return;
    const state = pc.connectionState;
    if (state === "connected") {
      updateRouteStatus(
        route,
        route.role === "meeting" &&
          !microphoneSource &&
          !route.pageMicSource
          ? "awaiting_microphone"
          : "mixing",
      );
    } else if (state === "failed") {
      updateRouteStatus(route, "error", "本地 WebRTC 连接失败");
    } else if (state === "disconnected") {
      updateRouteStatus(route, "disconnected");
    }
  };

  await sendToBackground("CONFIG_TO_TAB", {
    tabId: route.tabId,
    active: true,
    micMode: route.micMode,
    role: route.role,
    diagnosticsEnabled,
  });

  const offer = await pc.createOffer({ offerToReceiveAudio: false });
  await pc.setLocalDescription(offer);
  await updateRouteStatus(route, "connecting");

  await sendToBackground("SIGNAL_TO_TAB", {
    tabId: route.tabId,
    signal: { description: serializeDescription(pc.localDescription) },
  });
}

async function handlePageMicSignal(route, signal) {
  if (signal.description?.type === "offer") {
    await sendToBackground("PAGE_DIAGNOSTIC", {
      entry: { at: new Date().toISOString(), event: "offscreen-received-page-mic-offer", detail: { tabId: route.tabId } },
    });
    const earlyCandidates = route.pageMicPendingCandidates;
    closePageMicPeer(route, true);
    route.pageMicPendingCandidates = earlyCandidates;

    const pc = new RTCPeerConnection({ iceServers: [] });
    route.pageMicPc = pc;

    pc.onconnectionstatechange = () => {
      if (route.pageMicPc !== pc) return;
      if (pc.connectionState === "failed") {
        updateRouteStatus(
          route,
          "error",
          "Jitsi 麦克风上行连接失败，请重新加入该标签页",
        );
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || route.pageMicPc !== pc) return;
      sendToBackground("SIGNAL_TO_TAB", {
        tabId: route.tabId,
        signal: {
          channel: "page-mic",
          candidate: serializeCandidate(candidate),
        },
      }).catch(() => {});
    };

    pc.ontrack = async ({ track }) => {
      if (track.kind !== "audio" || route.pageMicPc !== pc) return;
      await sendToBackground("PAGE_DIAGNOSTIC", {
        entry: { at: new Date().toISOString(), event: "offscreen-received-page-mic-track", detail: { tabId: route.tabId, trackId: track.id } },
      });
      clearPageMicSource(route);
      const context = await ensureAudioContext();
      if (route.pageMicPc !== pc || !routes.has(route.tabId)) {
        track.stop();
        return;
      }
      route.pageMicStream = new MediaStream([track]);
      route.pageMicSource = context.createMediaStreamSource(
        route.pageMicStream,
      );
      track.addEventListener(
        "ended",
        () => {
          if (route.pageMicStream?.getTracks().includes(track)) {
            clearPageMicSource(route);
            rebuildMixMatrix();
            if (
              route.pc?.connectionState === "connected" &&
              !microphoneSource
            ) {
              updateRouteStatus(route, "awaiting_microphone");
            }
          }
        },
        { once: true },
      );
      rebuildMixMatrix();
      if (route.pc?.connectionState === "connected") {
        await updateRouteStatus(route, "mixing");
      }
    };

    await pc.setRemoteDescription(signal.description);
    for (const candidate of route.pageMicPendingCandidates.splice(0)) {
      await pc.addIceCandidate(candidate);
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendToBackground("SIGNAL_TO_TAB", {
      tabId: route.tabId,
      signal: {
        channel: "page-mic",
        description: serializeDescription(pc.localDescription),
      },
    });
  }

  if (signal.candidate) {
    if (route.pageMicPc?.remoteDescription) {
      await route.pageMicPc.addIceCandidate(signal.candidate);
    } else {
      route.pageMicPendingCandidates.push(signal.candidate);
    }
  }

  return { ok: true };
}

async function handleSignalFromTab(tabId, signal) {
  const route = routes.get(tabId);
  if (route?.micMode === "page" && signal?.channel === "page-mic") {
    return handlePageMicSignal(route, signal);
  }

  if (
    !isOutputRole(route?.role) ||
    !route.pc ||
    !signal ||
    typeof signal !== "object"
  ) {
    return { ok: false };
  }

  if (signal.description) {
    await route.pc.setRemoteDescription(signal.description);
    for (const candidate of route.pendingCandidates.splice(0)) {
      await route.pc.addIceCandidate(candidate);
    }
  }

  if (signal.candidate) {
    if (route.pc.remoteDescription) {
      await route.pc.addIceCandidate(signal.candidate);
    } else {
      route.pendingCandidates.push(signal.candidate);
    }
  }

  return { ok: true };
}

async function captureTab(tab) {
  if (routes.has(tab.tabId)) {
    return { ok: true, alreadyAdded: true };
  }

  const role = ["source", "receiver"].includes(tab.role)
    ? tab.role
    : "meeting";
  const hasOutput = isOutputRole(role);
  const channelId = normalizeChannelId(tab.channelId);
  const micMode =
    hasOutput && tab.micMode === "page"
      ? "page"
      : hasOutput
        ? "shared"
        : "none";
  if (role === "meeting") {
    const micResult = await ensureMicrophone();
    if (!micResult.ok) return micResult;
  }

  try {
    const context = await ensureAudioContext();
    let stream = null;
    let capturedTrack = null;
    let source = null;
    let monitorGain = null;
    if (role !== "receiver") {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: tab.streamId,
          },
        },
        video: false,
      });
      capturedTrack = stream.getAudioTracks()[0];
      if (!capturedTrack) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("该标签页没有可捕获的音频轨道。");
      }
      source = context.createMediaStreamSource(stream);
      monitorGain = context.createGain();
      monitorGain.gain.value = channelMonitorMuted[channelId] ? 0 : 1;
      source.connect(monitorGain);
      monitorGain.connect(context.destination);
    }

    const destination = hasOutput ? context.createMediaStreamDestination() : null;
    const mixBus = hasOutput ? context.createGain() : null;
    const limiter = hasOutput ? context.createDynamicsCompressor() : null;
    const mixAnalyser = hasOutput ? context.createAnalyser() : null;
    const mixKeepAlive = hasOutput ? context.createGain() : null;
    if (mixBus && limiter && mixAnalyser && mixKeepAlive && destination) {
      mixBus.gain.value = 1;
      // Transparent safety limiter: normal speech remains untouched, while
      // simultaneous speakers cannot hard-clip the PCM output.
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      // MediaStreamDestination alone is not always an active render sink in an
      // offscreen document. A muted hardware-destination branch keeps this
      // bus rendering without producing audible playback.
      mixKeepAlive.gain.value = 0;
      mixAnalyser.fftSize = 512;
      mixAnalyser.smoothingTimeConstant = 0.1;
      mixBus.connect(limiter);
      limiter.connect(destination);
      limiter.connect(mixAnalyser);
      limiter.connect(mixKeepAlive);
      mixKeepAlive.connect(context.destination);

      // Chromium may leave a newly-created MediaStreamAudioDestination track
      // permanently clocked as silence when it is attached to WebRTC before
      // its first rendered quantum. A short zero-valued source initializes
      // the destination without adding audible content.
      const destinationBootstrap = context.createConstantSource();
      destinationBootstrap.offset.value = 0;
      destinationBootstrap.connect(destination);
      destinationBootstrap.addEventListener(
        "ended",
        () => destinationBootstrap.disconnect(),
        { once: true },
      );
      destinationBootstrap.start();
      destinationBootstrap.stop(context.currentTime + 0.05);
    }
    let generatedOutput = null;
    let generatorError = "";
    if (hasOutput && mixBus) {
      try {
        generatedOutput = createPcmGeneratorOutput(context, limiter, tab.tabId);
      } catch (error) {
        generatorError = error?.message || String(error);
      }
    }
    const outputTrack =
      generatedOutput?.outputTrack ||
      destination?.stream.getAudioTracks()[0] ||
      null;
    const outputStream =
      generatedOutput?.outputStream || destination?.stream || null;

    const route = {
      tabId: tab.tabId,
      title: tab.title,
      url: tab.url,
      role,
      micMode,
      channelId,
      stream,
      source,
      monitorGain,
      destination,
      generatedOutput,
      hubTap: source ? createHubPcmTap(context, source) : null,
      mixBus,
      limiter,
      mixKeepAlive,
      mixAnalyser,
      activeRemoteUntil: new Map(),
      targetRemoteGain: null,
      outputTrack,
      outputStream,
      outputMode: generatedOutput ? "pcm-generator" : "media-destination",
      inputs: new Map(),
      pc: null,
      outputStatsTimer: null,
      outputDataChannel: null,
      pendingCandidates: [],
      pageMicPc: null,
      pageMicPendingCandidates: [],
      pageMicStream: null,
      pageMicSource: null,
      status: role === "source" ? "feeding" : "captured",
      error: "",
    };

    routes.set(tab.tabId, route);
    if (hasOutput) {
      await sendToBackground("PAGE_DIAGNOSTIC", {
        entry: {
          at: new Date().toISOString(),
          event: "bridge-output-mode",
          detail: {
            tabId: tab.tabId,
            channelId,
            mode: route.outputMode,
            generatorError,
            hasGenerator: typeof MediaStreamTrackGenerator === "function",
            hasAudioData: typeof AudioData === "function",
          },
        },
      }).catch(() => {});
    }
    startRouteMeter(route);
    capturedTrack?.addEventListener(
      "ended",
      () => removeTab(tab.tabId, "标签页捕获已结束"),
      { once: true },
    );

    rebuildMixMatrix();
    await notifyPopup();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      code: error?.name || "TAB_CAPTURE_ERROR",
    };
  }
}

async function removeTab(tabId, reason = "") {
  const route = routes.get(tabId);
  if (!route) return { ok: true };

  routes.delete(tabId);
  if (route.outputStatsTimer) clearInterval(route.outputStatsTimer);
  if (isOutputRole(route.role)) {
    await sendToBackground("CONFIG_TO_TAB", { tabId, active: false }).catch(
      () => {},
    );
  }

  closePeer(route);
  closePageMicPeer(route);
  clearInterval(route.meterTimer);
  clearRouteInputs(route);
  route.mixBus?.disconnect();
  route.limiter?.disconnect();
  route.mixKeepAlive?.disconnect();
  route.mixAnalyser?.disconnect();
  route.generatedOutput?.close();
  route.hubTap?.close();
  route.hubOutput?.close?.();
  route.source?.disconnect();
  route.monitorGain?.disconnect();
  route.stream?.getTracks().forEach((track) => track.stop());
  route.outputTrack?.stop();

  rebuildMixMatrix();
  await releaseEngineIfIdle();
  await notifyPopup();
  return { ok: true, reason };
}

async function setTabChannel(tabId, channelId) {
  const route = routes.get(Number(tabId));
  if (!route) return { ok: false, error: "该标签页尚未加入桥接。" };
  const nextChannelId = normalizeChannelId(channelId);
  if (route.channelId === nextChannelId) {
    return { ok: true, tabId: route.tabId, channelId: nextChannelId };
  }
  route.channelId = nextChannelId;
  if (route.hubSession) {
    route.hubOutput?.close?.();
    route.hubOutput = null;
    route.hubSession = null;
    await sendToBackground("HUB_CHANNEL_CHANGED", {
      tabId: route.tabId,
      channelId: nextChannelId,
    }).catch(() => {});
  }
  if (route.monitorGain) {
    const now = audioContext?.currentTime || 0;
    route.monitorGain.gain.cancelScheduledValues(now);
    route.monitorGain.gain.setTargetAtTime(
      channelMonitorMuted[nextChannelId] ? 0 : 1,
      now,
      0.015,
    );
  }
  rebuildMixMatrix();
  await sendToBackground("PAGE_DIAGNOSTIC", {
    entry: {
      at: new Date().toISOString(),
      event: "route-channel-changed",
      detail: { tabId: route.tabId, channelId: nextChannelId },
    },
  }).catch(() => {});
  await notifyPopup();
  return { ok: true, tabId: route.tabId, channelId: nextChannelId };
}

function setHubSession(tabId, endpointId, grant) {
  const route = routes.get(Number(tabId));
  if (!route || !grant || typeof endpointId !== "string") {
    return { ok: false, error: "Hub 路由尚未就绪。" };
  }
  route.hubOutput?.close?.();
  route.hubSession = { endpointId, grant };
  route.hubState = "connecting";
  route.hubError = "";
  route.hubOutput = connectHubAudio(route, grant, (error) => {
    if (route.hubSession?.endpointId !== endpointId) return;
    route.hubOutput = null;
    route.hubSession = null;
    route.hubState = "error";
    route.hubError = error?.message || "Hub 音频连接已断开。";
    rebuildMixMatrix();
    notifyPopup().catch(() => {});
    sendToBackground("HUB_AUDIO_DISCONNECTED", { tabId: route.tabId }).catch(() => {});
  });
  rebuildMixMatrix();
  return { ok: true };
}

function clearHubSession(tabId) {
  const route = routes.get(Number(tabId));
  if (!route) return { ok: true, missing: true };
  route.hubOutput?.close?.();
  route.hubOutput = null;
  route.hubSession = null;
  rebuildMixMatrix();
  return { ok: true };
}

function uuidBytes(value) {
  const hex = String(value || "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function connectHubAudio(route, grant, onDisconnected) {
  if (!route.hubTap || !grant?.endpoint?.port) return { close() {} };
  const profileBytes = uuidBytes(grant.profile_id);
  const endpointBytes = uuidBytes(grant.endpoint_id);
  if (!profileBytes || !endpointBytes) return { close() {} };
  const input = route.mixBus ? new AudioWorkletNode(audioContext, "meet-bridge-pcm-page-output", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] }) : null;
  const gain = input ? audioContext.createGain() : null;
  if (gain && input) {
    gain.gain.value = 0.85;
    input.connect(gain);
    gain.connect(route.mixBus);
    // Hub downlink must be audible to the organizer as well as sent into the
    // meeting's virtual microphone. monitorGain is channel-scoped and feeds
    // only the local hardware output; it never reaches hubTap or the Hub.
    if (route.monitorGain) input.connect(route.monitorGain);
  }
  let socket;
  try {
    socket = new WebSocket(`ws://${grant.endpoint.host}:${grant.endpoint.port}${grant.endpoint.path}`);
  } catch (error) {
    queueMicrotask(() => onDisconnected?.(error));
    return { close() { closed = true; input?.disconnect(); gain?.disconnect(); } };
  }
  socket.binaryType = "arraybuffer";
  let sequence = 0;
  let closed = false;
  socket.onopen = () => {
    route.hubState = "authenticating";
    notifyPopup().catch(() => {});
    socket.send(JSON.stringify({ session_id: grant.session_id, session_secret_b64: grant.session_secret_b64 }));
  };
  socket.onclose = () => {
    if (!closed) onDisconnected?.();
  };
  socket.onerror = () => { route.hubError = "无法连接 Hub 的本机音频端口。"; };
  socket.onmessage = ({ data }) => {
    if (typeof data === "string") {
      if (data.includes("AUDIO_READY")) {
        route.hubState = "ready";
        route.hubError = "";
        notifyPopup().catch(() => {});
      }
      return;
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength < 64) return;
    const view = new DataView(data);
    if (view.getUint8(0) !== 0x4d || !(view.getUint8(9) & 2)) return;
    const samples = new Float32Array(data.slice(64));
    const packet = new ArrayBuffer(8 + samples.length * 2);
    new DataView(packet).setUint32(0, 48_000, true);
    const pcm = new Int16Array(packet, 8);
    for (let index = 0; index < samples.length; index += 1) {
      pcm[index] = Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767);
    }
    input?.port.postMessage(packet, [packet]);
  };
  const removeConsumer = route.hubTap.addPcmConsumer((samples) => {
    if (closed || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 128 * 1024 || samples.length !== 480) return;
    const frame = new ArrayBuffer(64 + samples.length * 4);
    const view = new DataView(frame);
    view.setUint8(0, 0x4d); view.setUint8(1, 0x42); view.setUint8(2, 0x46); view.setUint8(3, 0x30);
    view.setUint16(4, 64, true); view.setUint16(6, 1, true); view.setUint8(8, grant.channel_id); view.setUint16(10, 480, true);
    new Uint8Array(frame, 12, 16).set(profileBytes); new Uint8Array(frame, 28, 16).set(endpointBytes);
    view.setBigUint64(44, BigInt(grant.epoch || 1), true); view.setBigUint64(52, BigInt(sequence++), true); view.setUint32(60, samples.length * 4, true);
    new Float32Array(frame, 64).set(samples); socket.send(frame);
  });
  return { close() { closed = true; removeConsumer(); input?.port.postMessage({ type: "close" }); socket.close(); input?.disconnect(); gain?.disconnect(); } };
}

async function stopChannel(channelId) {
  const id = normalizeChannelId(channelId);
  const tabIds = [...routes.values()]
    .filter((route) => normalizeChannelId(route.channelId) === id)
    .map((route) => route.tabId);
  for (const tabId of tabIds) await removeTab(tabId, `频道 ${id} 已停止`);
  return { ok: true, channelId: id, removed: tabIds.length };
}

async function releaseEngineIfIdle() {
  const hasMeetingRoute = [...routes.values()].some(
    (route) => route.role === "meeting",
  );

  if (!hasMeetingRoute) {
    microphoneSource?.disconnect();
    microphoneStream?.getTracks().forEach((track) => track.stop());
    microphoneSource = null;
    microphoneStream = null;
    activeMicrophoneDeviceId = "";
    microphoneLabel = "";
    microphoneState = "unknown";
  }

  // Source-only tabs still need the AudioContext for capture and local
  // playback, but they do not need to keep the physical microphone open.
  if (routes.size > 0) return;

  if (audioContext && audioContext.state !== "closed") {
    await audioContext.close();
  }
  audioContext = null;
}

async function stopAll() {
  for (const tabId of [...routes.keys()]) {
    await removeTab(tabId, "桥接已停止");
  }

  await releaseEngineIfIdle();
  await notifyPopup();
  return { ok: true };
}

function getState() {
  return {
    running: routes.size > 0,
    diagnosticsEnabled,
    selfMuted,
    channelMicMuted: { ...channelMicMuted },
    channelMonitorMuted: { ...channelMonitorMuted },
    microphone: microphoneState,
    microphoneDeviceId,
    microphoneLabel,
    tabs: [...routes.values()].map((route) => ({
      tabId: route.tabId,
      title: route.title,
      url: route.url,
      role: route.role,
      micMode: route.micMode,
      channelId: normalizeChannelId(route.channelId),
      status: route.status,
      error: route.error,
      hubState: route.hubState || "local",
      hubError: route.hubError || "",
    })),
  };
}

async function handleMessage(message) {
  switch (message.type) {
    case "ENSURE_MICROPHONE":
      return ensureMicrophone(message.deviceId);
    case "SET_MICROPHONE_DEVICE": {
      microphoneDeviceId =
        typeof message.deviceId === "string" ? message.deviceId : "";
      const hasMeetingRoute = [...routes.values()].some(
        (route) => route.role === "meeting",
      );
      if (!hasMeetingRoute && !microphoneStream?.active) {
        return { ok: true, deviceId: microphoneDeviceId, deferred: true };
      }
      return ensureMicrophone(microphoneDeviceId, true);
    }
    case "SET_SELF_MUTED":
      return setSelfMuted(message.muted);
    case "SET_CHANNEL_MIC_MUTED":
      return setChannelMicMuted(message.channelId, message.muted);
    case "SET_CHANNEL_MIC_STATES":
      return setChannelMicStates(message.states);
    case "SET_CHANNEL_MONITOR_MUTED":
      return setChannelMonitorMuted(message.channelId, message.muted);
    case "SET_CHANNEL_MONITOR_STATES":
      return setChannelMonitorStates(message.states);
    case "SET_DIAGNOSTICS":
      return setDiagnosticsEnabled(message.enabled);
    case "SET_TAB_CHANNEL":
      return setTabChannel(Number(message.tabId), message.channelId);
    case "SET_HUB_SESSION":
      return setHubSession(message.tabId, message.endpointId, message.grant);
    case "CLEAR_HUB_SESSION":
      return clearHubSession(message.tabId);
    case "STOP_CHANNEL":
      return stopChannel(message.channelId);
    case "ADD_TAB":
      return captureTab(message.tab);
    case "REMOVE_TAB":
      return removeTab(Number(message.tabId));
    case "STOP_ALL":
      return stopAll();
    case "GET_STATE":
      return getState();
    case "TAB_READY": {
      const route = routes.get(Number(message.tabId));
      if (!route || !isOutputRole(route.role)) {
        await sendToBackground("CONFIG_TO_TAB", {
          tabId: Number(message.tabId),
          active: false,
        });
        return { ok: true, active: false };
      }
      await startPeer(route);
      return { ok: true, active: true };
    }
    case "SIGNAL_FROM_TAB":
      return handleSignalFromTab(Number(message.tabId), message.signal);
    default:
      return { ok: false, error: `Unknown message: ${message.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return undefined;
  handleMessage(message)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({ ok: false, error: error?.message || String(error) }),
    );
  return true;
});
