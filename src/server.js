import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import dotenv from "dotenv";
import express from "express";
import { createId, mutateStore, nowIso, readStore, storeBackend } from "./store.js";
import {
  checkMetaConnection, diagnoseWebhookSetup, getMetaConfigStatus, resolveMediaId, replyToComment, sendPrivateReply,
  fetchRecentInstagramComments, getLoginUrl, exchangeCodeForToken, fetchAccountProfile, subscribePageToApp,
  getAuthMethods, getGoogleLoginUrl, exchangeGoogleCode, sendSms
} from "./meta.js";
import {
  getSessionAccountId, setSessionCookie, clearSessionCookie, makeOAuthState, verifyOAuthState,
  hashPassword, verifyPassword, makeOtp, hashOtp
} from "./auth.js";

dotenv.config();

// Some env values (notably PUBLIC_BASE_URL) can arrive with a stray UTF-8 BOM
// or surrounding whitespace from dashboard copy-paste, which silently breaks
// OAuth redirect-URI matching and Graph URLs. Clean them once at startup.
for (const key of [
  "PUBLIC_BASE_URL", "META_APP_ID", "META_APP_SECRET", "META_ACCESS_TOKEN",
  "IG_USER_ID", "PAGE_ID", "META_VERIFY_TOKEN", "ADMIN_IG_USER_ID", "SESSION_SECRET",
  "GRAPH_VERSION", "META_GRAPH_HOST"
]) {
  if (process.env[key]) {
    process.env[key] = process.env[key].replace(/^\uFEFF/, "").trim();
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve("public");

app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));
// Serve assets but NOT index.html automatically; page routes are auth-gated below.
app.use(express.static("public", { index: false }));

function adminIgId() {
  return process.env.ADMIN_IG_USER_ID || process.env.IG_USER_ID || "";
}

function adminEmail() {
  return (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
}

function isAdmin(account) {
  if (!account) return false;
  return account.role === "admin"
    || account.id === adminIgId()
    || (!!account.igUserId && account.igUserId === adminIgId())
    || (!!account.email && account.email === adminEmail());
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

async function loadAccount(req) {
  const id = getSessionAccountId(req);
  if (!id) return null;
  const data = await readStore();
  return data.accounts.find((a) => a.id === id) || null;
}

async function requireAuth(req, res, next) {
  const account = await loadAccount(req);
  if (!account) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  if (account.suspended && !isAdmin(account)) {
    res.status(403).json({ error: "Your account has been suspended. Contact support.", suspended: true });
    return;
  }
  req.account = account;
  next();
}

async function requireAdmin(req, res, next) {
  const account = await loadAccount(req);
  if (!isAdmin(account)) {
    res.status(403).json({ error: "Admin access only." });
    return;
  }
  req.account = account;
  next();
}

// Strip sensitive fields before sending an account to the browser.
function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    name: account.name,
    email: account.email || "",
    phone: account.phone || "",
    googleLinked: !!account.googleId,
    igUserId: account.igUserId || "",
    username: account.username || "",
    pageName: account.pageName || "",
    pageSubscribed: !!account.pageSubscribed,
    connected: !!account.igUserId,
    defaultMessage: account.defaultMessage || "",
    suspended: !!account.suspended,
    role: isAdmin(account) ? "admin" : "customer",
    createdAt: account.createdAt,
    lastActiveAt: account.lastActiveAt
  };
}

function verifyMetaSignature(req) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.warn("[webhook] META_APP_SECRET is not set; skipping signature verification.");
    return true;
  }

  const signature = req.header("x-hub-signature-256");
  if (!signature || !req.rawBody) {
    console.warn("[webhook] Rejected: missing signature header or raw body.");
    return false;
  }

  const expected = `sha256=${crypto
    .createHmac("sha256", appSecret)
    .update(req.rawBody)
    .digest("hex")}`;

  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !crypto.timingSafeEqual(actual, expectedBuffer)) {
    console.warn("[webhook] Rejected: signature mismatch. Check META_APP_SECRET matches the app.");
    return false;
  }
  return true;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Only allow http(s) links so a stored delivery link can't become a
// javascript: or data: URI in an href.
function safeUrl(value) {
  const raw = String(value ?? "").trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return raw;
  } catch {
    // fall through
  }
  return "#";
}

function normalizeKeywords(input) {
  return String(input || "")
    .split(",")
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);
}

function commentEventsFromWebhook(payload) {
  const events = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;
      const value = change.value || {};
      events.push({
        commentId: value.id || value.comment_id,
        text: value.text || "",
        mediaId: value.media?.id || value.media_id || "",
        // entry.id is the IG account that received the comment; used to route
        // the event to the right customer.
        recipientIgId: entry.id,
        instagramUserId: value.from?.id || value.user_id || "unknown",
        username: value.from?.username || value.username || "unknown",
        receivedAt: nowIso()
      });
    }
  }
  return events.filter((event) => event.commentId);
}

