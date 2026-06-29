const GRAPH_VERSION = process.env.GRAPH_VERSION || "v25.0";
const GRAPH_HOST = process.env.META_GRAPH_HOST || "graph.facebook.com";

// Scopes requested when a customer logs in / connects their Instagram.
export const LOGIN_SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "instagram_basic",
  "instagram_manage_comments",
  "instagram_manage_messages"
];

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || "").replace(/^\uFEFF/, "").trim();
}

function redirectUri() {
  return `${baseUrl()}/oauth/callback`;
}

// Which auth methods are available, so the login page can show the right buttons.
export function getAuthMethods() {
  return {
    facebook: !!process.env.META_APP_ID,
    google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    email: true,
    phone: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER)
      || process.env.ALLOW_DEV_OTP === "true"
  };
}

// ---- Google OAuth (code flow) ----
function googleRedirectUri() {
  return `${baseUrl()}/auth/google/callback`;
}

export function getGoogleLoginUrl(state) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  return "https://accounts.google.com/o/oauth2/v2/auth"
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(googleRedirectUri())}`
    + `&response_type=code`
    + `&scope=${encodeURIComponent("openid email profile")}`
    + `&state=${encodeURIComponent(state)}`
    + `&access_type=online&prompt=select_account`;
}

export async function exchangeGoogleCode(code) {
  const params = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: googleRedirectUri(),
    grant_type: "authorization_code"
  });
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw new Error(tokenBody.error_description || "Google token exchange failed.");
  }
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` }
  });
  const info = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok || !info.sub) throw new Error("Could not read Google profile.");
  return { googleId: info.sub, email: (info.email || "").toLowerCase(), name: info.name || info.email };
}

// ---- SMS (Twilio, with a dev fallback) ----
export async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    // Dev fallback: no provider configured.
    console.log(`[sms:dev] to ${to}: ${body}`);
    return { delivered: false, dev: true };
  }
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });
  const body2 = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body2.message || "SMS send failed.");
  return { delivered: true };
}

// Step 1 of "Continue with Facebook": URL we send the user to.
export function getLoginUrl(state) {
  const appId = process.env.META_APP_ID;
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`
    + `?client_id=${encodeURIComponent(appId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri())}`
    + `&state=${encodeURIComponent(state)}`
    + `&response_type=code`
    + `&scope=${encodeURIComponent(LOGIN_SCOPES.join(","))}`;
}

// Step 2: exchange the ?code for a (long-lived) user access token.
export async function exchangeCodeForToken(code) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const tokenUrl = `https://${GRAPH_HOST}/${GRAPH_VERSION}/oauth/access_token`
    + `?client_id=${encodeURIComponent(appId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri())}`
    + `&client_secret=${encodeURIComponent(appSecret)}`
    + `&code=${encodeURIComponent(code)}`;
  const res = await fetch(tokenUrl);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(body.error?.message || "Failed to exchange code for token.");
  }

  // Upgrade to a long-lived token so customer sessions don't expire in an hour.
  const longUrl = `https://${GRAPH_HOST}/${GRAPH_VERSION}/oauth/access_token`
    + `?grant_type=fb_exchange_token`
    + `&client_id=${encodeURIComponent(appId)}`
    + `&client_secret=${encodeURIComponent(appSecret)}`
    + `&fb_exchange_token=${encodeURIComponent(body.access_token)}`;
  const longRes = await fetch(longUrl);
  const longBody = await longRes.json().catch(() => ({}));
  return longBody.access_token || body.access_token;
}

// Step 3: read the profile + the Page/Instagram this token can manage.
export async function fetchAccountProfile(token) {
  const meRes = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/me?fields=id,name&access_token=${token}`);
  const me = await meRes.json().catch(() => ({}));
  if (!meRes.ok) throw new Error(me.error?.message || "Could not read profile.");

  const pagesRes = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${token}`);
  const pagesBody = await pagesRes.json().catch(() => ({}));
  const pages = pagesBody.data || [];
  const linked = pages.find((p) => p.instagram_business_account) || null;

  return {
    fbUserId: me.id,
    name: me.name,
    pageId: linked?.id || "",
    pageName: linked?.name || "",
    pageToken: linked?.access_token || "",
    igUserId: linked?.instagram_business_account?.id || "",
    igUsername: linked?.instagram_business_account?.username || "",
    pageCount: pages.length
  };
}

export async function subscribePageToApp(pageId, pageToken) {
  const res = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/${pageId}/subscribed_apps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscribed_fields: ["feed"], access_token: pageToken })
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.success === true, body };
}

// Single source of truth for dry-run state. Dry-run is the SAFE default: real
// messages are only sent when DRY_RUN is explicitly set to the string "false".
export function isDryRun() {
  return process.env.DRY_RUN !== "false";
}

