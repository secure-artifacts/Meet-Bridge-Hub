# Meet Bridge N-1

The extension routes the N-1 mix as PCM over a local WebRTC data channel and
reconstructs it as a page-local Web Audio track. This avoids Chromium treating
the bridge microphone as a remote-audio echo reference on Jitsi and Messenger.

Messenger popup-window authorization uses Chrome's command callback tab
directly, shows its real assigned shortcut in
the popup, and reports command failures visibly instead of discarding them.

The extension-owned physical microphone is the primary dry
microphone for every meeting route. Jitsi and Messenger keep their native page
microphones for UI compatibility, but the silent page-to-offscreen microphone
transport is now only a fallback.

Activity-aware gain management includes a transparent final safety
limiter. Silent tabs no longer lower active speakers, gain changes are smoothed,
and suspended page audio queues are bounded to prevent latency and memory growth.

Per-origin custom website roles allow users, after one-time host approval, to
classify an HTTP(S) page as a bidirectional meeting, capture-only audio
source, or injection-only speech-recognition receiver. Persistent dynamic content
scripts preserve document-start microphone interception after reloads. Recognition
receivers get only the other captured tabs' digital audio, without the physical
microphone, so speech-to-text pages are not contaminated by room noise.

The popup includes a persistent operator-only talk switch and reusable bridge
presets. Muting the operator now lowers only the physical microphone branch;
captured meetings and media continue flowing through the unchanged N-1 matrix.
Saved presets count required tabs by origin and role and guide the user through
the remaining per-tab Chrome capture authorizations.

Three isolated audio channels are available. Each route belongs to exactly
one channel, and the N-1 matrix now connects only sources and meeting outputs
inside that channel. Routes can move between channels without recapture or page
reload. The operator microphone is still captured once, with one global mute
and three persistent per-channel talk switches. Channel names and preset channel
assignments are saved in extension storage.
Each channel also has an independent local-monitor switch: it silences that
channel only in the bridge operator's headphones while its remote bridge output
continues unchanged.

Recognition receivers support the Web Speech API. On Chrome
135+, calls to `SpeechRecognition.start()` or `webkitSpeechRecognition.start()`
from a receiver page are supplied with that receiver channel's live bridge
`MediaStreamTrack`. This lets compatible sites such as Google Translate consume
captured tab audio without acoustic headset crosstalk or a virtual sound card.

The page-side PCM renderer uses `AudioWorkletNode` instead of the deprecated
main-thread `ScriptProcessorNode`. It preserves the same 80 ms startup
buffer and latency trimming thresholds, buffers DataChannel packets while the
worklet module loads, and retains the proven ScriptProcessor implementation only
as an automatic compatibility fallback when AudioWorklet initialization fails.

Diagnostics are opt-in, memory-only, redacted, bounded, and
automatically expiring after ten minutes. It removes legacy persistent logs,
adds a complete local-data reset, releases closed diagnostic connection
references, and adds an allowlisted GitHub Actions release pipeline that
attests, verifies, and uploads the exact same ZIP asset.

可直接以“已解压的扩展程序”加载的 Manifest V3 原型。它捕获多个网页版会议标签页和媒体音频源，在一个 offscreen document 中生成独立的 N-1 mix-minus 音轨，再通过同机 `RTCPeerConnection` 把每一路送回相应会议页面并替代该页面取得的麦克风。

标签页分为三种角色：

- **会议收发端**：Meet、Teams、Jitsi、Facebook、Messenger、Instagram。它既是混音输入，也是独立 N-1 输出的接收方。
- **只发送音频源**：YouTube。它的声音只会进入所属频道的会议输出，不会为 YouTube 建立麦克风输出或刷新页面。
- **识别接收端**：Google 翻译等兼容 Chrome Web Speech 音轨输入的页面。只接收所属频道的数字音频，不采集物理麦克风。

## 隐私与安全

