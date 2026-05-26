# Changelog

All notable changes to Forge AI are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-05-26

### Added
- Terminal-first multi-agent workflow (`Architect -> Coder -> Reviewer`) via `/multi`.
- CI-friendly batch workflow via `/oneshot`.
- Local semantic search (TF-IDF RAG) with `/reindex` support.
- Persistent project memory and checkpoint/rollback under `~/.forge`.
- Smart commit and git context tooling.
- Production quality gate via `/ship`.

### Changed
- Full project identity rebrand to **Forge AI**.
- CLI command standardized as `forge`.
- NPM package name standardized as `forge-ai`.
- Distribution artifact standardized as `dist/forge.js`.
- Config/runtime storage namespace standardized as `~/.forge`.
- Documentation and in-product copy aligned to Forge AI branding.

### Notes
- Version remains `1.0.0` under the new branding.
- This release focuses on branding consistency and publish readiness, without changing core architecture.