function matchesCampaign(comment, campaign) {
  if (!campaign.active) return false;
  if (campaign.mediaId && campaign.mediaId !== comment.mediaId) return false;
  const text = comment.text.toLowerCase();
  return campaign.keywords.some((keyword) => text.includes(keyword));
}

// A single comment should trigger at most ONE campaign, otherwise a commenter
// gets spammed with a DM from every matching campaign. We prefer a campaign
// that targets this specific media over a catch-all (no mediaId) campaign.
function selectCampaign(comment, campaigns) {
  const matches = campaigns.filter((campaign) => matchesCampaign(comment, campaign));
  if (!matches.length) return null;
  const mediaSpecific = matches.find((campaign) => campaign.mediaId);
  return mediaSpecific || matches[0];
}

function renderMessage(template, lead) {
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
  const captureUrl = `${baseUrl}/capture/${lead.id}`;
  return template
    .replaceAll("{{username}}", lead.username)
    .replaceAll("{{link}}", lead.deliveryLink)
    .replaceAll("{{capture_url}}", captureUrl);
}

function renderPublicReply(template, lead) {
  const fallback = "Sent - check your DM.";
  return String(template || fallback)
    .replaceAll("{{username}}", lead.username || "")
    .replaceAll("{{link}}", lead.deliveryLink || "")
    .trim() || fallback;
}

async function processComment(comment, account) {
  if (!account) {
    return [{ skipped: true, reason: "no_account_for_recipient" }];
  }

  // Skip comments left by the connected account itself; never DM yourself,
  // and this also prevents reply loops.
  if (account.igUserId && comment.instagramUserId === account.igUserId) {
    return [{ skipped: true, reason: "own_comment" }];
  }

  const ownCampaigns = (await readStore()).campaigns.filter((c) => c.accountId === account.id);
  const campaign = selectCampaign(comment, ownCampaigns);
  const campaigns = campaign ? [campaign] : [];
  const results = [];

  for (const campaign of campaigns) {
    const result = await mutateStore(async (data) => {
      const duplicateComment = data.leads.find((lead) => (
        lead.campaignId === campaign.id && lead.commentId === comment.commentId
      ));
      if (duplicateComment) {
        return { skipped: true, reason: "duplicate_comment", lead: duplicateComment };
      }

      const existing = data.leads.find((lead) => (
        lead.campaignId === campaign.id && lead.instagramUserId === comment.instagramUserId
      ));

      if (existing?.messageStatus === "sent") {
        return { skipped: true, reason: "already_sent", lead: existing };
      }

      const lead = existing || {
        id: createId("lead"),
        accountId: account.id,
        campaignId: campaign.id,
        instagramUserId: comment.instagramUserId,
        username: comment.username,
        email: "",
        followerStatus: "unknown",
        deliveryLink: campaign.deliveryLink,
        messageStatus: "pending",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };

      lead.commentId = comment.commentId;
      lead.commentText = comment.text;
      lead.mediaId = comment.mediaId;
      lead.updatedAt = nowIso();

      if (!existing) data.leads.unshift(lead);

      data.events.unshift({
        id: createId("evt"),
        accountId: account.id,
        type: "comment_matched",
        campaignId: campaign.id,
        leadId: lead.id,
        payload: comment,
        createdAt: nowIso()
      });

      return { skipped: false, lead };
    });

    if (result.skipped) {
      results.push(result);
      continue;
    }

    try {
      const message = renderMessage(campaign.messageTemplate, result.lead);
      const metaResponse = await sendPrivateReply({ commentId: comment.commentId, message, account });
      let commentReplyResponse = null;
      let commentReplyError = null;
      try {
        const publicReply = renderPublicReply(campaign.commentReplyTemplate, result.lead);
        commentReplyResponse = await replyToComment({ commentId: comment.commentId, message: publicReply, account });
      } catch (error) {
        commentReplyError = error.message;
      }

      await mutateStore(async (data) => {
        const lead = data.leads.find((item) => item.id === result.lead.id);
        lead.messageStatus = "sent";
        lead.metaResponse = metaResponse;
        lead.commentReplyStatus = commentReplyError ? "failed" : "sent";
        lead.commentReplyResponse = commentReplyResponse;
        lead.commentReplyError = commentReplyError || "";
        lead.updatedAt = nowIso();
        data.events.unshift({
          id: createId("evt"),
          accountId: account.id,
          type: "message_sent",
          campaignId: campaign.id,
          leadId: lead.id,
          payload: metaResponse,
          createdAt: nowIso()
        });
        data.events.unshift({
          id: createId("evt"),
          accountId: account.id,
          type: commentReplyError ? "comment_reply_failed" : "comment_reply_sent",
          campaignId: campaign.id,
          leadId: lead.id,
          payload: commentReplyError ? { error: commentReplyError } : commentReplyResponse,
          createdAt: nowIso()
        });
      });
      results.push({ sent: true, commentReplied: !commentReplyError, commentReplyError, leadId: result.lead.id });
    } catch (error) {
      await mutateStore(async (data) => {
        const lead = data.leads.find((item) => item.id === result.lead.id);
        lead.messageStatus = "failed";
        lead.error = error.message;
        lead.updatedAt = nowIso();
        data.events.unshift({
          id: createId("evt"),
          accountId: account.id,
          type: "message_failed",
          campaignId: campaign.id,
          leadId: lead.id,
          payload: { error: error.message },
          createdAt: nowIso()
        });
      });
      results.push({ sent: false, error: error.message, leadId: result.lead.id });
    }
  }

  return results;
}

