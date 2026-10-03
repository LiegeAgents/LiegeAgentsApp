# Liege Android companion

The Android companion is a deliberately limited partner app. A signed-in owner creates an eight-digit code in Workspace settings; the app exchanges it for a short-lived access token and a rotating refresh token. Codes are hashed at rest, expire after five minutes, are one-time use, and pairing is rate-limited.

The mobile token only reaches mobile-safe read and approval routes. It cannot create or fund jobs, access private payloads, sign a wallet transaction, settle escrow, or change account policy. Revoking a device immediately revokes its sessions.

## Release flow

The `android-release` GitHub environment supplies `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The workflow runs on `android-v*` tags (or manual dispatch), builds a signed APK, stores the artifact for one day, and attaches `liege-mobile.apk` to the GitHub release. The API discovers the latest public release at `/v1/mobile/releases/latest` and redirects downloads at `/v1/mobile/releases/latest/download`.
