# Privacy

Meet Bridge N-1 processes audio locally in the browser. The extension does not
operate a developer server, does not upload diagnostics, and does not include
analytics, advertising, tracking, telemetry, or remote code.

## Audio processing

Audio from tabs and the selected microphone is processed in one Chrome
offscreen document. A channel's N-1 result is delivered only to pages that the
user explicitly adds to that channel. The selected meeting or recognition
service may transmit or process the resulting audio under that service's own
privacy policy; Meet Bridge itself does not send audio to the developer.

Meet Bridge does not record or persist audio.

## Diagnostics

Diagnostics are disabled by default. The user may explicitly enable a ten-minute
diagnostic session from the popup. Diagnostic entries:

- exist only in extension memory;
- are automatically deleted when the session expires or is disabled;
- are limited to a 400-entry ring buffer;
- exclude complete URLs, page titles, room names, text, microphone labels,
  device identifiers, WebRTC SDP/ICE data, TURN credentials, constraints, and
  call stacks;
- leave the computer only when the user explicitly downloads and shares the
  JSON file.

Legacy persistent diagnostic data from earlier versions is removed when the
extension updates or its service worker starts.

## Locally saved preferences

Chrome local extension storage is used only for preferences the user expects to
persist: channel names and switches, the selected microphone device identifier,
custom website roles, and an optional saved routing preset. The preset contains
website origins and routing roles, not page paths, query strings, meeting room
names, or page contents.

The popup's **清除本地数据** action stops the bridge, deletes all locally saved
preferences and diagnostics, unregisters custom website scripts, and removes
their optional host permissions.

## Network access

The extension contains no `fetch`, XMLHttpRequest, WebSocket, analytics SDK, or
developer-controlled network endpoint. WebRTC connections created by the
extension use an empty ICE server list and are local browser loopbacks. Meeting
websites continue to use their own network connections independently.
