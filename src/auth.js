import crypto from "node:crypto";

const COOKIE_NAME = "il_session";
const MAX_AGE_DAYS = 30;

function secret() {
  return process.env.SESSION_SECRET || process.env.META_APP_SECRET || "insecure-dev-secret";
}

function sign(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("hex");
}

function cookieSecurityAttr() {
  return process.env.VERCEL || process.env.COOKIE_SECURE === "true" ? " Secure;" : "";
}

// Stateless signed session: "<accountId>.<hmac>". No server-side session store
// needed, which suits Vercel's serverless model.
export function makeSessionToken(accountId) {
  const id = String(accountId);
  return `${id}.${sign(id)}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const idx = token.lastIndexOf(".");
  if (idx === -1) return null;
  const id = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = sign(id);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

export function getSessionAccountId(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return verifySessionToken(token);
}

export function setSessionCookie(res, accountId) {
  const token = makeSessionToken(accountId);
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60;
  res.setHeader("Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly;${cookieSecurityAttr()} SameSite=Lax; Max-Age=${maxAge}`);
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly;${cookieSecurityAttr()} SameSite=Lax; Max-Age=0`);
}

// CSRF-ish state token for the OAuth round trip. We pack an optional payload
// (e.g. "connect" to mark an in-app Instagram connect vs. a fresh login).
export function makeOAuthState(payload = "") {
  const nonce = crypto.randomBytes(8).toString("hex");
  const body = payload ? `${nonce}~${payload}` : nonce;
  return `${body}.${sign(body)}`;
}

export function verifyOAuthState(state) {
  const id = verifySessionToken(state);
  if (id === null) return null;
  const tilde = id.indexOf("~");
  return { ok: true, payload: tilde === -1 ? "" : id.slice(tilde + 1) };
}

// ---- Password hashing (scrypt, no external dependency) ----
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, salt, hash] = stored.split("$");
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(hash);
  const b = Buffer.from(derived);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

// 6-digit OTP and its salted hash for phone verification.
export function makeOtp() {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  return code;
}
export function hashOtp(code) {
  return crypto.createHmac("sha256", secret()).update(String(code)).digest("hex");
}
