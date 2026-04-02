# Fire TV HTTPS Remote Protocol

This document captures the Fire TV HTTPS remote protocol behavior discovered while building this app.

It exists because the protocol did not have usable public documentation for this project, and the implementation details here were established through manual probing, `curl` verification, backend experimentation, and app-level debugging.

## Status

- Reverse-engineered and validated against a real Fire TV device
- Suitable for backend/client implementation work
- Not an official Amazon specification
- Subject to change across Fire OS versions, device models, or firmware updates

## High-Level Summary

Fire TV exposes a native remote-control service over HTTPS on port `8080`.

Key facts:

- The service is HTTPS-only
- Plain HTTP to the same port fails with a connection reset
- Every request requires a static API key
- Authenticated remote usage also requires a per-device client token
- Pairing is performed over the same HTTPS service
- A DIAL-style wake/launch primitive is available over plain HTTP on port `8009`

This protocol is strong enough to replace ADB for normal remote-style operations such as navigation, home/back/menu/select, text entry, and app discovery.

ADB is still useful for:

- APK sideloading
- app launch fallback
- shell/debug/developer operations
- fallback when Fire TV HTTPS endpoints are incomplete or unstable

## Base Endpoints

### HTTPS remote service

```text
https://<firetv-ip>:8080
```

### DIAL wake/launch primitive

```text
http://<firetv-ip>:8009
```

## Transport Characteristics

### HTTPS is mandatory on port 8080

Observed behavior:

- `https://<ip>:8080/...` works
- `http://<ip>:8080/...` fails
- the failure mode for HTTP is typically a connection reset because the service expects TLS from the first byte

Implication:

- clients must use a real TLS/HTTPS stack for port `8080`
- attempting to probe the service with plain HTTP is not a valid reachability check

### TLS certificate behavior

The Fire TV service appears to use a self-signed or privately rooted certificate chain for local-device control.

Implication for Node/Electron backends:

- strict certificate verification will usually fail
- local-control clients should explicitly allow the device certificate chain in trusted local-network mode
- in Node, this commonly means an HTTPS agent with `rejectUnauthorized: false`

Security note:

- this is appropriate only for direct device control on a trusted local network
- it should not be treated like a general-purpose public HTTPS integration

### Keep-alive behavior

Observed behavior during implementation:

- normal authenticated remote requests benefit from keep-alive
- pairing POST calls were more reliable when sent on a fresh connection without keep-alive reuse

Practical rule used in this app:

- keep-alive is enabled for normal remote traffic
- pairing endpoints use a fresh TLS connection
- `ECONNRESET` on pairing requests is retried once with keep-alive disabled

## Required Headers

### Static API key

All Fire TV API requests require:

```http
x-api-key: 0987654321
```

If this header is missing, the service rejects the request.

### Client token

Authenticated requests also require:

```http
x-client-token: <token>
```

This token is device-specific and is returned during pairing.

### Content type

JSON requests should use:

```http
Content-Type: application/json; charset=utf-8
```

## Pairing Flow

Pairing is required before authenticated remote control can be used.

### Step 1: Show PIN on the Fire TV

Request:

```http
POST /v1/FireTV/pin/display
Host: <firetv-ip>:8080
Content-Type: application/json; charset=utf-8
x-api-key: 0987654321
```

Body:

```json
{"friendlyName":"Fire TV Remote Desktop"}
```

Observed response:

```json
{"description":"OK"}
```

Effect:

- the Fire TV displays a pairing PIN on screen

### Step 2: Verify PIN and receive client token

Request:

```http
POST /v1/FireTV/pin/verify
Host: <firetv-ip>:8080
Content-Type: application/json; charset=utf-8
x-api-key: 0987654321
```

Body:

```json
{"pin":"2570"}
```

Observed response shape:

```json
{"description":"iy-oEAw"}
```

Important detail:

- the client token is returned in `response.description`
- this token must be persisted per device

## Authentication Model

The protocol uses a two-part authentication model:

1. Static app/API identity via `x-api-key`
2. Device-specific user-approved session identity via `x-client-token`

### Practical meaning

- `x-api-key` alone is not enough for remote control
- `x-client-token` is required for authenticated use
- each Fire TV should be treated as having its own token
- tokens should be stored with the device record, not globally

## Recommended Device Persistence Shape

Minimum useful structure:

