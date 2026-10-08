import test from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { OAuthService } from "../dist/server/oauth.js";
import { createWebServer } from "../dist/server/web.js";
import { WebAccessError, createAuthorization } from "../dist/server/authorization.js";
import { validateNavigationUrl } from "../dist/browser/url.js";
import { createClient, logout } from "../dist/discord/client.js";
import { initStreamingService } from "../dist/discord/streaming.js";
import { loadPermissions } from "../dist/rbac/permissions.js";

const settings = { clientId: "test-app", clientSecret: "fixture-secret", redirectUri: "http://127.0.0.1:8080/auth/callback" };
const cookieFrom = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(name + "="))?.split(";")[0];
const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

async function fixture(t) {
    let now = 100000, failToken = false, failMember = false, allowed = true;
    let capabilities = { control: true, navigate: true };
    let identity = "111111111111111111";
    const calls = [], requests = [];
    const provider = async (url, options) => {
        requests.push([url, options]);
        if (url.endsWith("/oauth2/token")) return failToken ? new Response("", { status: 400 }) : json({ access_token: "fixture-access", expires_in: 3600, scope: "identify guilds.members.read" });
        if (url.endsWith("/users/@me")) return json({ id: identity, username: "Reviewer" });
        return failMember ? new Response("", { status: 403 }) : json({ roles: ["222222222222222222"] });
    };
    const oauth = new OAuthService(settings, provider, () => now);
    const session = { id: "333333333333333333-444444444444444444", guildId: "333333333333333333", channelId: "444444444444444444", startedBy: "111111111111111111", currentUrl: "https://example.com" };
    const authorize = async login => {
        if (!oauth.valid(login)) throw new WebAccessError(401, "Expired");
        if (!allowed) throw new WebAccessError(403, "Not in this session's voice channel");
        return { session, stream: { joined: true, channelInfo: { guildId: session.guildId, channelId: session.channelId } }, capabilities };
    };
    const controls = {
        getCurrentUrl: async () => "https://example.com/", getCurrentPreset: () => null,
        getPresets: () => [{ id: "local", name: "Local media", url: "http://192.168.1.10:32400" }],
        navigateTo: async url => calls.push(["navigate", url]), navigateToPreset: async id => calls.push(["preset", id]),
        sendKey: async key => calls.push(["key", key]), search: async q => calls.push(["search", q]),
        submitSearch: async q => calls.push(["submit", q]), goBack: async () => calls.push(["back"]), refresh: async () => calls.push(["refresh"]),
    };
    const web = createWebServer(oauth, authorize, controls);
    await new Promise(resolve => web.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${web.server.address().port}`;
    t.after(() => web.close());
    const begin = async () => {
        const response = await fetch(base + "/auth/login", { redirect: "manual" });
        assert.equal(response.status, 302);
        const target = new URL(response.headers.get("location"));
        assert.equal(target.origin, "https://discord.com");
        assert.equal(target.searchParams.get("scope"), "identify guilds.members.read");
        return { state: target.searchParams.get("state"), cookie: cookieFrom(response, "theatre_oauth_state") };
    };
    const finish = async ({ state, cookie }) => fetch(base + `/auth/callback?code=fixture-code&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
    const login = async () => {
        const response = await finish(await begin()); assert.equal(response.status, 302);
        const cookie = cookieFrom(response, "theatre_session");
        const data = await (await fetch(base + "/api/auth/session", { headers: { Cookie: cookie } })).json();
        assert.equal(data.authenticated, true);
        return { cookie, csrf: data.csrf };
    };
    const post = (path, user, body, overrides = {}) => fetch(base + path, {
        method: "POST", headers: { Cookie: user?.cookie ?? "", Origin: oauth.origin, "X-CSRF-Token": user?.csrf ?? "", "Content-Type": "application/json", ...overrides }, body: JSON.stringify(body ?? {}),
    });
    const socket = user => io(base, { transports: ["websocket"], reconnection: false, auth: { csrf: user.csrf }, extraHeaders: { Cookie: user.cookie, Origin: oauth.origin } });
    return { oauth, web, base, calls, requests, begin, finish, login, post, socket,
        advance: ms => { now += ms; }, deny: () => { allowed = false; }, allow: () => { allowed = true; },
        identity: value => { identity = value; },
        capabilities: value => { capabilities = value; }, failToken: () => { failToken = true; }, failMember: () => { failMember = true; } };
}

function event(socket, name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 1500);
        socket.once(name, data => { clearTimeout(timer); resolve(data); });
    });
}

test("OAuth refuses incomplete/insecure deployment configuration", () => {
    for (const value of [{ ...settings, clientSecret: "" }, { ...settings, redirectUri: "http://theatre.example/auth/callback" }, { ...settings, redirectUri: "https://theatre.example/auth/callback?extra=1" }]) assert.throws(() => new OAuthService(value));
    assert.doesNotThrow(() => new OAuthService({ ...settings, redirectUri: "https://theatre.example/auth/callback" }));
    const cookies = [];
    const secure = new OAuthService({ ...settings, redirectUri: "https://theatre.example/auth/callback" });
    secure.begin({ cookie: (...values) => cookies.push(values), redirect: () => {} });
    assert.equal(cookies[0][0], "__Host-theatre_oauth_state");
    assert.equal(cookies[0][2].path, "/");
    assert.equal(cookies[0][2].secure, true);
    assert.equal(cookies[0][2].httpOnly, true);
});

