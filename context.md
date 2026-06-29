# Instagram Comment DM Funnel Context

## Working Rule

From June 29, 2026 onward, every meaningful update to the app should be recorded in this file before pushing to GitHub. This includes code changes, deployment notes, Meta/Facebook app review status, environment variable changes, database/schema decisions, bug fixes, and test results.

When source code is available in a git repository, changes should be committed and pushed to GitHub so the project can be recovered if local files are lost.

The app must be moved/backed up to GitHub. This is now a required project maintenance step, not optional.

## Current Project

- App purpose: send an Instagram DM/private reply to people who comment configured keywords on an Instagram post or reel.
- Deployed app inspected: `https://instagram-comment-dm-funnel.vercel.app`
- Vercel project link shared by user: `https://vercel.com/akshit-kumars-projects-54e51a6c/instagram-comment-dm-funnel`
- Public brand observed: `InstaLinkr`
- App review status: submitted to Meta/Facebook App Review and currently waiting for approval.

## Meta OAuth Observed From Deployment

- Graph API version: `v25.0`
- Meta app id: `2642028639545238`
- OAuth callback observed: `https://instalinkr.com/oauth/callback`
- Requested scopes:
  - `public_profile`
  - `pages_show_list`
  - `pages_read_engagement`
  - `pages_manage_metadata`
  - `instagram_basic`
  - `instagram_manage_comments`
  - `instagram_manage_messages`

## Visible App Features

- Email/password authentication is enabled.
- Facebook OAuth authentication is enabled.
- Google authentication appears disabled.
- Phone OTP appears disabled.
- Dashboard shows connection status, campaigns, leads, sent DMs, captured emails, and recent leads.
- Campaigns support keywords, optional post/reel targeting, delivery links, DM templates, and public comment reply templates.
- Leads support search/filter, CSV export, email editing, follower status, DM status, comment reply status, and deletion.
- Settings include Instagram reconnect, a live review private-reply test, default DM message, and account deletion.
- Admin view includes customer list, health diagnostics, account detail, and suspend/unsuspend controls.

## Important Next Access Needed

To edit, test, commit, and push the actual app, the source repository is still needed in this workspace. Needed next:

- GitHub repository URL or source files.
- Vercel project/environment access if deployment or env var changes are required.
- Meta Developer app access only if we need to inspect review status, permissions, OAuth settings, webhook config, or app roles.

The user believes the app may currently exist only on Vercel and not in GitHub. If true, the recovery priority is to obtain the source files from the machine/account that deployed it or from any connected Vercel source/import history, then initialize a GitHub repository and push the app plus this `context.md`.

## Update Log

### 2026-06-29

- Inspected deployed app from the public URL.
- Captured visible frontend/API behavior and Meta OAuth details.
- User confirmed Meta/Facebook App Review has already been submitted and is awaiting approval.
- Added this `context.md` file as the running project memory and recovery log.
- User clarified the app may not currently be on GitHub and may only exist on Vercel. Next step is to recover/source the project files and create a GitHub backup repository.
- User requested that the app be moved/backed up to GitHub. Local checks did not find `git`, `gh`, or `vercel` on PATH, and no obvious source folder was found under Documents/Desktop/Downloads. Need source folder or Vercel access before a complete GitHub backup can be created.
- User said Vercel is open in Brave browser and asked Codex to check it. Brave is running, but it was not launched with a remote debugging port, so Codex cannot programmatically inspect the authenticated Vercel tab from the current session. Next options: user provides source files, user provides a Vercel access token, or user allows Brave to be relaunched with remote debugging enabled so the open Vercel project can be inspected.
- User connected a brand new GitHub repo to the Vercel project and asked how to get files from Vercel into GitHub. Important clarification: linking GitHub to Vercel sets up future deployments from GitHub to Vercel; it does not automatically reverse-sync existing Vercel deployment source into GitHub. Need the original source files, a Vercel deployment source download if available in the dashboard, or a careful reconstruction from public deployed assets as a fallback.
- User re-confirmed the exact Vercel project URL: `https://vercel.com/akshit-kumars-projects-54e51a6c/instagram-comment-dm-funnel`.
- Screenshots show the Vercel project is connected to GitHub repository `akshitolihan/instalinkr`. This connection will deploy future commits from GitHub to Vercel, but it does not copy the previous Vercel deployment source into the repository.
- User provided a Vercel access token for recovery. The token was used only for API calls and must not be committed or stored.
- Vercel API confirmed the canonical deployment id is `dpl_Cu6jZnzxKh5va4zQpeMMDLTMaFfh` for the UI deployment `Cu6jZnzxKh5va4zQpeMMDLTMaFfh`.
- Source recovery succeeded through Vercel's deployment file APIs:
  - `GET /v6/deployments/dpl_Cu6jZnzxKh5va4zQpeMMDLTMaFfh/files`
  - `GET /v8/deployments/dpl_Cu6jZnzxKh5va4zQpeMMDLTMaFfh/files/{fileId}`
- Recovered 18 source files into `work/recovered-instalinkr-api`, including `api/index.js`, `src/server.js`, `src/meta.js`, `src/auth.js`, `src/store.js`, `public/*`, `package.json`, `package-lock.json`, `vercel.json`, `.vercelignore`, and `README.md`.
- GitHub repository `akshitolihan/instalinkr` was checked and is empty before initial source push.
- Attempted to write the recovered source to `akshitolihan/instalinkr` using the available GitHub connector. GitHub returned `403 Resource not accessible by integration`, so Codex currently lacks write permission to that repository through the connector. Need either a GitHub personal access token with repository contents write access, GitHub app permission granted to this repo, or local git/GitHub authentication on the machine.
- User provided a GitHub personal access token for pushing the recovered source. The token must be used only for GitHub API writes, must not be committed, and should be revoked after the recovery push is complete.
- GitHub token permission check: token belongs to `akshitolihan` and can read repo metadata for `akshitolihan/instalinkr`, but GitHub rejects both Contents API writes and Git blob writes with `403 Resource not accessible by personal access token`. The token needs repository `Contents: Read and write` permission for `akshitolihan/instalinkr`.
- User provided a replacement GitHub token after selecting repository `akshitolihan/instalinkr` and permission `Contents: Read and write`. Use it only for the recovery push, do not store it, and revoke it after push verification.
