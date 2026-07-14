// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
let me = null;
let commentPollTimer = null;
let commentPollBusy = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("Not signed in."); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function fmtDate(v) { return v ? new Date(v).toLocaleString() : "-"; }
function fmtShort(v) { return v ? new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "-"; }

function toast(message, type = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.classList.add("show"); }, 10);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 250); }, 3200);
}

function openModal(title, bodyHtml, footerHtml = "") {
  $("#modalRoot").innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="icon-btn" data-close aria-label="Close">x</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footerHtml ? `<div class="modal-foot">${footerHtml}</div>` : ""}
      </div>
    </div>`;
  const overlay = $("#overlay");
  overlay.addEventListener("click", (e) => { if (e.target === overlay || e.target.closest("[data-close]")) closeModal(); });
}
function closeModal() { $("#modalRoot").innerHTML = ""; }

function setHeader(title, sub = "", actionsHtml = "") {
  $("#pageTitle").textContent = title;
  $("#pageSub").textContent = sub;
  $("#pageActions").innerHTML = actionsHtml;
}

function spinner() { return `<div class="loading"><div class="spin"></div></div>`; }
function empty(icon, title, sub, cta = "") {
  return `<div class="empty"><div class="empty-ico">${icon}</div><h3>${esc(title)}</h3><p>${esc(sub)}</p>${cta}</div>`;
}
function jsonBlock(value) {
  return `<pre class="result-json">${esc(JSON.stringify(value, null, 2))}</pre>`;
}
function resultPanel(title, value, type = "ok") {
  return `<div class="result-box ${type}"><strong>${esc(title)}</strong>${jsonBlock(value)}</div>`;
}

function stopCommentPolling() {
  if (commentPollTimer) clearInterval(commentPollTimer);
  commentPollTimer = null;
}

async function pollComments({ showToast = false, refresh = false } = {}) {
  if (commentPollBusy) return;
  commentPollBusy = true;
  try {
    const result = await api("/api/poll-comments", { method: "POST", body: "{}" });
    const actionable = (result.processed || []).filter((item) =>
      (item.results || []).some((r) => !r.skipped)
    );
    const sent = actionable.filter((item) => (item.results || []).some((r) => r.sent));
    if (sent.length) {
      toast(`${sent.length} new DM${sent.length === 1 ? "" : "s"} sent`);
      if (currentRoute() === "dashboard" || currentRoute() === "leads" || refresh) render();
    } else if (showToast) {
      toast(`Checked ${result.checked || 0} recent comments`);
      if (refresh) render();
    }
  } catch (err) {
    if (showToast) toast(err.message, "err");
  } finally {
    commentPollBusy = false;
  }
}

function startCommentPolling() {
  stopCommentPolling();
  setTimeout(() => pollComments(), 700);
  commentPollTimer = setInterval(() => pollComments(), 30000);
}

// ---------- views ----------
function connectCard() {
  return `<div class="connect-card">
    <div class="connect-ico">
      <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="2" width="20" height="20" rx="6"></rect><circle cx="12" cy="12" r="4.5"></circle>
        <circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"></circle></svg>
    </div>
    <h2>Connect your Instagram</h2>
    <p>Link your Instagram Business account (via its Facebook Page) to start turning comments into DMs.</p>
    <a class="btn primary" href="/auth/facebook">Connect Instagram</a>
    <p class="muted-sm">You'll be asked to sign in with the Facebook account that manages your Instagram.</p>
  </div>`;
}

async function viewDashboard() {
  setHeader("Dashboard", "Your comment-to-DM funnel at a glance");
  view.innerHTML = spinner();
  const [stats, state] = await Promise.all([api("/api/stats"), api("/api/state")]);
  const s = state.status || {};
  if (!s.connected) { view.innerHTML = connectCard(); return; }
  setHeader("Dashboard", "Your comment-to-DM funnel at a glance",
    `<button class="btn ghost" id="pollNow">Check comments now</button>`);
  const connected = !!s.pageSubscribed;
  const recent = state.leads.slice(0, 6);

  const statCard = (label, value, accent = "") =>
    `<div class="stat-card ${accent}"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;

  view.innerHTML = `
    <div class="conn-banner ${connected ? "ok" : "warn"}">
      <span class="setup-dot ${connected ? "ok" : "warn"}"></span>
      <div>
        <strong>${connected ? "Connected & receiving comments" : "Finishing connection..."}</strong>
        <span>${s.username ? "@" + esc(s.username) : ""}${s.pageName ? " - " + esc(s.pageName) : ""}${s.dryRun ? " - DMs send after approval" : ""}</span>
      </div>
      <a class="ghost-link" href="#/settings">Manage</a>
    </div>

    <div class="stat-grid">
      ${statCard("Campaigns", stats.campaigns)}
      ${statCard("Active", stats.activeCampaigns)}
      ${statCard("Leads", stats.leads)}
      ${statCard("DMs sent", stats.sent)}
      ${statCard("Emails captured", stats.emailsCaptured)}
    </div>

    <div class="section-head"><h2>Recent leads</h2><a class="ghost-link" href="#/leads">View all</a></div>
    ${recent.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>User</th><th>Comment</th><th>Status</th><th>When</th></tr></thead>
        <tbody>${recent.map((l) => `
          <tr><td>@${esc(l.username)}</td><td>${esc(l.commentText || "")}</td>
          <td><span class="status ${esc(l.messageStatus)}">${esc(l.messageStatus)}</span></td>
          <td>${fmtShort(l.updatedAt)}</td></tr>`).join("")}</tbody>
      </table></div>` :
      empty("Leads", "No leads yet", "When someone comments your keyword, they'll show up here.",
        `<a class="btn primary" href="#/campaigns">Create a campaign</a>`)}
  `;
  $("#pollNow")?.addEventListener("click", () => pollComments({ showToast: true, refresh: true }));
  startCommentPolling();
}

async function viewCampaigns() {
  setHeader("Campaigns", "Keyword triggers that fire your DMs",
    `<button class="btn primary" id="newCampaign">+ New campaign</button>`);
  $("#newCampaign").addEventListener("click", () => campaignModal());
  view.innerHTML = spinner();
  const [state, stats] = await Promise.all([api("/api/state"), api("/api/stats").catch(() => ({}))]);
  if (!state.status?.connected) { setHeader("Campaigns", "Keyword triggers that fire your DMs"); view.innerHTML = connectCard(); return; }
  const leadsByCampaign = {};
  for (const l of state.leads) leadsByCampaign[l.campaignId] = (leadsByCampaign[l.campaignId] || 0) + 1;

  if (!state.campaigns.length) {
    view.innerHTML = empty("Campaign", "No campaigns yet", "Create your first keyword trigger to start capturing leads.",
      `<button class="btn primary" id="emptyNew">+ New campaign</button>`);
    $("#emptyNew").addEventListener("click", () => campaignModal());
    return;
  }

  view.innerHTML = `<div class="grid">${state.campaigns.map((c) => `
    <article class="card">
      <div class="card-head">
        <div>
          <h3>${esc(c.name)}</h3>
          <span class="muted-sm">${(leadsByCampaign[c.id] || 0)} leads</span>
        </div>
        <span class="pill ${c.active ? "on" : "off"}">${c.active ? "Active" : "Paused"}</span>
      </div>
      <dl>
        <dt>Keywords</dt><dd>${esc((c.keywords || []).join(", "))}</dd>
        <dt>Post</dt><dd>${c.mediaId ? esc(c.mediaId) : "Any post"}</dd>
        <dt>Link</dt><dd><a href="${esc(c.deliveryLink)}" target="_blank" rel="noreferrer">${esc(c.deliveryLink)}</a></dd>
      </dl>
      <div class="card-actions">
        <button class="btn ghost sm" data-edit="${c.id}">Edit</button>
        <button class="btn ghost sm" data-toggle="${c.id}">${c.active ? "Pause" : "Activate"}</button>
        <button class="btn danger sm" data-del="${c.id}">Delete</button>
      </div>
    </article>`).join("")}</div>`;
}

function campaignModal(existing = null) {
  const c = existing || {};
  openModal(existing ? "Edit campaign" : "New campaign", `
    <form id="cForm" class="modal-form">
      <label>Name<input name="name" value="${esc(c.name || "")}" placeholder="Reel lead magnet" required></label>
      <label>Trigger keywords<input name="keywords" value="${esc((c.keywords || []).join(", "))}" placeholder="guide, link, checklist" required>
        <small class="hint">Comma-separated. A comment containing any of these fires the DM.</small></label>
      <label>Post or reel <span class="opt">(optional)</span>
        <input name="mediaId" value="${esc(c.mediaId || "")}" placeholder="Paste post URL, or leave blank for all posts"></label>
      <label>Delivery link<input name="deliveryLink" type="url" value="${esc(c.deliveryLink || "")}" placeholder="https://..." required></label>
      <label>DM message<textarea name="messageTemplate" rows="4" placeholder="Hey {{username}}, here is the link: {{link}}">${esc(c.messageTemplate || (me?.defaultMessage) || "Hey {{username}}, here is the link: {{link}}")}</textarea>
        <small class="hint">Use {{username}}, {{link}} and {{capture_url}} as placeholders.</small></label>
      <label>Public comment reply<textarea name="commentReplyTemplate" rows="2" placeholder="Sent - check your DM.">${esc(c.commentReplyTemplate || "Sent - check your DM.")}</textarea>
        <small class="hint">Posted as a reply under the triggering comment after the DM is sent.</small></label>
    </form>`,
    `<button class="btn ghost" data-close>Cancel</button>
     <button class="btn primary" id="cSave">${existing ? "Save changes" : "Create campaign"}</button>`);

  $("#cSave").addEventListener("click", async () => {
    const form = $("#cForm");
    if (!form.reportValidity()) return;
    const payload = Object.fromEntries(new FormData(form));
    try {
      const res = existing
        ? await api(`/api/campaigns/${existing.id}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await api("/api/campaigns", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      toast(existing ? "Campaign updated" : "Campaign created");
      if (res.warning) toast(res.warning, "warn");
      render();
    } catch (e) { toast(e.message, "err"); }
  });
}

