# Instagram Comment-to-DM Funnel

Small starter application for sending an official Instagram private reply when someone comments a trigger word on your Instagram post or reel.

## What it does

- Receives Instagram comment webhooks from Meta.
- Matches comments against active campaigns and trigger keywords.
- Sends a private reply through the Instagram Messaging API.
- Tracks leads, comments, message attempts, email capture, and follower status.
- Provides a simple dashboard for campaigns and leads.

## Important API limits

Instagram can send a private reply to a commenter through the official API, but the app must use a Professional Instagram account, approved permissions, and a Meta webhook. Official APIs do not provide a reliable full follower list for checking whether one exact commenter follows you, so this app stores follower status as `unknown`, `self_reported`, or `verified_manually`.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your Meta values.

3. Start locally:

   ```bash
   npm run dev
   ```

4. Expose your local server with a public HTTPS URL for Meta webhooks.

5. In Meta App Dashboard, point the webhook callback to:

   ```text
   https://your-public-domain.example/webhooks/meta
   ```

## Meta permissions you will likely need

- `instagram_business_manage_messages`
- `instagram_business_manage_comments`
- `instagram_business_basic`

Depending on your login setup, Meta may show equivalent Facebook Login permissions such as `instagram_basic`, `instagram_manage_comments`, `pages_show_list`, and `pages_read_engagement`.

## Testing with a real Instagram account

You cannot test the official API with a personal Instagram account. Convert the account to Creator or Business first, then connect it to your Meta app.

For real sends:

1. Set `DRY_RUN=false`.
2. Set `PUBLIC_BASE_URL` to your public HTTPS app URL.
3. Set `META_ACCESS_TOKEN` and `IG_USER_ID`.
4. Add the dashboard's webhook URL in Meta App Dashboard.
5. Click **Check Meta** in the app. It should return `ok: true`.

## OAuth setup shortcut

Once `META_APP_ID` and `PUBLIC_BASE_URL` are set, the dashboard shows **Connect Instagram**. Before using it, the exact callback URL shown by the app must be added to Meta:

- App Settings > Basic > App Domains
- Facebook Login > Settings > Valid OAuth Redirect URIs

Callback format:

```text
https://your-public-domain.example/oauth/callback
```

If **Check Meta** fails, the returned message is the next thing to fix: usually token permissions, wrong Instagram user ID, expired token, or using a personal account.