app.get("/api/debug", requireAdmin, (_req, res) => {
  res.json({
    storeBackend,
    hasUpstashUrl: !!(process.env.UPSTASH_REDIS_REST_URL || "").trim(),
    hasUpstashToken: !!(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim(),
    hasKvUrl: !!(process.env.KV_REST_API_URL || "").trim(),
    hasKvToken: !!(process.env.KV_REST_API_TOKEN || "").trim(),
    upstashUrlPrefix: (process.env.UPSTASH_REDIS_REST_URL || "").slice(0, 30) || null,
    isVercel: !!process.env.VERCEL
  });
});

app.get("/api/me", async (req, res) => {
  const account = await loadAccount(req);
  if (!account) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  res.json({ account: publicAccount(account) });
});

app.get("/api/state", requireAuth, async (req, res) => {
  const data = await readStore();
  const accountId = req.account.id;
  res.json({
    account: publicAccount(req.account),
    campaigns: data.campaigns.filter((c) => c.accountId === accountId),
    leads: data.leads.filter((l) => l.accountId === accountId),
    status: {
      dryRun: getMetaConfigStatus().dryRun,
      connected: !!req.account.igUserId,
      username: req.account.username,
      pageName: req.account.pageName,
      pageSubscribed: !!req.account.pageSubscribed
    }
  });
});

app.get("/api/config", requireAdmin, async (_req, res) => {
  res.json(getMetaConfigStatus());
});

app.get("/api/meta/check", requireAdmin, async (_req, res) => {
  res.json(await checkMetaConnection());
});

app.get("/api/meta/diagnose", requireAdmin, async (_req, res) => {
  try {
    res.json(await diagnoseWebhookSetup());
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/setup/token", async (req, res) => {
  if (process.env.VERCEL) {
    res.status(403).json({ error: "Set META_ACCESS_TOKEN in Vercel environment variables." });
    return;
  }

  const token = String(req.body.accessToken || "").trim();
  if (!token) {
    res.status(400).json({ error: "accessToken is required." });
    return;
  }

  await upsertEnvValues({ META_ACCESS_TOKEN: token });
  res.json({ saved: true });
});

app.post("/api/setup/instagram-user", async (req, res) => {
  if (process.env.VERCEL) {
    res.status(403).json({ error: "Set IG_USER_ID in Vercel environment variables." });
    return;
  }

  const igUserId = String(req.body.igUserId || "").trim();
  if (!igUserId) {
    res.status(400).json({ error: "igUserId is required." });
    return;
  }

  await upsertEnvValues({ IG_USER_ID: igUserId });
  process.env.IG_USER_ID = igUserId;
  res.json({ saved: true });
});

app.get("/api/setup/discover-instagram", requireAdmin, async (_req, res) => {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    res.status(400).json({ error: "META_ACCESS_TOKEN is not saved yet." });
    return;
  }

  const version = process.env.GRAPH_VERSION || "v25.0";
  const pagesResponse = await fetch(`https://graph.facebook.com/${version}/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${token}`);
  const pagesBody = await pagesResponse.json().catch(() => ({}));
  if (!pagesResponse.ok) {
    res.status(400).json({ error: pagesBody.error?.message || "Unable to discover Instagram accounts.", details: pagesBody });
    return;
  }

  const accounts = (pagesBody.data || [])
    .filter((page) => page.instagram_business_account)
    .map((page) => ({
      pageId: page.id,
      pageName: page.name,
      igUserId: page.instagram_business_account.id,
      username: page.instagram_business_account.username
    }));

  if (accounts.length === 1) {
    await upsertEnvValues({ IG_USER_ID: accounts[0].igUserId });
    process.env.IG_USER_ID = accounts[0].igUserId;
  }

  res.json({ accounts, autoSaved: accounts.length === 1 });
});

async function upsertEnvValues(values) {
  const envPath = ".env";
  let current = "";
  try {
    current = await fs.readFile(envPath, "utf8");
  } catch {
    current = "";
  }

  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    current = pattern.test(current)
      ? current.replace(pattern, line)
      : `${current.trimEnd()}\n${line}\n`;
  }

  await fs.writeFile(envPath, current.trimEnd() + "\n");
}