async function viewLeads() {
  setHeader("Leads", "People who triggered your campaigns",
    `<a class="btn ghost" href="/api/leads/export.csv">Export CSV</a>`);
  view.innerHTML = spinner();
  const state = await api("/api/state");
  const all = state.leads;

  view.innerHTML = `
    <div class="toolbar">
      <input id="leadSearch" class="search" placeholder="Search user or comment...">
      <select id="leadFilter" class="search">
        <option value="">All statuses</option>
        <option value="sent">Sent</option>
        <option value="failed">Failed</option>
        <option value="pending">Pending</option>
      </select>
    </div>
    <div class="table-wrap" id="leadTableWrap"></div>`;

  function renderRows() {
    const q = $("#leadSearch").value.toLowerCase();
    const f = $("#leadFilter").value;
    const rows = all.filter((l) =>
      (!f || l.messageStatus === f) &&
      (!q || (l.username || "").toLowerCase().includes(q) || (l.commentText || "").toLowerCase().includes(q)));
    if (!rows.length) {
      $("#leadTableWrap").innerHTML = empty("Leads", "No matching leads", "Try a different search or filter.");
      return;
    }
    $("#leadTableWrap").innerHTML = `<table>
      <thead><tr><th>User</th><th>Email</th><th>Follower</th><th>DM</th><th>Comment reply</th><th>Comment</th><th>Updated</th><th></th></tr></thead>
      <tbody>${rows.map((l) => `<tr>
        <td>@${esc(l.username)}</td>
        <td><input class="cell-input" data-email="${l.id}" value="${esc(l.email || "")}" placeholder="Add email"></td>
        <td><select class="cell-input" data-follower="${l.id}">
          ${["unknown", "self_reported", "verified_manually"].map((s) =>
            `<option value="${s}" ${l.followerStatus === s ? "selected" : ""}>${s}</option>`).join("")}
        </select></td>
        <td><span class="status ${esc(l.messageStatus)}">${esc(l.messageStatus)}</span></td>
        <td><span class="status ${esc(l.commentReplyStatus || "pending")}">${esc(l.commentReplyStatus || "-")}</span></td>
        <td>${esc(l.commentText || "")}</td>
        <td>${fmtShort(l.updatedAt)}</td>
        <td><button class="icon-btn danger" data-dellead="${l.id}" title="Delete">x</button></td>
      </tr>`).join("")}</tbody></table>`;
  }
  renderRows();
  $("#leadSearch").addEventListener("input", renderRows);
  $("#leadFilter").addEventListener("change", renderRows);
}

