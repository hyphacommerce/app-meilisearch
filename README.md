# Meilisearch for Hypha

Hypha's first-party search app (design note 0029, §9): it keeps one
[Meilisearch](https://www.meilisearch.com) index per market from Hypha's webhooks and admin
API, and answers Hypha's `search.query` extension point, so `/storefront/search` is served
by Meilisearch (typo tolerance, ranking) while prices, stock and channel visibility stay
Hypha's. It is an ordinary app: OAuth install with staff-approved scopes, signed calls, an
embedded settings page. No personal-data scopes.

One core on Web APIs (`src/core/`), two hosts:

| Host | Storage | Background work |
| --- | --- | --- |
| Cloudflare Workers (`src/hosts/worker.ts`) | D1 | `waitUntil` after webhooks and settings changes, and a cron every minute |
| Node 24 (`src/hosts/node.ts`) | SQLite (`node:sqlite`) | an interval (`RUN_INTERVAL_MS`, 2 s) |

## How it works

- **Install** (design note 0029, §4.1): an admin's "Install app" opens
  `GET <app_url>/install?api=<Hypha API base URL>`. The app starts OAuth 2.1 with PKCE
  (`createAuthorizationUrl` from `@hyphacommerce/app`; the verifier stays server-side, keyed by
  `state`) and redirects to the API's `/oauth/authorize`; the client ID is the manifest URL,
  `<app_url>/manifest.json`. A staff member approves on the admin's consent page; the
  callback (`/hypha/oauth/callback`) exchanges the code, keeps the tokens and the app secret
  (sealed with AES-256-GCM under `APP_ENCRYPTION_KEY`), keyed by the store the token
  response names (`store`), reads the store's admin origins, and queues a full build.
  Installations are keyed by store, so one deployment serves any number of Hypha stores.
  Refresh tokens rotate: `HyphaClient` refreshes inside the token store's `withLock`, here
  a lock on the installation's row in the app's database, so two isolates never reuse one
  (the one that waited reads the pair the other stored).
- **Scopes:** `products:read`, `markets:read`, `pricing:read`, `inventory:read`,
  `channels:read`: each the `x-hypha-scopes` of the admin routes it reads, and what the
  subscribed events' subjects need to be delivered.
- **Documents** (design note 0019, §3): one per variant per market, as Hypha builds its own:
  only active products in the market's catalog whose price resolves in the market's currency
  (fixed price, else the list's adjustment rounded half away from zero, else the base
  price), available when untracked, in stock at a location serving the market, or selling
  past zero. Each carries `product`, `listing` (the product split by the search settings'
  `split_by`) and `variant` keys, so a query picks its group with Meilisearch's `distinct`,
  and filters stay exact per variant ("Red" and "XL" match only a variant that is both).
  Option facets live in `opt.<hex of the lowercased option name>`, so any option name is a
  safe attribute.
- **Sync:** webhooks (`/hypha/webhooks`, `@hyphacommerce/app`'s `webhookHandler`: `Hypha-Store`
  picks the installation whose secret must sign the body, the typed envelope is parsed,
  deliveries are deduped by `Hypha-Delivery-Id`, and a failure answers 500 so Hypha
  retries) become coalesced marks, as Hypha's own search queue does. Payload IDs are
  checked to be prefixed (`prod_`, `var_`, `cat_`, `pl_`, `pcat_`); a bare UUID is refused.
  `product.*` marks the product; stock and price events mark variants (their product is
  known from the last build); catalog and price-list membership events refresh the app's
  copy of the catalog or list, then mark products; category moves mark the subtree's
  products; market, catalog, price-list, location and `split_by` changes rebuild
  everything. Steps work the marks most urgent first, each bounded (`REINDEX_BATCH`
  products), so a Worker's subrequest limits hold. A product's documents are replaced per
  market and its stale ones deleted by filter.
- **Search** (`/hypha/extensions`, `search.query` v1): filters, channel, category,
  availability and price bounds are Meilisearch filters; sorts end in Hypha's tie-breaks
  (newest product, product ID, listing, position); `total` is Meilisearch's exhaustive
  `totalHits`. Facets are disjunctive (each ignores its own filter) and count groups:
  Meilisearch's facet distribution under `distinct` counts only each group's representative,
  which is right for vendor, type and tags (the same on every variant) but not for options,
  so an option facet's values are counted with one `hitsPerPage: 0` query per value seen on
  more than one document (design note 0019, Q3). Hits are at most `limit`, and only the
  asked facets are answered. Before the first full build, or when Meilisearch fails, the
  handler fails and Hypha falls back to its built-in engine.
- **Where it differs from Hypha's built-in engine, on purpose:** relevance is
  Meilisearch's (typo tolerance, prefix matching on the last word, attribute order title →
  vendor/type/tags/SKU/options → description), and string filters ignore case. Every other
  sort, group, filter, page and facet count answers exactly as Hypha's reference search: the
  integration test runs a battery of 136 queries against both, and the end-to-end test
  compares `/storefront/search` through the app with the built-in engine.