app.post("/api/campaigns", requireAuth, async (req, res) => {
  const keywords = normalizeKeywords(req.body.keywords);
  const deliveryLink = String(req.body.deliveryLink || "").trim();

  if (!keywords.length || !deliveryLink) {
    res.status(400).json({ error: "At least one keyword and a delivery link are required." });
    return;
  }

  // Accept a post URL or shortcode in the media field and resolve it to the
  // numeric media id that comment webhooks carry (scoped to this customer's IG).
  const media = await resolveMediaId(req.body.mediaId, req.account);

  const campaign = {
    id: createId("cmp"),
    accountId: req.account.id,
    name: String(req.body.name || "Untitled campaign").trim(),
    mediaId: media.mediaId,
    keywords,
    deliveryLink,
    messageTemplate: String(req.body.messageTemplate || "Here is the link: {{link}}\n\nWant us to save your email too? {{capture_url}}").trim(),
    commentReplyTemplate: String(req.body.commentReplyTemplate || "Sent - check your DM.").trim(),
    active: req.body.active !== false,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  await mutateStore(async (data) => {
    data.campaigns.unshift(campaign);
  });
  res.status(201).json({ ...campaign, warning: media.warning });
});

app.patch("/api/campaigns/:id", requireAuth, async (req, res) => {
  // Resolve media outside the store mutation (it makes network calls).
  let media = null;
  if (req.body.mediaId !== undefined) {
    media = await resolveMediaId(req.body.mediaId, req.account);
  }

  const updated = await mutateStore(async (data) => {
    const campaign = data.campaigns.find((item) => item.id === req.params.id && item.accountId === req.account.id);
    if (!campaign) return null;
    if ("active" in req.body) campaign.active = Boolean(req.body.active);
    if (typeof req.body.name === "string" && req.body.name.trim()) campaign.name = req.body.name.trim();
    if (typeof req.body.keywords === "string") campaign.keywords = normalizeKeywords(req.body.keywords);
    if (typeof req.body.deliveryLink === "string" && req.body.deliveryLink.trim()) campaign.deliveryLink = req.body.deliveryLink.trim();
    if (typeof req.body.messageTemplate === "string") campaign.messageTemplate = req.body.messageTemplate;
    if (typeof req.body.commentReplyTemplate === "string") campaign.commentReplyTemplate = req.body.commentReplyTemplate.trim();
    if (media) campaign.mediaId = media.mediaId;
    campaign.updatedAt = nowIso();
    return campaign;
  });
  if (!updated) {
    res.status(404).json({ error: "Campaign not found." });
    return;
  }
  res.json({ ...updated, warning: media?.warning });
});

app.delete("/api/campaigns/:id", requireAuth, async (req, res) => {
  const removed = await mutateStore(async (data) => {
    const index = data.campaigns.findIndex((item) => item.id === req.params.id && item.accountId === req.account.id);
    if (index === -1) return null;
    return data.campaigns.splice(index, 1)[0];
  });
  if (!removed) {
    res.status(404).json({ error: "Campaign not found." });
    return;
  }
  res.json({ deleted: true, id: removed.id });
});

app.patch("/api/leads/:id", requireAuth, async (req, res) => {
  const updated = await mutateStore(async (data) => {
    const lead = data.leads.find((item) => item.id === req.params.id && item.accountId === req.account.id);
    if (!lead) return null;
    if (req.body.email !== undefined) lead.email = String(req.body.email || "").trim();
    if (req.body.followerStatus) lead.followerStatus = String(req.body.followerStatus);
    lead.updatedAt = nowIso();
    return lead;
  });
  if (!updated) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  res.json(updated);
});

app.delete("/api/leads/:id", requireAuth, async (req, res) => {
  const removed = await mutateStore(async (data) => {
    const index = data.leads.findIndex((item) => item.id === req.params.id && item.accountId === req.account.id);
    if (index === -1) return null;
    return data.leads.splice(index, 1)[0];
  });
  if (!removed) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  res.json({ deleted: true, id: removed.id });
});

app.get("/api/leads/export.csv", requireAuth, async (req, res) => {
  const data = await readStore();
  const rows = data.leads.filter((l) => l.accountId === req.account.id);
  const headers = ["username", "email", "followerStatus", "messageStatus", "commentText", "createdAt", "updatedAt"];
  const escapeCsv = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = [headers.join(",")];
  for (const l of rows) lines.push(headers.map((h) => escapeCsv(l[h])).join(","));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="instalinkr-leads.csv"`);
  res.send(lines.join("\n"));
});

// Per-account dashboard analytics.
app.get("/api/stats", requireAuth, async (req, res) => {
  const data = await readStore();
  const id = req.account.id;
  const campaigns = data.campaigns.filter((c) => c.accountId === id);
  const leads = data.leads.filter((l) => l.accountId === id);
  res.json({
    campaigns: campaigns.length,
    activeCampaigns: campaigns.filter((c) => c.active).length,
    leads: leads.length,
    sent: leads.filter((l) => l.messageStatus === "sent").length,
    failed: leads.filter((l) => l.messageStatus === "failed").length,
    emailsCaptured: leads.filter((l) => l.email).length
  });
});

// ---- Account settings --------------------------------------------------
app.patch("/api/account", requireAuth, async (req, res) => {
  const updated = await mutateStore(async (data) => {
    const account = data.accounts.find((a) => a.id === req.account.id);
    if (!account) return null;
    if (typeof req.body.defaultMessage === "string") account.defaultMessage = req.body.defaultMessage;
    if (typeof req.body.displayName === "string" && req.body.displayName.trim()) account.name = req.body.displayName.trim();
    account.updatedAt = nowIso();
    return account;
  });
  res.json({ account: publicAccount(updated), defaultMessage: updated?.defaultMessage || "" });
});

// Customer deletes their own account + all their data.
app.delete("/api/account", requireAuth, async (req, res) => {
  const id = req.account.id;
  await mutateStore(async (data) => {
    data.campaigns = data.campaigns.filter((c) => c.accountId !== id);
    data.leads = data.leads.filter((l) => l.accountId !== id);
    data.events = data.events.filter((e) => e.accountId !== id);
    data.accounts = data.accounts.filter((a) => a.id !== id);
  });
  clearSessionCookie(res);
  res.json({ deleted: true });
});

// ---- Admin -------------------------------------------------------------
app.get("/api/admin/accounts", requireAdmin, async (_req, res) => {
  const data = await readStore();
  const summary = data.accounts.map((a) => ({
    ...publicAccount(a),
    suspended: !!a.suspended,
    pageSubscribed: !!a.pageSubscribed,
    campaignCount: data.campaigns.filter((c) => c.accountId === a.id).length,
    leadCount: data.leads.filter((l) => l.accountId === a.id).length
  }));
  res.json({
    totals: {
      accounts: data.accounts.length,
      campaigns: data.campaigns.length,
      leads: data.leads.length,
      sent: data.leads.filter((l) => l.messageStatus === "sent").length
    },
    accounts: summary
  });
});

app.get("/api/admin/accounts/:id", requireAdmin, async (req, res) => {
  const data = await readStore();
  const account = data.accounts.find((a) => a.id === req.params.id);
  if (!account) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  res.json({
    account: { ...publicAccount(account), suspended: !!account.suspended, pageSubscribed: !!account.pageSubscribed, pageId: account.pageId },
    campaigns: data.campaigns.filter((c) => c.accountId === account.id),
    leads: data.leads.filter((l) => l.accountId === account.id).slice(0, 50)
  });
});

app.patch("/api/admin/accounts/:id", requireAdmin, async (req, res) => {
  const updated = await mutateStore(async (data) => {
    const account = data.accounts.find((a) => a.id === req.params.id);
    if (!account) return null;
    if ("suspended" in req.body) account.suspended = Boolean(req.body.suspended);
    account.updatedAt = nowIso();
    return account;
  });
  if (!updated) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  res.json({ account: { ...publicAccount(updated), suspended: !!updated.suspended } });
});

// System health for the admin console (reuses the Meta diagnostic).
app.get("/api/admin/health", requireAdmin, async (_req, res) => {
  try {
    const diag = await diagnoseWebhookSetup();
    res.json({ storeBackend, dryRun: getMetaConfigStatus().dryRun, diagnostic: diag });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/webhooks/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    res.status(200).send(challenge);
    return;
  }

  res.sendStatus(403);
});

app.get("/api/webhook-test-url", (_req, res) => {
  const token = encodeURIComponent(process.env.META_VERIFY_TOKEN || "change-me");
  res.json({
    url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=test_challenge`,
    expectedResponse: process.env.META_VERIFY_TOKEN ? "test_challenge" : "403 until META_VERIFY_TOKEN is set"
  });
});

