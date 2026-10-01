# Security Policy

## Supported versions

Security fixes target the current `main` branch and the latest published release once releases are available.

## Reporting a vulnerability

Please do **not** disclose security vulnerabilities through public issues or comments.

Use GitHub Private Vulnerability Reporting for `Xmemo/codex-pet-pomodoro` when available:

1. Open the repository's **Security** tab.
2. Open **Advisories** / **Report a vulnerability**.
3. Submit reproduction details, affected versions, and any relevant logs privately.

## Security boundaries

This project is designed to remain local-first. Contributions must not silently bypass macOS permissions, user approval prompts, sandbox restrictions, or modify `ChatGPT.app`, `Codex.app`, or official application bundles. Do not commit proprietary pet assets, credentials, tokens, private runtime data, or user-specific paths.

The companion uses visible-window metadata and geometry to locate supported Codex pet windows. It does not request Screen Recording, Screen & System Audio Recording, or Accessibility permissions, and does not capture window pixels or audio. In voice mode, pet positioning is estimated from the host window geometry and may drift if the host layout changes. Timer goals and session history remain local unless the user explicitly exports and shares them. Product images in the README are AI-generated/composited illustrations, not unaltered runtime captures.

Release archives after `v0.1.0` are expected to carry GitHub/Sigstore artifact attestations from `.github/workflows/release.yml`. The bootstrap verifies the repository, workflow, and exact tag before installation. Attestation proves artifact provenance from that workflow, not that the source is free of vulnerabilities; it relies on GitHub and repository maintainer/workflow security.