- **Settings page** (`/settings`, target `settings.app`): the admin frames it with
  `?origin=<its origin>` (`docs/apps/bridge.md`), which the page trusts only when it's one
  of the stores' admin origins (read with the installation's token from `GET
  /admin/app-extensions/origins`) or `ADMIN_ORIGINS`; it then asks for a
  session token through `@hyphacommerce/app-bridge` for every call to the app's backend
  (`/api/settings`, `/api/reindex`), which verifies it (HS256 under the app's secret, for
  `app_meilisearch`, with `products:read`). Meilisearch URL, admin API key (checked against
  Meilisearch, stored encrypted, never shown again) and index prefix; "Reindex now"; the
  status and each index's document count. `Content-Security-Policy: frame-ancestors` lists
  the stores' admin origins (`GET /admin/app-extensions/origins`) and `ADMIN_ORIGINS`.
- **Indexes** are named `<prefix>_<store>_<market>`. Uninstalling (`app.uninstalled`)
  forgets the store; the indexes stay in the merchant's Meilisearch.

## Layout

```
src/core/       the app on Web APIs: routes (app.ts), installs, webhooks, events → marks,
                the indexer, documents, the query mapping, the Meilisearch client, storage
src/hosts/      worker.ts + d1.ts (Workers), node.ts + sqlite.ts (Node)
src/ui/         the settings page's script; generated/ is its bundle (pnpm ui:build)
test/           unit tests (node:test) on in-memory SQLite and fakes of Hypha and Meilisearch
test/integration/  the query battery against a real Meilisearch, held to Hypha's reference
scripts/        e2e.sh / e2e.ts, build-ui.ts, bundle-node.ts
```

## Developing

It links Hypha's SDK packages (`@hyphacommerce/app`, `@hyphacommerce/sdk`, `@hyphacommerce/app-bridge`) from a
Hypha checkout next to this one (`../hypha`, with `pnpm install` run there).

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm fmt:check && pnpm ui:check
pnpm test
# the query mapping against a real Meilisearch:
docker run -d --rm --name meili -p 7700:7700 -e MEILI_MASTER_KEY=dev-master-key-0123 getmeili/meilisearch:v1.54.3
MEILI_URL=http://127.0.0.1:7700 MEILI_KEY=dev-master-key-0123 pnpm test:integration
docker stop meili
```

End to end against a real Hypha (its compose Postgres running, `docker compose up -d` in
`../hypha`) and a Meilisearch it starts itself: a fresh database, Hypha's demo seed, OAuth
install approved as the owner, settings through a session token, the full build, Hypha's
`search_app` set to `app_meilisearch`, searches compared with the built-in engine and found
in the app's call log, and a product update reaching the index by webhook. It stops what it
starts and drops the database.

```bash
HYPHA_BIN=../hypha/target/debug/hypha-host-axum pnpm e2e
```

After installing, point Hypha at the app: `PATCH /admin/search/settings`
`{"search_app": "app_meilisearch"}` (or the admin's Settings → Search).

## Configuration

| Variable | |
| --- | --- |
| `APP_URL` | Where the app is served, without a trailing `/` (the manifest's `app_url`) |
| `APP_ENCRYPTION_KEY` | 64 hex characters (`openssl rand -hex 32`); seals tokens, the app secret and Meilisearch keys. Keep it |
| `HYPHA_API_URLS` | Optional: origins of the Hypha APIs allowed to install the app (comma-separated); empty allows any |
| `ADMIN_ORIGINS` | Optional: admin origins allowed to frame the settings page, besides each store's own |
| `REINDEX_BATCH` | Products rebuilt per step (default 20) |
| `SEARCH_TIMEOUT_MS` | Meilisearch's time per search call (default 1200; Hypha waits 3 s) |
| `PORT`, `HOST`, `DATABASE_PATH`, `RUN_INTERVAL_MS` | Node only |
| `HYPHA_API_URL` + `HYPHA_API` binding | Workers only: calls to that API go through the Service Binding |

## Deploying

**Cloudflare Workers:**

```bash
cp wrangler.toml.example wrangler.toml          # set APP_URL and the D1 database's ID
wrangler d1 create hypha-app-meilisearch
wrangler secret put APP_ENCRYPTION_KEY
wrangler deploy
```

Migrations run on the first request. Co-located with Hypha's API Worker, uncomment the
Service Binding so the app's API calls stay on Cloudflare's network.

**Node / Docker:**

```bash
pnpm build:node                                  # dist/node.mjs, every dependency inlined
docker build -t hypha-app-meilisearch .
docker run -p 8787:8787 -v meili-app:/data \
  -e APP_URL=https://meilisearch-app.example.com \
  -e APP_ENCRYPTION_KEY=... hypha-app-meilisearch
```

Then install it from the store's admin, or open `<APP_URL>/install?api=<Hypha API URL>`.

## License

MIT or Apache-2.0, at your option, like Hypha.
