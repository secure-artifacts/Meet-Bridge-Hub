# Changelog

## 0.0.2

- Keep Jitsi microphone mixing active across screen-share track changes.
- Keep Google Meet N-1 microphone routing active when screen sharing starts.
- Preserve the separation between bridge microphone audio and shared-screen audio.
- Add diagnostic-only track-role markers for screen-share compatibility testing.

## 0.0.1

Initial public release.

- Disable diagnostics by default.
- Keep opt-in diagnostics only in memory for ten minutes.
- Redact URLs, titles, room names, text, device data, credentials, SDP/ICE,
  constraints, and call stacks from diagnostics.
- Delete legacy persistent diagnostic logs automatically.
- Add a one-click local-data and optional-site-permission reset.
- Release closed page PeerConnection references from the diagnostic registry.
- Add allowlisted, reproducible extension packaging.
- Add tag-triggered SLSA build provenance, pre-upload attestation verification,
  and bot-only GitHub Release upload.
- Move page-side PCM rendering to AudioWorklet with a compatibility fallback.
- Feed receiver-channel audio directly to compatible Web Speech recognition.
- Add three isolated channels, per-channel talk/monitor controls, names, and
  channel-aware presets.