```json
{
  "id": "device-id",
  "name": "Dorm TV",
  "host": "10.194.20.230",
  "token": "iy-oEAw"
}
```

Recommended expanded structure:

```json
{
  "id": "device-id",
  "name": "Dorm TV",
  "host": "10.194.20.230",
  "token": "iy-oEAw",
  "transportPolicy": "hybrid",
  "lastKnownCapabilities": {
    "remoteControl": true,
    "textInput": true,
    "appList": true,
    "appLaunch": true,
    "sideload": true
  },
  "lastConnection": {
    "httpsReachable": true,
    "authenticated": true,
    "pairingRequired": false
  }
}
```

## Authenticated Request Shape

Normal authenticated remote actions should include:

```http
Content-Type: application/json; charset=utf-8
x-api-key: 0987654321
x-client-token: <persisted-device-token>
```

In code, the safest pattern is:

1. resolve the device by host or device id
2. verify the token exists
3. inject both required headers centrally
4. log whether a token is present before the request

## Confirmed Endpoint Behavior

The following behaviors were directly confirmed during implementation.

### Status probe

```http
GET /v1/FireTV/status
```

Observed behavior:

- with API key but without client token, the service returns unauthorized
- observed response:

```json
{"description":"Request unauthorized, missing client token"}
```

Important implementation detail:

- on tested devices this unauthorized response was returned as HTTP `403`
- clients should not assume `401` only
- both `401` and `403` should be treated as possible auth/token states

### Remote action

```http
POST /v1/FireTV?action=home
```

Observed:

- authenticated `home` works

Other tested action paths used the same pattern:

```text
/v1/FireTV?action=dpad_up
/v1/FireTV?action=dpad_down
/v1/FireTV?action=dpad_left
/v1/FireTV?action=dpad_right
```

### Pairing endpoints

Confirmed:

- `POST /v1/FireTV/pin/display`
- `POST /v1/FireTV/pin/verify`

### DIAL wake path

```http
POST /apps/FireTVRemote
Host: <firetv-ip>:8009
```

Observed:

- returns `201 Created`
- usable as a wake/launch primitive for the remote service

## Likely Useful Endpoints

These endpoints appeared promising and were incorporated into the app design:

```text
GET  /v1/FireTV/status
GET  /v1/FireTV/properties
GET  /v1/FireTV/appsV2
GET  /v1/FireTV/keyboard
POST /v1/FireTV/text
POST /v1/media?action=...
```

Notes:

- `appsV2` can be useful for native app discovery
- `keyboard` appears relevant for determining whether Fire TV text entry is currently active
- `text` is the natural HTTPS-first text input path
- not every endpoint is equally robust across apps or device states

## Important Failure Modes

### Missing client token

Observed response:

```json
{"description":"Request unauthorized, missing client token"}
```

Meaning:

- HTTPS is reachable
- API key is accepted
- request is not paired/authenticated

Likely causes:

- `x-client-token` header not sent
- resolved device has no persisted token
- host does not match the saved device entry that owns the token
- pairing succeeded in memory but token was never persisted

### Invalid or expired token

Observed generically as an auth failure condition.

Recommended handling:

- mark session as unauthenticated
- mark token invalid
- prompt user to re-pair

### Connection reset during pairing POST

Observed during backend development:

- `pin/display` could fail with `ECONNRESET` / `socket hang up` in Node while equivalent `curl` requests succeeded

Mitigation used by this app:

- disable keep-alive for pairing POSTs
- retry once with a fresh connection

### Fire TV backend Java exception

Observed response body:

```text
Error: java.lang.NullPointerException : Attempt to invoke virtual method 'java.lang.String z.j.h()' on a null object reference
```

Observed on:

- `POST /v1/FireTV?action=dpad_up`
- `POST /v1/FireTV?action=dpad_down`
- `POST /v1/FireTV?action=dpad_left`
- `POST /v1/FireTV?action=dpad_right`

Important behavioral nuance:

- the Fire TV appears capable of applying the action and still returning a `500` with this Java exception
- blindly falling back to ADB after this response can cause duplicate inputs

Client rule derived from this:

- treat this specific backend exception as a possible “request accepted but response broken” case
- do not immediately send the same remote action again via fallback transport

## App Discovery Limitations

### HTTPS app list is not always complete

Observed behavior:

- `appsV2` is useful but may omit some apps, especially third-party or sideloaded packages
- example missing package during testing:

