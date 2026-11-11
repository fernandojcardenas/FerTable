// Single sign-on with OpenID Connect (Google Workspace, Microsoft Entra ID, Okta,
// Auth0, Keycloak and others). Authorization code flow with PKCE; the ID token's
// signature, issuer, audience, expiry and nonce are all checked before anyone is signed in.
//
// Settings: GRIDBASE_OIDC_ISSUER, GRIDBASE_OIDC_CLIENT_ID, GRIDBASE_OIDC_CLIENT_SECRET,
// optional GRIDBASE_OIDC_NAME (button label), GRIDBASE_OIDC_DOMAINS (allowed email
// domains, comma-separated) and GRIDBASE_OIDC_ONLY=true (turn password sign-in off).

import { createHash, createPublicKey, randomBytes, verify as verifySig, type JsonWebKey } from "node:crypto";
import { AuthError } from "./auth";
import { appUrl } from "./mail";

export const SSO_COOKIE = "gb_sso";

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint?: string };

export function ssoSettings() {
  const issuer = process.env.GRIDBASE_OIDC_ISSUER?.replace(/\/$/, "");
  const clientId = process.env.GRIDBASE_OIDC_CLIENT_ID;
  if (!issuer || !clientId) return null;
  return {
    issuer, clientId,
    clientSecret: process.env.GRIDBASE_OIDC_CLIENT_SECRET ?? "",
    name: process.env.GRIDBASE_OIDC_NAME || "single sign-on",
    domains: (process.env.GRIDBASE_OIDC_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
    only: process.env.GRIDBASE_OIDC_ONLY === "true",
  };
}

/** What the sign-in page needs to show the button. */
export function ssoPublicInfo() {
  const s = ssoSettings();
  return s ? { enabled: true, name: s.name, only: s.only } : { enabled: false, name: "", only: false };
}

let discovery: { at: number; doc: Discovery } | null = null;
let jwks: { at: number; keys: (JsonWebKey & { kid?: string; alg?: string })[] } | null = null;

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json() as Promise<T>;
}

async function getDiscovery(issuer: string): Promise<Discovery> {
  if (discovery && Date.now() - discovery.at < 3600_000) return discovery.doc;
  const doc = await getJson<Discovery>(`${issuer}/.well-known/openid-configuration`);
  if (doc.issuer.replace(/\/$/, "") !== issuer) throw new Error("The identity provider's issuer doesn't match GRIDBASE_OIDC_ISSUER");
  discovery = { at: Date.now(), doc };
  return doc;
}

async function getKeys(uri: string, force = false) {
  if (!force && jwks && Date.now() - jwks.at < 3600_000) return jwks.keys;
  const doc = await getJson<{ keys: (JsonWebKey & { kid?: string; alg?: string })[] }>(uri);
  jwks = { at: Date.now(), keys: doc.keys ?? [] };
  return jwks.keys;
}

const b64url = (b: Buffer) => b.toString("base64url");
const pending = new Map<string, { verifier: string; nonce: string; next: string; expires: number }>();

/** Start signing in: returns the provider's address to send the browser to, and a cookie that ties the reply to this browser. */
export async function ssoStart(nextPath: string): Promise<{ url: string; cookie: string }> {
  const s = ssoSettings();
  if (!s) throw new AuthError(404, "Single sign-on isn't set up on this server");
  const d = await getDiscovery(s.issuer);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  if (pending.size > 10_000) throw new AuthError(429, "Too many sign-ins in progress. Try again in a minute.");
  // Only same-site paths are allowed as the place to land afterwards.
  const next = /^\/(?!\/)[^\s]*$/.test(nextPath) ? nextPath : "/";
  pending.set(state, { verifier, nonce, next, expires: now + 10 * 60_000 });
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", s.clientId);
  u.searchParams.set("redirect_uri", `${appUrl()}/api/auth/sso/callback`);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  u.searchParams.set("code_challenge_method", "S256");
  return { url: u.toString(), cookie: state };
}

type Claims = { iss: string; aud: string | string[]; exp: number; iat?: number; nonce?: string; email?: string; email_verified?: boolean | string; name?: string; given_name?: string; family_name?: string; sub: string };