test("browser-bound OAuth state is single use, expires, and never exchanges an invalid callback", async t => {
    const f = await fixture(t);
    const state = await f.begin();
    assert.equal((await f.finish({ ...state, cookie: "theatre_oauth_state=wrong" })).status, 400);
    assert.equal(f.requests.length, 0);
    const accepted = await f.finish(state); assert.equal(accepted.status, 302);
    assert.match(cookieFrom(accepted, "theatre_session"), /^theatre_session=[0-9a-f]{64}$/);
    assert.ok(accepted.headers.getSetCookie().some(value => /HttpOnly/.test(value) && /SameSite=Lax/.test(value)));
    assert.equal((await f.finish(state)).status, 400);
    const expired = await f.begin(); f.advance(300001);
    assert.equal((await f.finish(expired)).status, 400);
    f.failToken();
    assert.equal((await f.finish(await f.begin())).status, 400);
});

test("abandoned anonymous login bursts cannot exhaust login slots", async t => {
    const f = await fixture(t);
    for (let i = 0; i < 550; i++) await f.begin();
    assert.equal(f.requests.length, 0);
    const pending = await f.begin();
    const tampered = pending.state.replace(/^\d+/, String(100000 + 299000));
    assert.equal((await f.finish({ state: tampered, cookie: `theatre_oauth_state=${tampered}` })).status, 400);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.finish(pending)).status, 302);
    const exchanged = f.requests.length;
    assert.equal((await f.finish(pending)).status, 400);
    assert.equal(f.requests.length, exchanged);
});

test("one account cannot fill session capacity or block another account's login", async t => {
    const f = await fixture(t);
    const first = await f.login();
    let latest;
    for (let i = 1; i < 10; i++) latest = await f.login();
    assert.equal((await f.post("/api/key", first, { key: "Enter" })).status, 401);
    assert.equal((await f.post("/api/key", latest, { key: "Enter" })).status, 200);
    assert.equal((await f.finish(await f.begin())).status, 400);
    f.identity("999999999999999999");
    assert.ok(await f.login());
    f.advance(300001);
    f.identity("111111111111111111");
    assert.ok(await f.login());
});

test("closing OAuth invalidates issued login state", async t => {
    const f = await fixture(t), pending = await f.begin();
    f.oauth.close();
    assert.equal((await f.finish(pending)).status, 400);
    assert.equal(f.requests.length, 0);
});

test("REST protects reads, writes, CSRF, scope and explicit navigation", async t => {
    const f = await fixture(t);
    assert.equal((await fetch(f.base + "/api/status")).status, 401);
    assert.equal((await f.post("/api/navigate", null, { url: "https://example.com" })).status, 401);
    const user = await f.login();
    const publicIdentity = await (await fetch(f.base + "/api/auth/session", { headers: { Cookie: user.cookie } })).text();
    assert.doesNotMatch(publicIdentity, /fixture-access|fixture-secret/);
    assert.equal((await f.post("/api/navigate", user, { url: "https://example.com" }, { Origin: "https://untrusted.example" })).status, 403);
    assert.equal((await f.post("/api/navigate", user, { url: "https://example.com" }, { "X-CSRF-Token": "wrong" })).status, 403);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,test", "chrome://settings", "https://user:password@example.com", "not-a-url", null]) {
        assert.equal((await f.post("/api/navigate", user, { url })).status, 400);
    }
    assert.equal(f.calls.length, 0);
    f.capabilities({ control: true, navigate: false });
    assert.equal((await f.post("/api/navigate", user, { url: "https://example.com" })).status, 403);
    assert.equal((await f.post("/api/key", user, { key: "ArrowUp" })).status, 200);
    f.capabilities({ control: true, navigate: true });
    assert.equal((await f.post("/api/navigate", user, { url: "http://192.168.1.10:32400" })).status, 200);
    f.deny();
    assert.equal((await fetch(f.base + "/api/status", { headers: { Cookie: user.cookie } })).status, 403);
    assert.equal((await f.post("/api/refresh", user)).status, 403);
    f.allow(); f.advance(3600001);
    assert.equal((await f.post("/api/key", user, { key: "Enter" })).status, 401);
});

test("membership refresh shares work, bounds role staleness and denies provider failures", async t => {
    const f = await fixture(t), user = await f.login();
    const session = f.oauth.session({ headers: { cookie: user.cookie } });
    const guild = "333333333333333333";
    await Promise.all(Array.from({ length: 10 }, () => f.oauth.membership(session, guild)));
    assert.equal(f.requests.filter(([url]) => url.endsWith("/member")).length, 1);
    f.advance(30001); f.failMember();
    await assert.rejects(f.oauth.membership(session, guild));
    assert.equal(f.requests.filter(([url]) => url.endsWith("/member")).length, 2);
    assert.equal((await f.post("/auth/logout", user)).status, 200);
    await assert.rejects(f.oauth.membership(session, guild));
});