async function viewSettings() {
  setHeader("Settings", "Connection, defaults, and account");
  view.innerHTML = spinner();
  const state = await api("/api/state");
  const s = state.status || {};
  const a = state.account || {};

  view.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Instagram connection</h2><span class="pill ${s.pageSubscribed ? "on" : "off"}">${s.pageSubscribed ? "Live" : "Pending"}</span></div>
      <dl class="kv">
        <dt>Instagram</dt><dd>@${esc(s.username || "-")}</dd>
        <dt>Facebook Page</dt><dd>${esc(s.pageName || "-")}</dd>
        <dt>Webhook</dt><dd>${s.pageSubscribed ? "Subscribed" : "Not subscribed yet"}</dd>
        <dt>DM sending</dt><dd>${s.dryRun ? "Enabled after Meta approval" : "Live"}</dd>
      </dl>
      <a class="btn ${s.connected ? "ghost" : "primary"}" href="/auth/facebook">${s.connected ? "Reconnect Instagram" : "Connect Instagram"}</a>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Live review test</h2></div>
      <p class="muted">For Meta App Review, load recent comments from Meta, choose a real comment ID, send a private reply from this app, and show the success state here plus the delivered message in Instagram.</p>
      <div class="inline-actions">
        <button class="btn ghost" type="button" id="loadLiveComments" ${s.connected ? "" : "disabled"}>Load recent Meta comments</button>
        <button class="btn ghost" type="button" id="processLiveComments" ${s.connected ? "" : "disabled"}>Process recent comments</button>
      </div>
      <div id="liveCommentsResult"></div>
      <form id="reviewSendForm">
        <label>Instagram comment ID
          <input name="commentId" placeholder="179..." ${s.connected ? "" : "disabled"} required>
        </label>
        <label>Reply message
          <textarea name="message" rows="3" ${s.connected ? "" : "disabled"} required>Here is the guide: https://instalinkr.com</textarea>
        </label>
        <button class="btn primary" type="submit" ${s.connected ? "" : "disabled"}>Send private reply</button>
      </form>
      <div id="reviewSendResult"></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Default DM message</h2></div>
      <form id="msgForm">
        <label>Used to pre-fill new campaigns
          <textarea name="defaultMessage" rows="4" placeholder="Hey {{username}}, here is the link: {{link}}">${esc(a.defaultMessage || "")}</textarea>
          <small class="hint">Placeholders: {{username}}, {{link}}, {{capture_url}}</small>
        </label>
        <button class="btn primary" type="submit">Save default</button>
      </form>
    </div>

    <div class="panel danger-zone">
      <div class="panel-head"><h2>Danger zone</h2></div>
      <p class="muted">Delete your account and all campaigns &amp; leads. This cannot be undone.</p>
      <button class="btn danger" id="delAccount">Delete my account</button>
    </div>`;

  $("#msgForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(e.target));
    try { await api("/api/account", { method: "PATCH", body: JSON.stringify(payload) }); toast("Default message saved"); }
    catch (err) { toast(err.message, "err"); }
  });
  $("#loadLiveComments").addEventListener("click", async () => {
    const target = $("#liveCommentsResult");
    target.innerHTML = spinner();
    try {
      const result = await api("/api/review/live-comments");
      const comments = result.comments || [];
      target.innerHTML = `
        <div class="result-box ok">
          <strong>Live Meta comments loaded at ${esc(fmtDate(result.fetchedAt))}</strong>
          ${comments.length ? `<div class="comment-list">${comments.slice(0, 8).map((c) => `
            <button class="comment-choice" type="button" data-comment-choice="${esc(c.commentId)}">
              <span>@${esc(c.username || "unknown")}</span>
              <em>${esc(c.text || "")}</em>
              <small>${esc(c.commentId)}</small>
            </button>`).join("")}</div>` : `<p class="muted-sm">No recent comments were returned by Meta.</p>`}
          ${jsonBlock({ source: result.source, checked: result.checked, instagram: result.instagram })}
        </div>`;
    } catch (err) {
      target.innerHTML = resultPanel("Could not load live comments", { error: err.message }, "err");
    }
  });
  $("#processLiveComments").addEventListener("click", async () => {
    const target = $("#liveCommentsResult");
    target.innerHTML = spinner();
    try {
      const result = await api("/api/poll-comments", { method: "POST", body: "{}" });
      target.innerHTML = resultPanel("Recent comments processed", result);
    } catch (err) {
      target.innerHTML = resultPanel("Could not process comments", { error: err.message }, "err");
    }
  });
  $("#reviewSendForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(e.target));
    const target = $("#reviewSendResult");
    target.innerHTML = spinner();
    try {
      const result = await api("/api/review-test/private-reply", { method: "POST", body: JSON.stringify(payload) });
      target.innerHTML = resultPanel("Private reply result", result.successState || result);
      toast("Private reply sent. Check Instagram for the delivered message.");
    } catch (err) {
      target.innerHTML = resultPanel("Private reply failed", { error: err.message, commentId: payload.commentId }, "err");
      toast(err.message, "err");
    }
  });
  $("#delAccount").addEventListener("click", () => {
    openModal("Delete account?", `<p>This permanently deletes your account, campaigns and leads. Type <strong>DELETE</strong> to confirm.</p>
      <input id="delConfirm" class="search" placeholder="DELETE">`,
      `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="delGo">Delete forever</button>`);
    $("#delGo").addEventListener("click", async () => {
      if ($("#delConfirm").value !== "DELETE") { toast("Type DELETE to confirm", "warn"); return; }
      try { await api("/api/account", { method: "DELETE" }); location.href = "/login"; }
      catch (e) { toast(e.message, "err"); }
    });
  });
}

async function viewAdmin() {
  if (me?.role !== "admin") { location.hash = "#/dashboard"; return; }
  setHeader("Admin", "All customers and system health");
  view.innerHTML = spinner();
  const [data, health] = await Promise.all([api("/api/admin/accounts"), api("/api/admin/health").catch(() => null)]);

  const statCard = (label, value) => `<div class="stat-card"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
  const healthRows = health?.diagnostic?.checks?.map((c) =>
    `<span class="health-item ${c.ok ? "ok" : "bad"}">${c.ok ? "ok" : "bad"} ${esc(c.name)}</span>`).join("") || "";

  view.innerHTML = `
    <div class="stat-grid">
      ${statCard("Customers", data.totals.accounts)}
      ${statCard("Campaigns", data.totals.campaigns)}
      ${statCard("Leads", data.totals.leads)}
      ${statCard("DMs sent", data.totals.sent)}
    </div>
    ${health ? `<div class="panel"><div class="panel-head"><h2>System health</h2>
      <span class="pill ${health.diagnostic?.ok ? "on" : "off"}">${health.diagnostic?.ok ? "Healthy" : "Attention"}</span></div>
      <div class="health-row">${healthRows}</div>
      <p class="muted-sm">Store: ${esc(health.storeBackend)} - DM mode: ${health.dryRun ? "dry-run (pre-approval)" : "live"}</p></div>` : ""}

    <div class="panel">
      <div class="panel-head"><h2>Endpoint diagnostics</h2></div>
      <p class="muted">Run the live backend checks from the app UI so review and support sessions can show real API responses.</p>
      <div class="inline-actions">
        <button class="btn ghost" id="checkMeta">Check Meta connection</button>
        <button class="btn ghost" id="diagnoseMeta">Diagnose webhooks</button>
        <button class="btn ghost" id="showWebhookTest">Webhook verify URL</button>
        <button class="btn ghost" id="discoverInstagram">Discover Instagram account</button>
        <button class="btn ghost" id="showConfig">Config status</button>
      </div>
      <div id="adminEndpointResult"></div>
    </div>

    <div class="section-head"><h2>Customers</h2><span>${data.accounts.length}</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Customer</th><th>Instagram</th><th>Page</th><th>Webhook</th><th>Campaigns</th><th>Leads</th><th>Joined</th><th></th></tr></thead>
      <tbody>${data.accounts.map((acc) => `<tr>
        <td>${esc(acc.name || "-")} ${acc.role === "admin" ? '<em class="admin-badge sm">admin</em>' : ""} ${acc.suspended ? '<em class="admin-badge sm susp">suspended</em>' : ""}</td>
        <td>@${esc(acc.username || "-")}</td>
        <td>${esc(acc.pageName || "-")}</td>
        <td><span class="status ${acc.pageSubscribed ? "sent" : "failed"}">${acc.pageSubscribed ? "live" : "off"}</span></td>
        <td>${acc.campaignCount}</td>
        <td>${acc.leadCount}</td>
        <td>${fmtShort(acc.createdAt)}</td>
        <td><button class="btn ghost sm" data-acct="${acc.id}">View</button></td>
      </tr>`).join("")}</tbody>
    </table></div>`;

  const showAdminResult = async (title, path) => {
    const target = $("#adminEndpointResult");
    target.innerHTML = spinner();
    try {
      const result = await api(path);
      target.innerHTML = resultPanel(title, result, result.ok === false ? "warn" : "ok");
    } catch (err) {
      target.innerHTML = resultPanel(title, { error: err.message }, "err");
    }
  };
  $("#checkMeta").addEventListener("click", () => showAdminResult("Meta connection", "/api/meta/check"));
  $("#diagnoseMeta").addEventListener("click", () => showAdminResult("Webhook diagnostics", "/api/meta/diagnose"));
  $("#showWebhookTest").addEventListener("click", () => showAdminResult("Webhook verification test", "/api/webhook-test-url"));
  $("#discoverInstagram").addEventListener("click", () => showAdminResult("Instagram discovery", "/api/setup/discover-instagram"));
  $("#showConfig").addEventListener("click", () => showAdminResult("Config status", "/api/config"));
}