export function getMetaConfigStatus() {
  const required = ["META_APP_ID", "META_ACCESS_TOKEN", "IG_USER_ID", "META_VERIFY_TOKEN", "PUBLIC_BASE_URL"];
  const missing = required.filter((name) => !process.env[name]);
  const dryRun = isDryRun();
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || "";
  const oauthRedirectUri = publicBaseUrl ? `${publicBaseUrl}/oauth/callback` : "";
  const scopes = [
    "pages_show_list",
    "pages_read_engagement",
    "instagram_basic",
    "instagram_manage_comments",
    "instagram_manage_messages"
  ];
  const oauthUrl = process.env.META_APP_ID && oauthRedirectUri
    ? `https://www.facebook.com/v25.0/dialog/oauth?client_id=${encodeURIComponent(process.env.META_APP_ID)}&redirect_uri=${encodeURIComponent(oauthRedirectUri)}&response_type=token&scope=${encodeURIComponent(scopes.join(","))}`
    : "";

  return {
    dryRun,
    readyForRealMessages: !dryRun && missing.length === 0,
    graphVersion: GRAPH_VERSION,
    graphHost: GRAPH_HOST,
    missing,
    appId: process.env.META_APP_ID || "",
    publicBaseUrl,
    webhookUrl: publicBaseUrl ? `${publicBaseUrl}/webhooks/meta` : "",
    oauthRedirectUri,
    oauthUrl,
    oauthScopes: scopes,
    notes: [
      "Instagram must be a Professional account: Creator or Business.",
      "A personal Instagram account cannot use the official comment-to-DM API.",
      "Follower verification for a specific commenter is not exposed by the official API."
    ]
  };
}

export async function checkMetaConnection() {
  const status = getMetaConfigStatus();
  if (status.dryRun) {
    return {
      ok: false,
      mode: "dry_run",
      message: "DRY_RUN is enabled, so real Meta calls are disabled."
    };
  }

  if (!process.env.META_ACCESS_TOKEN || !process.env.IG_USER_ID) {
    return {
      ok: false,
      mode: "missing_config",
      message: "META_ACCESS_TOKEN and IG_USER_ID are required."
    };
  }

  const response = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/${process.env.IG_USER_ID}?fields=id,username&access_token=${process.env.META_ACCESS_TOKEN}`);
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      mode: "meta_error",
      message: body.error?.message || response.statusText,
      details: body
    };
  }

  return {
    ok: true,
    mode: "connected",
    profile: body
  };
}

// Turn whatever the user pasted into the Media field into the NUMERIC media id
// that comment webhooks actually carry. Accepts:
//   - "" / blank            -> "" (campaign matches any post)
//   - a numeric id          -> returned as-is
//   - a post/reel URL       -> shortcode extracted, then resolved
//   - a bare shortcode      -> resolved against the account's media
// Resolution matches the shortcode against the IG account's media permalinks.
// Returns { mediaId, resolved, warning }.
export async function resolveMediaId(input, account = null) {
  const raw = String(input || "").trim();
  if (!raw) return { mediaId: "", resolved: true };
  if (/^\d+$/.test(raw)) return { mediaId: raw, resolved: true };

  // Pull the shortcode out of a URL like instagram.com/p/<code>/ or /reel/<code>/
  let shortcode = raw;
  const urlMatch = raw.match(/instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/i);
  if (urlMatch) shortcode = urlMatch[1];

  const token = account?.accessToken || process.env.META_ACCESS_TOKEN;
  const igUserId = account?.igUserId || process.env.IG_USER_ID;
  if (!token || !igUserId) {
    return { mediaId: "", resolved: false, warning: "Could not resolve media (Meta not configured); campaign will match any post." };
  }

  let url = `https://${GRAPH_HOST}/${GRAPH_VERSION}/${igUserId}/media?fields=id,permalink&limit=100&access_token=${token}`;
  for (let page = 0; page < 5 && url; page++) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { mediaId: "", resolved: false, warning: body.error?.message || "Media lookup failed; campaign will match any post." };
    }
    for (const media of body.data || []) {
      if (media.permalink && media.permalink.includes(`/${shortcode}`)) {
        return { mediaId: media.id, resolved: true };
      }
    }
    url = body.paging?.next || null;
  }

  return { mediaId: "", resolved: false, warning: `Could not find a post matching "${shortcode}"; campaign will match any post.` };
}