app.post("/webhooks/meta", async (req, res) => {
  if (!verifyMetaSignature(req)) {
    res.sendStatus(403);
    return;
  }

  console.log("[webhook] RAW payload:", JSON.stringify(req.body));
  const comments = commentEventsFromWebhook(req.body);
  console.log(`[webhook] Parsed ${comments.length} comment event(s):`, JSON.stringify(comments));

  const accounts = (await readStore()).accounts;
  const processed = [];
  for (const comment of comments) {
    // Route the comment to the customer whose IG account received it.
    const account = accounts.find((a) => a.igUserId === comment.recipientIgId) || null;
    let results;
    try {
      results = await processComment(comment, account);
    } catch (error) {
      results = [{ error: error.message }];
    }
    console.log(`[webhook] Comment "${comment.text}" from @${comment.username} -> account=${account?.username || "none"}`, JSON.stringify(results));
    processed.push({ comment, results });
  }

  res.json({ received: true, processed });
});

app.post("/api/test-comment", requireAuth, async (req, res) => {
  const comment = {
    commentId: createId("comment"),
    text: String(req.body.text || ""),
    mediaId: String(req.body.mediaId || ""),
    instagramUserId: String(req.body.instagramUserId || "test_user"),
    username: String(req.body.username || "test_user"),
    receivedAt: nowIso()
  };
  res.json({ comment, results: await processComment(comment, req.account) });
});