async function verifyIdToken(token: string, s: NonNullable<ReturnType<typeof ssoSettings>>, d: Discovery, nonce: string): Promise<Claims> {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) throw new Error("The identity provider sent a malformed ID token");
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg: string; kid?: string };
  const algs: Record<string, { hash: string; ec?: boolean; pss?: boolean }> = {
    RS256: { hash: "sha256" }, RS384: { hash: "sha384" }, RS512: { hash: "sha512" },
    PS256: { hash: "sha256", pss: true }, ES256: { hash: "sha256", ec: true }, ES384: { hash: "sha384", ec: true },
  };
  const alg = algs[header.alg];
  if (!alg) throw new Error(`ID tokens signed with ${header.alg} aren't accepted`);
  let keys = await getKeys(d.jwks_uri);
  let jwk = keys.find((k) => (!header.kid || k.kid === header.kid) && (!k.alg || k.alg === header.alg));
  if (!jwk) { keys = await getKeys(d.jwks_uri, true); jwk = keys.find((k) => !header.kid || k.kid === header.kid); }
  if (!jwk) throw new Error("No signing key matches the ID token");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok = verifySig(alg.hash, Buffer.from(`${h}.${p}`), alg.ec ? { key, dsaEncoding: "ieee-p1363" } : alg.pss ? { key, padding: 6, saltLength: 32 } : key, Buffer.from(sig, "base64url"));
  if (!ok) throw new Error("The ID token's signature is wrong");
  const c = JSON.parse(Buffer.from(p, "base64url").toString()) as Claims;
  const now = Date.now() / 1000;
  if (c.iss.replace(/\/$/, "") !== s.issuer) throw new Error("The ID token is from a different issuer");
  if (!(Array.isArray(c.aud) ? c.aud : [c.aud]).includes(s.clientId)) throw new Error("The ID token is for a different app");
  if (!(c.exp > now - 60)) throw new Error("The ID token has expired");
  if (c.nonce !== nonce) throw new Error("The ID token doesn't belong to this sign-in");
  return c;
}

/** Finish signing in: check the provider's answer and return who it vouches for. */
export async function ssoCallback(query: URLSearchParams, cookieState: string | null): Promise<{ email: string; name: string; verified: boolean; next: string }> {
  const s = ssoSettings();
  if (!s) throw new AuthError(404, "Single sign-on isn't set up on this server");
  if (query.get("error")) throw new AuthError(401, `Sign-in was cancelled or refused (${String(query.get("error_description") ?? query.get("error")).slice(0, 200)})`);
  const state = query.get("state") ?? "";
  const p = pending.get(state);
  pending.delete(state);
  // The state must match the cookie set when this browser started, so nobody can sign someone else in.
  if (!p || p.expires < Date.now() || !cookieState || cookieState !== state) throw new AuthError(401, "This sign-in link expired or was started in another browser. Try again.");
  const d = await getDiscovery(s.issuer);
  const body = new URLSearchParams({
    grant_type: "authorization_code", code: query.get("code") ?? "", redirect_uri: `${appUrl()}/api/auth/sso/callback`,
    client_id: s.clientId, code_verifier: p.verifier, ...(s.clientSecret ? { client_secret: s.clientSecret } : {}),
  });
  const r = await fetch(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, signal: AbortSignal.timeout(10_000) });
  const tokens = (await r.json().catch(() => ({}))) as { id_token?: string; access_token?: string; error?: string; error_description?: string };
  if (!r.ok || !tokens.id_token) throw new AuthError(401, `The identity provider refused the sign-in${tokens.error ? ` (${tokens.error_description ?? tokens.error})` : ""}`);
  let claims: Claims;
  try { claims = await verifyIdToken(tokens.id_token, s, d, p.nonce); } catch (e) { throw new AuthError(401, e instanceof Error ? e.message : String(e)); }
  let email = claims.email, verified = claims.email_verified === true || claims.email_verified === "true", name = claims.name ?? [claims.given_name, claims.family_name].filter(Boolean).join(" ");
  if (!email && d.userinfo_endpoint && tokens.access_token) {
    const info = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10_000) }).then((x) => x.json()).catch(() => ({})) as Partial<Claims>;
    if (info.sub === claims.sub) { email = info.email; verified = info.email_verified === true || info.email_verified === "true"; name ||= info.name ?? ""; }
  }
  if (!email) throw new AuthError(401, "The identity provider didn't share an email address");
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (s.domains.length && !s.domains.includes(domain)) throw new AuthError(403, `Accounts from ${domain} can't sign in here`);
  return { email, name, verified, next: p.next };
}