async function adminAccountModal(id) {
  const d = await api(`/api/admin/accounts/${id}`);
  const a = d.account;
  openModal(`@${a.username || a.name || id}`, `
    <dl class="kv">
      <dt>Name</dt><dd>${esc(a.name || "-")}</dd>
      <dt>Instagram</dt><dd>@${esc(a.username || "-")} (${esc(a.igUserId)})</dd>
      <dt>Page</dt><dd>${esc(a.pageName || "-")}</dd>
      <dt>Webhook</dt><dd>${a.pageSubscribed ? "Subscribed" : "Not subscribed"}</dd>
      <dt>Role</dt><dd>${esc(a.role)}</dd>
      <dt>Status</dt><dd>${a.suspended ? "Suspended" : "Active"}</dd>
      <dt>Campaigns</dt><dd>${d.campaigns.length}</dd>
      <dt>Leads</dt><dd>${d.leads.length}</dd>
    </dl>`,
    a.role === "admin" ? `<button class="btn ghost" data-close>Close</button>` :
    `<button class="btn ghost" data-close>Close</button>
     <button class="btn ${a.suspended ? "primary" : "danger"}" id="suspBtn">${a.suspended ? "Unsuspend" : "Suspend"}</button>`);
  const btn = $("#suspBtn");
  if (btn) btn.addEventListener("click", async () => {
    try {
      await api(`/api/admin/accounts/${id}`, { method: "PATCH", body: JSON.stringify({ suspended: !a.suspended }) });
      closeModal(); toast(a.suspended ? "Account unsuspended" : "Account suspended"); render();
    } catch (e) { toast(e.message, "err"); }
  });
}