扩展不保存音频、不连接开发者服务器，也不包含统计、广告、遥测或远程代码。诊断默认关闭；手动开启后只在内存中保留十分钟，并排除完整网址、网页内容、会议房间、设备信息、WebRTC 凭据和调用堆栈。详见 [PRIVACY.md](PRIVACY.md)。

GitHub Release 必须由版本标签触发的 Actions 自动生成。最终 ZIP 只创建一次，随后对同一文件生成构件证明、执行验证并由 `github-actions[bot]` 上传，禁止人工替换资产。详见 [RELEASING.md](RELEASING.md)。

Teams 同时支持 `teams.microsoft.com`、新版 `teams.cloud.microsoft`（含子域名）及个人版 `teams.live.com`。

扩展提供独立的共享麦克风选择页，供 Google Meet、Teams 等共享麦克风模式使用。Jitsi 与 Messenger 保留网页原生麦克风和设备选择流程，再在最终发送阶段接入 N-1 混音。页面麦克风上行连接绑定于整个桥接会话，可承受网页多次请求、预览清理和设备切换。

Messenger 独立通话窗口可以通过扩展显示的实际快捷键取得当前窗口授权并加入。临时诊断模式可检查页面注入、信令、音轨状态和发送统计；它默认关闭，只保留经过脱敏的短期内存记录。

## 当前 Chrome 推荐用法与必要调整

`chrome.tabCapture.getMediaStreamId({ targetTabId })` 仍是当前 API。Chrome 116+ 推荐在用户调用扩展后，由 service worker 获取一次性 `streamId`，不指定 `consumerTabId`，然后立即在扩展自己的 offscreen document 中用 `getUserMedia` 消费。此时 stream ID 可跨扩展渲染进程使用，但只能消费一次，并会在数秒内过期。

Chrome 仍规定：`tabCapture` 只能在用户调用扩展后开始，`targetTabId` 必须是已获得类似 `activeTab` 临时授权的标签页。因此 popup **不能在一次点击中静默捕获任意多个后台标签页**。本项目采用可运行的替代交互：逐个切到会议标签页，打开扩展，点击“加入当前页并刷新”。已建立的捕获在切换标签页后继续运行。

另一个调整是注入方式：MAIN world 没有 `chrome.runtime` 等扩展 API，content script 也不应自行调用 `chrome.scripting.executeScript`。项目在 manifest 中于 `document_start` 静态注入两份脚本：

- `main-world.js` 在 MAIN world 覆写页面看到的 `getUserMedia` 并运行接收端 WebRTC。
- `content-bridge.js` 在 ISOLATED world 使用扩展消息 API，并通过 `window.postMessage` 与 MAIN world 交换信令。

## 文件结构

```text
Meet Bridge N-1/
├── manifest.json          # MV3 权限、站点范围、两层 document_start 注入
├── background.js          # service worker：用户动作、tabCapture、消息中转、清理
├── offscreen.html         # 唯一隐藏音频页面
├── offscreen.js           # 麦克风、标签页捕获、Web Audio N-1 矩阵、WebRTC 发送端
├── content-bridge.js      # ISOLATED world：页面与扩展之间的信令桥
├── main-world.js          # MAIN world：覆写 gUM、混音接收端、Jitsi 麦克风上行端
├── pcm-page-output-worklet.js # 页面端 PCM 实时渲染（AudioWorklet）
├── popup.html             # 操作面板结构
├── popup.css              # 操作面板样式
├── popup.js               # 加入、切换、移除、停止、状态刷新
├── mic.html               # 首次麦克风授权的可见页面
├── mic.js                 # 请求并保存扩展源的麦克风权限
└── README.md              # 架构、时序、限制与测试步骤
```

## 模块调用关系

### `manifest.json`

声明 `activeTab`、`tabCapture`、`offscreen`、`tabs`、`storage` 权限和受支持站点。两份 content script 都在 `document_start` 注入：ISOLATED world 负责可信扩展通信，MAIN world 负责改变会议网页实际调用到的 API。

### `background.js`

