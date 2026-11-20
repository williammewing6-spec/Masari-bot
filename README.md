# مصاري — Masari Bot

Telegram microtask marketplace bot: clients post service requests, the admin
converts them into task cards with slot counters, workers execute and submit
proof, reviewers approve, wallets settle automatically (escrow, referrals,
forced channel subscription, in-bot support, full admin panel).

## Stack
- Cloudflare Worker (`src/index.js`) + D1 (schema in `schema.sql`)
- No build step. Deploy with wrangler or the Cloudflare Git integration.

## Deploy checklist
1. Create the D1 database, run `schema.sql` on it, put its id in `wrangler.toml`.
2. Set secrets/vars: `BOT_TOKEN` (secret), `WEBHOOK_SECRET` (secret), `ADMIN_ID` (var, owner's Telegram id).
3. Deploy the Worker.
4. Set the Telegram webhook to `https://<worker-domain>/webhook/<WEBHOOK_SECRET>`.
5. Owner sends /start; confirm admin panel appears.

All content (categories, tasks, prices, texts, percentages, deposit methods,
forced channels) is managed from the in-bot admin panel — nothing is hard-coded.
