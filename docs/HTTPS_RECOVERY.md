# HTTPS recovery hardening

The September UI refresh also investigated HTTPS dropping into ADB fallback.
Live status probes succeeded after 1, 10, 30, and 60 seconds idle; the original
intermittent failure was not reproduced in that observation window.

Confirmed defects corrected:

- Interrupted HTTPS responses could leave the per-host queue unresolved.
- An unauthenticated session never rechecked HTTPS during subsequent commands.
- A rejected token could produce an unauthenticated session without a pairing prompt.
- Connection-reset retries previously replayed POSTs even on fresh connections.

Idle sockets now expire after four seconds. Read-only requests can retry once
on a fresh socket after a reset or timeout; POST reset retries are restricted
to reused sockets. Remote commands, text, and app discovery recheck an
unauthenticated saved-token session, at most once per 15 seconds during use.
Recovery does not initiate pairing or replay an earlier command.

Desktop connection diagnostics are written to `logs/connection.log` beneath
the app data directory. One previous file is retained, with rotation around
512 KB. Only selected connection metadata is saved; tokens, PINs, response
bodies, and typed text are excluded.

Verification: `node --test server/tests/*.test.js` (32 tests at implementation).
The nine new regressions cover interrupted responses, read retries, POST
retry boundaries, HTTPS recovery, recovery throttling, concurrent recovery, invalid-token state, and diagnostic redaction.