// ---------- router ----------
const routes = {
  dashboard: viewDashboard,
  campaigns: viewCampaigns,
  leads: viewLeads,
  settings: viewSettings,
  admin: viewAdmin
};

function currentRoute() {
  const r = (location.hash.replace(/^#\//, "") || "dashboard").split("/")[0];
  return routes[r] ? r : "dashboard";
}

async function render() {
  const r = currentRoute();
  stopCommentPolling();
  document.querySelectorAll("#sideNav a").forEach((a) => a.classList.toggle("active", a.dataset.route === r));
  $("#sidebar").classList.remove("open");
  try { await routes[r](); }
  catch (e) { view.innerHTML = empty("!", "Something went wrong", e.message); }
}

// Delegated actions across views
document.addEventListener("click", async (e) => {
  const t = e.target;
  const editId = t.dataset?.edit;
  const toggleId = t.dataset?.toggle;
  const delId = t.dataset?.del;
  const delLead = t.dataset?.dellead;
  const acctId = t.dataset?.acct;
  const commentChoice = t.closest("[data-comment-choice]")?.dataset?.commentChoice;

  if (commentChoice) {
    const input = document.querySelector("#reviewSendForm input[name=commentId]");
    if (input) {
      input.value = commentChoice;
      toast("Comment ID selected");
    }
  } else if (editId) {
    const state = await api("/api/state");
    campaignModal(state.campaigns.find((c) => c.id === editId));
  } else if (toggleId) {
    const state = await api("/api/state");
    const c = state.campaigns.find((x) => x.id === toggleId);
    try { await api(`/api/campaigns/${toggleId}`, { method: "PATCH", body: JSON.stringify({ active: !c.active }) }); render(); }
    catch (err) { toast(err.message, "err"); }
  } else if (delId) {
    openModal("Delete campaign?", `<p>This deletes the campaign. Existing leads are kept.</p>`,
      `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="delGo">Delete</button>`);
    $("#delGo").addEventListener("click", async () => {
      try { await api(`/api/campaigns/${delId}`, { method: "DELETE" }); closeModal(); toast("Campaign deleted"); render(); }
      catch (err) { toast(err.message, "err"); }
    });
  } else if (delLead) {
    try { await api(`/api/leads/${delLead}`, { method: "DELETE" }); toast("Lead deleted"); render(); }
    catch (err) { toast(err.message, "err"); }
  } else if (acctId) {
    adminAccountModal(acctId);
  }
});

document.addEventListener("change", async (e) => {
  const emailId = e.target.dataset?.email;
  const followerId = e.target.dataset?.follower;
  try {
    if (emailId) await api(`/api/leads/${emailId}`, { method: "PATCH", body: JSON.stringify({ email: e.target.value }) });
    if (followerId) await api(`/api/leads/${followerId}`, { method: "PATCH", body: JSON.stringify({ followerStatus: e.target.value }) });
    if (emailId || followerId) toast("Saved");
  } catch (err) { toast(err.message, "err"); }
});

$("#menuBtn")?.addEventListener("click", () => $("#sidebar").classList.toggle("open"));
window.addEventListener("hashchange", render);

// ---------- boot ----------
(async function boot() {
  try {
    const data = await api("/api/me");
    me = data.account;
    $("#sideUser").textContent = me.username ? "@" + me.username : (me.name || "Account");
    $("#navAdmin").hidden = me.role !== "admin";
    if (!location.hash) location.hash = "#/dashboard";
    render();
  } catch { /* api() already redirects on 401 */ }
})();
