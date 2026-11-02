# Tally

Split costs with anyone: a free, simple take on shared expense apps. No sign-up,
no limits on how many expenses you add, no ads, and any currency.

- Groups with a private link: anyone with it can open the group in a browser
  (https://tally.matisseduffield.workers.dev) or in the Android app, say which
  member they are, and add expenses. Everyone sees the same balances.
- Expenses in any currency, converted into the group's currency at the live
  rate (Coinbase) when added; the rate is stored with the expense.
- Split equally, by exact amounts, by percentages or by shares.
- Your balance per group, everyone else's, and "Settle up": the fewest payments
  that square everyone (at most people − 1). Recording one is a tap.
- Works offline: groups live on the device, changes queue and sync later.
- Android app: self-updating from the public `tally-releases` repo, group links
  open in the app, the share sheet sends a group's link.

## Layout

- `web/index.html`: the whole app (HTML/CSS/JS, no build step).
- `web/lib.js`: pure logic (number parsing, splits, balances, settling),
  tested by `node --test "tests/*.test.js"`.
- `worker/worker.js`, `worker/schema.sql`: the sync server, a Cloudflare Worker
  named `tally` with a D1 database `tally` (binding `DB`). It also serves the
  web app to browsers, fetching it from `tally-releases/web/`, where every
  release publishes it.
- `app/`: the Android app, a Kotlin WebView wrapper around `web/` (bundled as
  assets), with a message bridge for Back, sharing, haptics and updates.

## The server

There are no accounts. A group's 22-character random id is its link, and
anyone holding it can read and change the group (like Tricount or Kittysplit).
Members and entries get ids on the device, so things made offline keep their
identity. `POST /api/g/:id/ops` upserts the group, members and entries
(entries are validated and stripped to known fields; deleting only marks
them) and returns the whole group; `GET /api/g/:id` answers 304 against the
group's version as an ETag, so polling is cheap. Responses send
`Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex` to keep links private.

The Worker isn't deployed by CI. To change it, edit `worker/worker.js` and
upload it as the `tally` script with the D1 binding (Cloudflare dashboard,
`wrangler deploy`, or the API). `/.well-known/assetlinks.json` carries the
release key's SHA-256 so Android verifies the app for group links.

## Releasing

Tag an annotated `v*` version; its "- " lines become the update notes:

```bash
git tag -a v1.1.0 -m "Tally 1.1.0" -m "- What changed"
git push origin v1.1.0
```

CI builds the signed APK and force-pushes it, `latest.json` and `web/` to
`tally-releases`. Download link:
https://raw.githubusercontent.com/matisseduffield/tally-releases/main/Tally.apk

Signing: `tally-release.keystore` + `keystore.properties` (untracked; backups
in `android-toolchain`, `tally-*.backup`). CI restores them from the repo
secrets `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`;
`RELEASES_DEPLOY_KEY` pushes to `tally-releases`. **Keep the keystore**:
updates must be signed with it to install over the existing app.