它是协调中枢，不持有音频对象。popup 请求加入当前页后，对共享麦克风模式先确认 offscreen 麦克风可用，再取得单次 `streamId`，立即交给 offscreen 消费，最后刷新会议页，确保会议代码从一开始拿到桥接音轨。Jitsi 的物理麦克风由页面按原约束打开。background 也中转 offscreen 与标签页之间的两组 SDP/ICE，并在标签页关闭时删除对应路由。

### `offscreen.html` / `offscreen.js`

全扩展只有这一份音频引擎。每个标签页的捕获流既重新接到 `AudioContext.destination`（否则 tabCapture 后本机听不到该标签页），又作为混音输入。对标签页 `i` 创建稳定的 `MediaStreamAudioDestinationNode`：

```text
Google/Teams output_i = 0.9 × shared_mic + gain(N) × Σ(tab_j), j ≠ i
Jitsi       output_i = 0.9 × page_AEC_mic + gain(N) × Σ(tab_j), j ≠ i
```

动态增删时只重建 Web Audio 连接，destination 的输出 track 不变。每个 destination track 通过独立的无 STUN/TURN 本地 `RTCPeerConnection` 发送。Jitsi 另有一条反向本地连接，把仍由 Chrome AEC/NS/AGC 处理的真实麦克风送入矩阵；YouTube 不经过这条语音处理路径。

### `content-bridge.js` / `main-world.js`

`content-bridge.js` 将扩展消息转换为页面 `postMessage`，并反向中转 answer/ICE。`main-world.js` 保存尽早取得的原生 API 引用，覆写 `navigator.mediaDevices.getUserMedia`：

- 未加入桥接，或请求不含音频：原样调用浏览器 API。
- Google Meet、Teams 等只请求音频：返回桥接音轨的 clone。
- Google Meet、Teams 等同时请求音频和视频：只向原生 API 请求摄像头，再添加桥接音轨。
- Jitsi、Messenger：按各自原本的约束打开真实麦克风与摄像头；扩展把该原生麦克风上行到 offscreen，并仅替换实际会议发送器的音频负载为最终混音轨。
- 多次调用：每次返回新的 track clone，单次会议调用停止 track 不会破坏后续请求。

Google Meet、Teams 的网页语音约束不会再作用于远端混音 track；共享物理麦克风仍由 offscreen 以 AEC/NS/AGC 全开的约束单独采集。Jitsi 则保留它自己请求真实麦克风时的原生约束，只让人物语音经过处理，媒体源绕过处理。

### `popup.html` / `popup.css` / `popup.js`

显示当前标签页、已建立路由及连接状态。受 `activeTab` 规则限制，其他会议页只能先切过去再加入。加入动作会刷新页面一次；停止全部会关闭捕获、麦克风、AudioContext、所有 peer connection 和 offscreen document。

### `mic.html` / `mic.js`

首次授权必须在可见扩展页面完成，否则隐藏 offscreen document 无法可靠展示权限提示。这里只短暂打开麦克风以保存权限，随即停止轨道；实际使用时 offscreen 重新打开一路共享麦克风。

## 消息传递时序

```text
用户/popup
  │  1. 授权麦克风（仅首次）
  ├──────────────> mic.html ── getUserMedia(audio) ──> Chrome 权限提示
  │
  │  2. 在当前会议页点击“加入当前页并刷新”
  └──────────────> background/service worker
                       │ ensure offscreen + ensure microphone
                       │ getMediaStreamId({targetTabId})
                       ▼
                    offscreen
                       │ 立即消费 streamId，创建 tab source
                       │ 重建 N-1 Web Audio 矩阵
                       ▼
                    background ── reload ──> meeting tab

meeting tab document_start
  main-world.js ── 覆写 getUserMedia
  content-bridge.js ── PAGE_READY ─────────> background
                                               │ TAB_READY
                                               ▼
                                            offscreen
                                               │ createOffer + ICE
                                               ▼
  main-world.js <── content-bridge <── background
       │ setRemoteDescription / createAnswer
       └── answer + ICE ──> content-bridge ──> background ──> offscreen

会议网页调用 getUserMedia({audio,...})
  └── main-world.js 返回 output_i 的 clone
```

