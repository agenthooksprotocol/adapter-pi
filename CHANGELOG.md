# Changelog

## [0.4.0](https://github.com/agenthooksprotocol/adapter-pi/compare/v0.3.0...v0.4.0) (2026-11-19)


### ⚠ BREAKING CHANGES

* **oauth:** oauth.redirectPort is gone; a configured one is ignored with a warning. A Client ID Metadata Document should list http://127.0.0.1/callback (loopback redirects match without the port). Grants from earlier versions are not found, so users sign in again.

### Bug Fixes

* **oauth:** sign in per login on a loopback port, as MCP clients do ([#7](https://github.com/agenthooksprotocol/adapter-pi/issues/7)) ([eaef8e6](https://github.com/agenthooksprotocol/adapter-pi/commit/eaef8e64ccab217db9b16dbe4e3753d725d3563b))

## [0.3.0](https://github.com/agenthooksprotocol/adapter-pi/compare/v0.2.0...v0.3.0) (2026-11-18)


### Features

* OAuth browser sign-in per backend ([#4](https://github.com/agenthooksprotocol/adapter-pi/issues/4)) ([81c2abf](https://github.com/agenthooksprotocol/adapter-pi/commit/81c2abf5822654621075c833e9297c22d4c1fddb))


### Bug Fixes

* harden OAuth locks and private-address checks ([#6](https://github.com/agenthooksprotocol/adapter-pi/issues/6)) ([2f07c1e](https://github.com/agenthooksprotocol/adapter-pi/commit/2f07c1e592b51b99b1d3dc42d99069d7326fb137))

## [0.2.0](https://github.com/agenthooksprotocol/adapter-pi/compare/v0.1.0...v0.2.0) (2026-11-17)


### Features

* upgrade to agenthooksprotocol 0.12.0 ([#2](https://github.com/agenthooksprotocol/adapter-pi/issues/2)) ([6024901](https://github.com/agenthooksprotocol/adapter-pi/commit/60249012f4dbec612b893c6b92ccc0a507f692ab))
