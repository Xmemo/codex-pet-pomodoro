# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Keep the tomato timer anchored to the pet when Codex uses a wide voice-host window, including after restarting Codex.

## [0.1.1] - 2026-09-26

### Added
- Document screen-capture permission, local processing, and data-sharing boundaries in English and Chinese.
- Add a Codex CLI prompt for approval-preserving installation.
- Generate GitHub artifact attestations for release archives and checksums.

### Security
- Require SHA256 and repository/workflow/tag-bound attestation verification before the bootstrap extracts or executes a release installer.
- Reject checksum-only `v0.1.0` installs in the attestation-enforcing bootstrap.

## [0.1.0] - 2026-09-24

### Added
- Prepare the first open-source release of **Pet Pomodoro**.
- Core Pomodoro timer daemon and CLI (`ultradian`).
- Translucent overlay tomato timer panel.
- Fullscreen pet rest companion window using AppKit and Core Animation.
- Built-in time presets (`25` minutes standard, `50` minutes flow, `90` minutes deep focus).
- Automated Installer (`./scripts/install.sh`) stage-and-swap system using LaunchAgents.
- Pet compatibility layer for normal/enhanced custom pet configurations.
- Comprehensive testing suites covering path overlays and mock rendering configurations.