test("Socket.IO gates direct WebSockets and polling, rechecks permissions, expires and logs out", async t => {
    const f = await fixture(t), user = await f.login();
    const foreignPolling = await fetch(f.base + "/socket.io/?EIO=4&transport=polling", { headers: { Origin: "https://untrusted.example", Cookie: user.cookie } });
    assert.equal(foreignPolling.status, 403);
    const polling = io(f.base, { transports: ["polling"], reconnection: false, auth: { csrf: user.csrf }, extraHeaders: {
        Cookie: user.cookie, Referer: f.oauth.origin + "/", "Sec-Fetch-Site": "same-origin",
    } });
    await event(polling, "connect"); polling.disconnect();
    const foreign = io(f.base, { transports: ["websocket"], reconnection: false, timeout: 1000, auth: { csrf: user.csrf }, extraHeaders: { Origin: "https://untrusted.example", Cookie: user.cookie } });
    await event(foreign, "connect_error"); foreign.disconnect();
    const anonymous = f.socket({ csrf: "", cookie: "" });
    await event(anonymous, "connect_error"); anonymous.disconnect();
    const badCsrf = f.socket({ ...user, csrf: "wrong" });
    await event(badCsrf, "connect_error"); badCsrf.disconnect();
    const socket = f.socket(user); t.after(() => socket.disconnect());
    await event(socket, "connect");
    let changed = event(socket, "urlChanged");
    socket.emit("navigate", "https://example.com/video");
    assert.equal((await changed).url, "https://example.com/video");
    f.deny();
    const denied = event(socket, "error"); socket.emit("key", "Enter"); await denied;
    assert.equal(f.calls.filter(([action]) => action === "key").length, 0);
    f.allow();
    const disconnected = event(socket, "disconnect");
    assert.equal((await f.post("/auth/logout", user)).status, 200);
    await disconnected;
    assert.deepEqual(await (await fetch(f.base + "/api/auth/session", { headers: { Cookie: user.cookie } })).json(), { authenticated: false });
});

test("URL policy preserves HTTPS and private media HTTP without local or executable schemes", () => {
    assert.equal(validateNavigationUrl("http://localhost:32400/web"), "http://localhost:32400/web");
    assert.equal(validateNavigationUrl("https://example.com/?q=a%20b"), "https://example.com/?q=a%20b");
    for (const url of [undefined, {}, "file:///", "about:blank", "javascript:alert(1)", "https://user@example.com/", "https://example.com/\n", "//example.com"]) assert.throws(() => validateNavigationUrl(url));
});

test("an expired open Socket.IO session cannot send controls or receive browser updates", async t => {
    const f = await fixture(t), user = await f.login();
    const socket = f.socket(user); t.after(() => socket.disconnect());
    await event(socket, "connect");
    f.advance(3600001);
    const failed = event(socket, "error"), disconnected = event(socket, "disconnect");
    socket.emit("navigate", "https://example.com/");
    assert.match((await failed).message, /Sign in/);
    await disconnected;
    assert.deepEqual(f.calls, []);
});

test("OAuth identity and roles authorize only the current gateway voice/session, including after an await", async t => {
    const f = await fixture(t), user = await f.login();
    const login = f.oauth.session({ headers: { cookie: user.cookie } });
    const client = createClient(), streaming = initStreamingService(client);
    t.after(async () => { loadPermissions({}); await logout(); });
    const guildId = "333333333333333333", channelId = "444444444444444444", roleId = "222222222222222222";
    const active = { id: `${guildId}-${channelId}`, guildId, channelId, startedBy: "999999999999999999" };
    let channel = channelId, current = active;
    const guild = { id: guildId, ownerId: "888888888888888888", voiceStates: { cache: new Map([[login.user.id, { channelId }]]) }, roles: { cache: new Map([[roleId, { permissions: { has: () => false } }]]) } };
    client.guilds.cache.set(guildId, guild);
    t.mock.method(streaming, "getStatus", () => ({ joined: true, channelInfo: { guildId, channelId: channel } }));
    t.mock.method(streaming, "getSession", id => id === current.id ? current : undefined);
    loadPermissions({ [guildId]: { control: [roleId] } });
    const authorize = createAuthorization(f.oauth);
    assert.deepEqual((await authorize(login)).capabilities, { control: true, navigate: false });
    guild.voiceStates.cache.get(login.user.id).channelId = "555555555555555555";
    await assert.rejects(authorize(login), error => error.status === 403);
    guild.voiceStates.cache.get(login.user.id).channelId = channelId;
    loadPermissions({ [guildId]: { navigate: [login.user.id] } });
    assert.deepEqual((await authorize(login)).capabilities, { control: false, navigate: true });
    let release;
    t.mock.method(f.oauth, "membership", () => new Promise(resolve => { release = resolve; }));
    const pending = authorize(login);
    channel = "666666666666666666";
    current = { ...active, id: `${guildId}-${channel}`, channelId: channel };
    release({ roles: [roleId] });
    await assert.rejects(pending, error => error.status === 409);
});