```text
com.stremio.one
```

Practical implication:

- HTTPS app discovery should not be assumed complete
- the best launcher catalog may require merging:
  - Fire TV HTTPS app discovery
  - ADB package discovery

This app now treats app discovery as a hybrid source when possible.

## Host Normalization Lessons

One subtle issue discovered during implementation:

- the Fire TV HTTPS service lives on `https://<host>:8080`
- ADB commonly targets `<host>:5555`
- storing only `host:5555` and reusing it blindly for HTTPS can create confusing behavior

Recommended rule:

- persist a user-facing device host
- derive the ADB target separately
- strip ADB-specific port assumptions before building HTTPS/DIAL URLs

## Suggested Backend Helper Shape

A central helper should handle all Fire TV requests.

Recommended behavior:

```js
async function fireTvRequest(hostOrDevice, path, options)
```

Responsibilities:

- resolve device by host or explicit device object
- validate token when `authRequired` is true
- inject required headers
- use HTTPS
- support keep-alive
- optionally disable keep-alive for pairing
- log host, token presence, and endpoint path
- parse JSON when possible
- preserve raw body text for debugging

## Debug Logging That Proved Useful

The following fields were especially valuable while building this app:

- request id
- host
- path
- method
- whether auth was required
- whether a saved device matched
- whether an explicit device object was passed
- whether a token existed
- token preview, for example first four characters
- whether `x-client-token` was injected
- response status code
- short response preview

Example debug questions this answered:

- did we resolve the correct saved device?
- was the token missing from persistence or just from the header?
- did pairing succeed but fail to save?
- did the Fire TV return a real auth failure or a broken backend response?

## Practical Capability Matrix

Based on the observed protocol, a good production transport policy is:

### HTTPS-first

- remote directional controls
- home/back/menu/select
- text input
- app discovery
- pairing

### ADB fallback or ADB-only

- APK sideloading
- app launch fallback
- package scraping to fill gaps in HTTPS app discovery
- shell/debug actions

## Recommended UX Semantics

User-facing UX should describe state in capabilities, not transport jargon.

Good labels:

- `Remote ready`
- `Pairing required`
- `ADB available for sideloading`
- `HTTPS remote unavailable, using ADB fallback`

Avoid forcing the user to think in terms of “ADB mode” vs “HTTPS mode”.

## Known Unknowns

The following areas remain only partially characterized:

- the full supported `action=` vocabulary for `/v1/FireTV`
- whether there is a stable HTTPS-native app launch endpoint
- exact semantics of `/v1/FireTV/keyboard`
- exact media action set under `/v1/media?action=...`
- whether different Fire OS versions return `401` vs `403` consistently
- whether the Java NPE behavior is firmware-specific

## Implementation Guidance for Future Maintainers

If you are building against this protocol:

1. Treat `8080` as HTTPS-only.
2. Always send `x-api-key`.
3. Persist `x-client-token` per device after pairing.
4. Handle both `401` and `403` as possible token/auth states.
5. Use keep-alive for normal traffic, but be conservative around pairing POSTs.
6. Assume HTTPS app discovery may be incomplete.
7. Do not automatically duplicate a remote action through ADB if the Fire TV returned a Java-side `500` after receiving the request.
8. Keep device host normalization and token lookup centralized.

## Verified Example Requests

### Pairing start

```bash
curl -vk -X POST "https://<ip>:8080/v1/FireTV/pin/display" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "x-api-key: 0987654321" \
  -d '{"friendlyName":"Fire TV Remote Desktop"}'
```

### Pairing verify

```bash
curl -vk -X POST "https://<ip>:8080/v1/FireTV/pin/verify" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "x-api-key: 0987654321" \
  -d '{"pin":"2570"}'
```

### Authenticated home action

```bash
curl -vk -X POST "https://<ip>:8080/v1/FireTV?action=home" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "x-api-key: 0987654321" \
  -H "x-client-token: <token>" \
  -d '{}'
```

### DIAL wake

```bash
curl -v -X POST "http://<ip>:8009/apps/FireTVRemote"
```

## Ownership Note

This document is intentionally implementation-oriented.

It is meant to preserve the protocol knowledge discovered while building this app so that:

- future refactors do not regress the Fire TV transport
- other developers can understand the auth and transport quirks quickly
- the reverse-engineered details are not lost if the code changes later
