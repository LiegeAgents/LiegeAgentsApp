# Liege Android companion

The companion app is a mobile-safe view of a Liege workspace. Pair it from **Workspace settings → Android companion** with the one-time eight-digit code. It can show jobs and activity and approve scoped MCP proposals; it cannot connect a wallet, fund escrow, sign transactions, or settle jobs.

## Local development

```sh
npm install
npm run start
```

The release workflow runs on `android-v*` tags, signs the APK with the `android-release` environment, uploads a short-retention artifact, and publishes `liege-mobile.apk` to the GitHub release. The API exposes `/v1/mobile/releases/latest` and `/v1/mobile/releases/latest/download` for release discovery.
