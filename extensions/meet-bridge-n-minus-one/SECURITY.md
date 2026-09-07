# Security Policy

## Supported version

Security fixes are applied to the latest release only. Use a current stable
Chromium-based browser; recognition receivers require Chrome 135 or later.

## Reporting a vulnerability

After the GitHub repository is created, report vulnerabilities through the
repository's **Security → Report a vulnerability** private advisory form. Do
not include meeting links, diagnostic exports, personal communications,
credentials, or captured audio in a public issue.

Include only the minimum reproduction information required. A sanitized
diagnostic export may be attached privately if diagnostics were explicitly
enabled and the reporter has reviewed the file first.

## Security design

- No remote code or developer-controlled backend.
- No audio recording or persistent audio storage.
- Diagnostics are opt-in, memory-only, redacted, bounded, and time-limited.
- Release ZIP files are built, attested, verified, and uploaded by GitHub
  Actions from a version tag.
- Release packaging uses an explicit runtime-file allowlist.