export async function fetchRecentInstagramComments(account = null, { mediaLimit = 10, commentLimit = 25 } = {}) {
  const token = account?.accessToken || process.env.META_ACCESS_TOKEN;
  const igUserId = account?.igUserId || process.env.IG_USER_ID;
  if (!token || !igUserId) {
    throw new Error("An Instagram account and access token are required to read comments.");
  }

  const mediaUrl = `https://${GRAPH_HOST}/${GRAPH_VERSION}/${igUserId}/media`
    + `?fields=id,permalink,timestamp`
    + `&limit=${encodeURIComponent(mediaLimit)}`
    + `&access_token=${encodeURIComponent(token)}`;
  const mediaRes = await fetch(mediaUrl);
  const mediaBody = await mediaRes.json().catch(() => ({}));
  if (!mediaRes.ok) {
    throw new Error(mediaBody.error?.message || "Could not read Instagram media.");
  }

  const comments = [];
  for (const media of mediaBody.data || []) {
    const commentsUrl = `https://${GRAPH_HOST}/${GRAPH_VERSION}/${media.id}/comments`
      + `?fields=id,text,username,timestamp`
      + `&limit=${encodeURIComponent(commentLimit)}`
      + `&access_token=${encodeURIComponent(token)}`;
    const commentsRes = await fetch(commentsUrl);
    const commentsBody = await commentsRes.json().catch(() => ({}));
    if (!commentsRes.ok) continue;

    for (const comment of commentsBody.data || []) {
      comments.push({
        commentId: comment.id,
        text: comment.text || "",
        mediaId: media.id,
        recipientIgId: igUserId,
        // Polling cannot see the commenter's scoped IG ID, so use the comment
        // ID as a stable fallback to avoid merging different comments.
        instagramUserId: comment.id || comment.username || "unknown",
        username: comment.username || "unknown",
        receivedAt: comment.timestamp || new Date().toISOString()
      });
    }
  }

  return comments.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
}

// End-to-end check of the pieces required for real comments to reach this app.
// Surfaces the common silent failures: missing token/IG id, IG not linked to a
// Page, and the app not subscribed to the Instagram object.
export async function diagnoseWebhookSetup() {
  const token = process.env.META_ACCESS_TOKEN;
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const igUserId = process.env.IG_USER_ID;
  const checks = [];

  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add("META_ACCESS_TOKEN set", !!token);
  add("IG_USER_ID set", !!igUserId);
  add("META_APP_SECRET set", !!appSecret, appSecret ? undefined : "Webhook signatures cannot be verified without it.");

  if (token && igUserId) {
    const igRes = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/${igUserId}?fields=id,username&access_token=${token}`);
    const igBody = await igRes.json().catch(() => ({}));
    add("Instagram account reachable", igRes.ok, igRes.ok ? `@${igBody.username}` : igBody.error?.message);
  }

  if (token) {
    const pagesRes = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${token}`);
    const pagesBody = await pagesRes.json().catch(() => ({}));
    const pages = pagesBody.data || [];
    const linked = pages.find((p) => p.instagram_business_account?.id === igUserId);
    add("Facebook Page linked to this IG account", !!linked,
      linked ? `Page "${linked.name}" (${linked.id})` : `Found ${pages.length} page(s), none linked to IG ${igUserId}.`);
  }

  if (appId && appSecret) {
    const appToken = `${appId}|${appSecret}`;
    const subsRes = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/${appId}/subscriptions?access_token=${appToken}`);
    const subsBody = await subsRes.json().catch(() => ({}));
    const igSub = (subsBody.data || []).find((s) => s.object === "instagram" && s.active);
    const hasComments = igSub?.fields?.some((f) => (f.name || f) === "comments");
    add("App subscribed to Instagram 'comments' webhook", !!hasComments,
      igSub ? `callback: ${igSub.callback_url}` : "No active instagram subscription found.");
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export async function sendPrivateReply({ commentId, message, account = null }) {
  if (isDryRun()) {
    return {
      dryRun: true,
      commentId,
      message
    };
  }

  // Per-customer credentials when available; fall back to env (single-tenant).
  const pageId = account?.pageId || process.env.PAGE_ID;
  const igUserId = account?.igUserId || process.env.IG_USER_ID;
  const accessToken = account?.accessToken || process.env.META_ACCESS_TOKEN;

  if ((!pageId && !igUserId) || !accessToken) {
    throw new Error("An Instagram account and access token are required to send a reply.");
  }

  // Instagram private replies are sent through the linked Facebook Page's
  // messages endpoint. Keep the IG ID fallback for older single-tenant envs.
  const messagingActorId = pageId || igUserId;
  const response = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/${messagingActorId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recipient: {
        comment_id: commentId
      },
      message: {
        text: message
      }
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = body.error || {};
    const parts = [err.message || response.statusText];
    if (err.code !== undefined) parts.push(`code ${err.code}`);
    if (err.error_subcode !== undefined) parts.push(`subcode ${err.error_subcode}`);
    throw new Error(`Meta private reply failed: ${parts.join(" | ")}`);
  }

  return body;
}

export async function replyToComment({ commentId, message, account = null }) {
  if (isDryRun()) {
    return {
      dryRun: true,
      commentId,
      message
    };
  }

  const accessToken = account?.accessToken || process.env.META_ACCESS_TOKEN;
  if (!commentId || !accessToken) {
    throw new Error("A comment ID and access token are required to reply to a comment.");
  }

  const response = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/${commentId}/replies`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ message })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = body.error || {};
    const parts = [err.message || response.statusText];
    if (err.code !== undefined) parts.push(`code ${err.code}`);
    if (err.error_subcode !== undefined) parts.push(`subcode ${err.error_subcode}`);
    throw new Error(`Meta comment reply failed: ${parts.join(" | ")}`);
  }

  return body;
}