YouTube 的时序更短：切到 YouTube → popup“加入为音频源” → background 取得并立即消费 stream ID → offscreen 把该 source 动态连接到每个会议 destination。YouTube 不刷新，也不参与 WebRTC 返回链路。

动态移除时：popup 或 `tabs.onRemoved` → background → offscreen；offscreen 关闭该 peer、停止捕获并从其他所有 output 中删除该 source。其余 destination track 保持不变，不需要会议重新取麦克风。

## 安装与测试

1. 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本目录。
3. Google Meet、Teams 等：打开扩展 popup，点击“选择麦克风”，在新页面授权、选择设备并点击“使用所选麦克风”。Jitsi 可直接使用其页面或 Chrome 右上角面板选择输入；不要再使用关闭 AEC/NS 的特殊房间链接。
4. 打开第一个会议标签页，最好在正式入会前点击扩展的“加入当前页并刷新”。
5. 对其余会议标签页逐一重复上一步。
6. 如需把 YouTube 送入会议，切到正在播放的 YouTube 页，点击“加入为音频源”；状态应显示“送入混音”。
7. 入会后在 popup 中确认会议路由变为“混音中”。使用耳机做第一轮测试。
8. 分别让同频道 A、B 的远端参与者讲话：A 的远端声音应进入 B，B 的远端声音应进入 A；播放同频道 YouTube 时，该频道所有会议应收到它，而其他频道不应收到。

## 已知边界

- 这是网页 API 注入方案，不保证所有会议站点的每个未来版本都兼容。站点若在扩展注入前缓存了原始 API，或用特殊原生模块管理设备，必须重新加载；项目的加入动作已自动刷新以规避常见时序问题。
- “N-1”消除的是本机数字路由自回送。远端参与者使用外放而把声音再次拾入其麦克风，或会议网页主动播放本地麦克风 sidetone，仍可能形成外部回路。
- 物理麦克风 AEC 是否能完整参考多个 Web Audio 播放源取决于当前 Chrome/操作系统音频管线。无需任何 Chrome flag，但外放环境无法获得数学保证；正式使用建议耳机。
- 不指定 STUN/TURN 的 peer connection 只用于同一浏览器实例的本地传输。企业策略若禁用 host ICE candidate，连接可能失败。
- `tabCapture` 仅处理 Chrome 标签页，不能捕获原生 Zoom、腾讯会议或桌面 Teams。
- 新增会议站点时，必须同时更新 `host_permissions` 和两处 `content_scripts.matches`；新增只发送媒体源只需扩展 background 的 URL 分类，不应注入 `getUserMedia` 覆写器。

## 调试

- popup 停在“已捕获”：刷新会议页一次。
- popup 显示“错误”：在 `chrome://extensions` 的本扩展详情中打开 service worker/offscreen 检查日志。
- 会议仍在用真实麦克风：先加入桥接再入会；退出会议、刷新页面、重新入会。
- Jitsi / Messenger 的 YouTube 不通：恢复普通房间 URL，不使用 Chrome flag；停止旧桥接、在 `chrome://extensions` 重新加载扩展、刷新会议页后再加入，并确认 YouTube 标签页显示“送入混音”。Messenger 呼叫会打开独立窗口，可先用 popup 聚焦目标窗口，再按扩展显示的快捷键授权并加入。
- 本机听不到某会议：确认该标签页未静音，系统输出设备正确。tabCapture 会接管原播放，本项目再经 Web Audio 恢复监听。
- 出现啸叫：先戴耳机；再确认会议客户端没有“麦克风监听/sidetone”，远端设备也没有把扬声器声音重新拾入。

## 官方参考

- Chrome tabCapture API: <https://developer.chrome.com/docs/extensions/reference/api/tabCapture>
- Chrome offscreen API: <https://developer.chrome.com/docs/extensions/reference/api/offscreen>
- Chrome content scripts / execution worlds: <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- Chrome scripting execution world: <https://developer.chrome.com/docs/extensions/reference/api/scripting>