app.post("/api/poll-comments", requireAuth, async (req, res) => {
  if (!req.account.igUserId || !req.account.accessToken) {
    res.status(400).json({ error: "Connect an Instagram professional account before polling comments." });
    return;
  }

  try {
    const comments = await fetchRecentInstagramComments(req.account);
    const processed = [];
    for (const comment of comments) {
      processed.push({ comment, results: await processComment(comment, req.account) });
    }
    res.json({ checked: comments.length, processed });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/review/live-comments", requireAuth, async (req, res) => {
  if (!req.account.igUserId || !req.account.accessToken) {
    res.status(400).json({ error: "Connect an Instagram professional account before reading live comments." });
    return;
  }

  try {
    const mediaLimit = Math.min(Math.max(Number(req.query.mediaLimit || 10), 1), 25);
    const commentLimit = Math.min(Math.max(Number(req.query.commentLimit || 25), 1), 50);
    const comments = await fetchRecentInstagramComments(req.account, { mediaLimit, commentLimit });
    res.json({
      ok: true,
      source: "meta_graph_api",
      fetchedAt: nowIso(),
      instagram: {
        igUserId: req.account.igUserId,
        username: req.account.username || "",
        pageId: req.account.pageId || "",
        pageName: req.account.pageName || ""
      },
      checked: comments.length,
      comments: comments.slice(0, 50)
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/review-test/private-reply", requireAuth, async (req, res) => {
  const commentId = String(req.body.commentId || "").trim();
  const message = String(req.body.message || "").trim();

  if (!req.account.igUserId || !req.account.accessToken) {
    res.status(400).json({ error: "Connect an Instagram professional account before sending a review test reply." });
    return;
  }
  if (!commentId || !message) {
    res.status(400).json({ error: "A real Instagram comment ID and message are required." });
    return;
  }

  try {
    const sentAt = nowIso();
    const metaResponse = await sendPrivateReply({ commentId, message, account: req.account });
    const successState = {
      status: "sent",
      mode: getMetaConfigStatus().dryRun ? "dry_run" : "live_meta_api",
      sentAt,
      commentId,
      instagram: {
        igUserId: req.account.igUserId,
        username: req.account.username || "",
        pageId: req.account.pageId || "",
        pageName: req.account.pageName || ""
      },
      metaResponse
    };
    await mutateStore(async (data) => {
      data.events.unshift({
        id: createId("evt"),
        accountId: req.account.id,
        type: "review_private_reply_sent",
        payload: { commentId, message, successState },
        createdAt: nowIso()
      });
    });
    res.json({ sent: true, successState, metaResponse });
  } catch (error) {
    await mutateStore(async (data) => {
      data.events.unshift({
        id: createId("evt"),
        accountId: req.account.id,
        type: "review_private_reply_failed",
        payload: { commentId, message, error: error.message },
        createdAt: nowIso()
      });
    });
    res.status(502).json({ error: error.message });
  }
});

app.get("/capture/:leadId", async (req, res) => {
  const data = await readStore();
  const lead = data.leads.find((item) => item.id === req.params.leadId);
  if (!lead) {
    res.status(404).send("Lead not found.");
    return;
  }

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Save your email</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="capture-page">
  <main class="capture-shell">
    <h1>Your link is ready</h1>
    <a class="primary-link" href="${safeUrl(lead.deliveryLink)}">Open link</a>
    <form method="post" action="/capture/${encodeURIComponent(lead.id)}">
      <label>Email
        <input name="email" type="email" placeholder="you@example.com" value="${escapeHtml(lead.email || "")}" required>
      </label>
      <label class="checkbox-row">
        <input name="followerStatus" type="checkbox" value="self_reported">
        I followed the account
      </label>
      <button type="submit">Save</button>
    </form>
  </main>
</body>
</html>`);
});

// ---- Auth: shared helpers ----------------------------------------------
function newAccountId() { return createId("usr"); }

app.get("/api/auth/methods", (_req, res) => {
  res.json(getAuthMethods());
});

// ---- Auth: email + password --------------------------------------------
app.post("/api/auth/signup", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").toLowerCase().trim();
  const password = String(req.body.password || "");
  if (!isValidEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  const result = await mutateStore(async (data) => {
    if (data.accounts.find((a) => a.email === email)) return { error: "An account with this email already exists." };
    const account = {
      id: newAccountId(),
      name: name || email.split("@")[0],
      email,
      passwordHash: hashPassword(password),
      role: email === adminEmail() ? "admin" : "customer",
      createdAt: nowIso(),
      lastActiveAt: nowIso()
    };
    data.accounts.unshift(account);
    return { account };
  });
  if (result.error) return res.status(409).json({ error: result.error });
  setSessionCookie(res, result.account.id);
  res.json({ account: publicAccount(result.account) });
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const password = String(req.body.password || "");
  const data = await readStore();
  const account = data.accounts.find((a) => a.email === email);
  if (!account || !verifyPassword(password, account.passwordHash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  if (account.suspended) return res.status(403).json({ error: "Your account has been suspended." });
  await mutateStore(async (d) => { const a = d.accounts.find((x) => x.id === account.id); if (a) a.lastActiveAt = nowIso(); });
  setSessionCookie(res, account.id);
  res.json({ account: publicAccount(account) });
});

// ---- Auth: Google ------------------------------------------------------
app.get("/auth/google", (_req, res) => {
  if (!getAuthMethods().google) return loginError(res, "Google sign-in is not configured yet.");
  res.redirect(getGoogleLoginUrl(makeOAuthState()));
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || !verifyOAuthState(String(state))) return loginError(res, "Invalid Google sign-in. Please try again.");
  try {
    const profile = await exchangeGoogleCode(String(code));
    const account = await mutateStore(async (data) => {
      let acc = data.accounts.find((a) => a.googleId === profile.googleId)
        || (profile.email && data.accounts.find((a) => a.email === profile.email));
      if (!acc) {
        acc = { id: newAccountId(), createdAt: nowIso(), role: profile.email === adminEmail() ? "admin" : "customer" };
        data.accounts.unshift(acc);
      }
      acc.googleId = profile.googleId;
      acc.email = acc.email || profile.email;
      acc.name = acc.name || profile.name;
      acc.lastActiveAt = nowIso();
      return acc;
    });
    setSessionCookie(res, account.id);
    res.redirect("/dashboard");
  } catch (error) {
    loginError(res, error.message);
  }
});

// ---- Auth: phone OTP ---------------------------------------------------
app.post("/api/auth/phone/start", async (req, res) => {
  if (!getAuthMethods().phone) return res.status(400).json({ error: "Phone sign-in is not configured." });
  const phone = String(req.body.phone || "").replace(/[^\d+]/g, "");
  if (phone.length < 8) return res.status(400).json({ error: "Enter a valid phone number with country code." });
  const code = makeOtp();
  await mutateStore(async (data) => {
    data.otps = (data.otps || []).filter((o) => o.phone !== phone);
    data.otps.unshift({ phone, hash: hashOtp(code), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });
  });
  let devCode;
  try {
    const sent = await sendSms(phone, `Your InstaLinkr code is ${code}`);
    if (sent.dev && process.env.ALLOW_DEV_OTP === "true") devCode = code;
  } catch (e) {
    return res.status(502).json({ error: "Could not send the code. Try again." });
  }
  res.json({ sent: true, devCode });
});

app.post("/api/auth/phone/verify", async (req, res) => {
  const phone = String(req.body.phone || "").replace(/[^\d+]/g, "");
  const code = String(req.body.code || "").trim();
  const result = await mutateStore(async (data) => {
    data.otps = data.otps || [];
    const otp = data.otps.find((o) => o.phone === phone);
    if (!otp) return { error: "Request a new code." };
    if (Date.now() > otp.expiresAt) return { error: "Code expired. Request a new one." };
    if (otp.attempts >= 5) return { error: "Too many attempts. Request a new code." };
    otp.attempts += 1;
    if (otp.hash !== hashOtp(code)) return { error: "Incorrect code." };
    data.otps = data.otps.filter((o) => o.phone !== phone);
    let acc = data.accounts.find((a) => a.phone === phone);
    if (!acc) {
      acc = { id: newAccountId(), phone, name: phone, role: "customer", createdAt: nowIso() };
      data.accounts.unshift(acc);
    }
    acc.lastActiveAt = nowIso();
    return { account: acc };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  setSessionCookie(res, result.account.id);
  res.json({ account: publicAccount(result.account) });
});

// ---- Auth: Continue with Facebook (login OR in-app connect) -------------
app.get("/auth/facebook", async (req, res) => {
  const account = await loadAccount(req);
  // If already signed in, this is an in-app "Connect Instagram" action.
  res.redirect(getLoginUrl(makeOAuthState(account ? "connect" : "")));
});

app.get("/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.redirect("/login");
});

function loginError(res, message) {
  res.status(400).send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in problem</title>
<link rel="stylesheet" href="/styles.css"></head><body class="capture-page"><main class="capture-shell">
<h1>Couldn't connect</h1><p>${escapeHtml(message)}</p>
<a class="primary-link" href="/login">Back to sign in</a></main></body></html>`);
}

app.get("/oauth/callback", async (req, res) => {
  const { code, state, error_description: errDesc } = req.query;
  if (errDesc) return loginError(res, String(errDesc));
  if (!code) return loginError(res, "No authorization code was returned by Facebook.");
  const parsed = state ? verifyOAuthState(String(state)) : null;
  if (!parsed) return loginError(res, "Invalid sign-in state. Please try again.");

  const sessionAccount = await loadAccount(req);
  const isConnect = parsed.payload === "connect" && !!sessionAccount;

  try {
    const token = await exchangeCodeForToken(String(code));
    const profile = await fetchAccountProfile(token);

    if (!profile.igUserId || !profile.pageId) {
      return loginError(res, "No Instagram Business account linked to a Facebook Page was found. In Instagram, connect your professional account to a Facebook Page, then try again.");
    }

    // Subscribe the customer's Page so their comments reach our webhook.
    let subscription = { ok: false };
    if (profile.pageToken) {
      subscription = await subscribePageToApp(profile.pageId, profile.pageToken).catch(() => ({ ok: false }));
    }

    const targetId = await mutateStore(async (data) => {
      let account;
      if (isConnect) {
        account = data.accounts.find((a) => a.id === sessionAccount.id);
      } else {
        // FB used as a login method: find by IG, else create a fresh account.
        account = data.accounts.find((a) => a.igUserId === profile.igUserId);
        if (!account) {
          account = { id: account?.id || (profile.igUserId === adminIgId() ? profile.igUserId : newAccountId()), createdAt: nowIso() };
          data.accounts.unshift(account);
        }
      }
      if (!account) return null;
      account.igUserId = profile.igUserId;
      account.username = profile.igUsername;
      account.name = account.name || profile.name;
      account.fbUserId = profile.fbUserId;
      account.pageId = profile.pageId;
      account.pageName = profile.pageName;
      account.accessToken = profile.pageToken || token;
      account.userToken = token;
      account.pageSubscribed = subscription.ok;
      if (account.igUserId === adminIgId()) account.role = "admin";
      account.role = account.role || "customer";
      account.lastActiveAt = nowIso();
      return account.id;
    });

    if (!targetId) return loginError(res, "Could not link the Instagram account. Please try again.");
    if (!isConnect) setSessionCookie(res, targetId);
    res.redirect("/dashboard");
  } catch (error) {
    console.error("[oauth] callback failed:", error.message);
    loginError(res, error.message || "Sign-in failed. Please try again.");
  }
});

// ---- Page routes (auth-gated) ------------------------------------------
app.get("/", async (req, res) => {
  const account = await loadAccount(req);
  res.redirect(account ? "/dashboard" : "/login");
});

app.get("/login", async (req, res) => {
  const account = await loadAccount(req);
  if (account) return res.redirect("/dashboard");
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

app.get("/dashboard", async (req, res) => {
  const account = await loadAccount(req);
  if (!account) return res.redirect("/login");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/admin", async (req, res) => {
  const account = await loadAccount(req);
  if (!isAdmin(account)) return res.redirect(account ? "/dashboard" : "/login");
  // Same single-page shell; the client router opens the admin view.
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.post("/capture/:leadId", async (req, res) => {
  await mutateStore(async (data) => {
    const lead = data.leads.find((item) => item.id === req.params.leadId);
    if (!lead) return;
    lead.email = String(req.body.email || "").trim();
    lead.followerStatus = req.body.followerStatus === "self_reported" ? "self_reported" : lead.followerStatus;
    lead.updatedAt = nowIso();
    data.events.unshift({
      id: createId("evt"),
      type: "email_captured",
      campaignId: lead.campaignId,
      leadId: lead.id,
      payload: { email: lead.email, followerStatus: lead.followerStatus },
      createdAt: nowIso()
    });
  });
  res.redirect(`/capture/${req.params.leadId}?saved=1`);
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Instagram funnel app running at http://localhost:${port}`);
  });
}

export default app;
