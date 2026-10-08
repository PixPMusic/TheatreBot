# Discord OAuth web controls

The web UI uses Discord's authorization-code login flow with `identify` and `guilds.members.read`. This identifies the controller and verifies roles in the active stream's guild; it does not replace the separate streaming account's `TOKEN`.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Register the exact redirect URL ending in `/auth/callback`. Use HTTPS for remote access; local development can use `http://localhost:8080/auth/callback`.
3. Set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_REDIRECT_URI` in the server's private environment. Do not commit the secret.
4. Configure guild role/user grants using `PERMISSIONS_FILE`, then set `SERVER_ENABLED=true`. Unconfigured guilds allow only owners and Administrators.
5. Start a stream, join its voice channel, open the configured public origin, and choose **Sign in with Discord**.

The enabled web server rejects incomplete OAuth configuration before Discord login. A login alone grants no browser access: current guild, voice channel, active session, and role/user permissions are checked on every HTTP and Socket.IO action. `control` covers keys/search/back/refresh/presets; arbitrary URLs require `navigate`. Session owners with current `join` permission can control their own session. The UI shows login, denied-access, and expiry messages.

OAuth state is cryptographically random, browser-bound, short-lived, and single-use. Opaque session cookies are HttpOnly/SameSite=Lax, and Secure for HTTPS; OAuth bearer tokens remain in memory on the server. State and sessions are discarded on restart. Sessions expire at the earlier of token expiry or eight hours; expiry requires a fresh login. Logout immediately disconnects that session's sockets.

REST writes require the session's CSRF token and exact public Origin. Socket.IO checks Origin on polling and WebSocket requests and validates the session/CSRF token on connection. Every event rechecks expiry, voice state, current session, and capabilities. Browser URL/preset updates are sent only to currently authorized participants. Guild roles are cached for at most 30 seconds with shared refreshes; role revocation can take that long, while voice/session changes apply on the next action.

Native listening and Compose host publishing default to loopback. Keep the published port private behind an HTTPS reverse proxy; set the callback to its public origin. The container listens on `0.0.0.0` internally. HTTP(S) private media servers remain usable, but explicit `file:`, `javascript:`, `data:`, browser-internal URLs and URL credentials are rejected before Selenium.

Automated tests use a stub OAuth provider and real HTTP/Socket.IO transports. Real Discord consent and a deployed callback require a configured application. See [Discord's OAuth documentation](https://discord.com/developers/docs/topics/oauth2) for the authorization-code grant and scopes.
