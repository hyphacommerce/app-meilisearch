// The app's manifest (design note 0029, §4), served at `/manifest.json`: that URL is the
// app's OAuth client ID. Scopes are what reading search's inputs needs (each admin
// route's `x-hypha-scopes`) and what the events' subjects need to be delivered
// (`hypha_apps::event_scope`); no personal data.

import { MANIFEST_SCHEMA_URL, defineManifest } from "@hypha/app";

export const APP_KEY = "app_meilisearch";

export const SCOPES = [
  // Products, variants, categories, search settings; `search.query` itself needs it.
  "products:read",
  // Markets and their catalogs (and the catalogs' products).
  "markets:read",
  // Price lists and fixed prices.
  "pricing:read",
  // Stock per location, and which locations serve which market.
  "inventory:read",
  // `channel.*` events: which channels a product is published to.
  "channels:read",
  // The store's ID: the token response doesn't say which store installed the app.
  "stores:read",
] as const;

export const WEBHOOK_EVENTS = [
  "product.*",
  "inventory_item.*",
  "location.changed",
  "catalog.*",
  "price_list.*",
  "market.changed",
  "channel.*",
  "category.*",
  "search_settings.changed",
] as const;

export const PATHS = {
  manifest: "/manifest.json",
  install: "/install",
  callback: "/hypha/oauth/callback",
  webhooks: "/hypha/webhooks",
  extensions: "/hypha/extensions",
  settings: "/settings",
  privacy: "/privacy",
} as const;

export function manifest(appUrl: string) {
  return defineManifest({
    $schema: MANIFEST_SCHEMA_URL,
    key: APP_KEY,
    name: "Meilisearch",
    version: "0.1.0",
    app_url: appUrl,
    redirect_uris: [`${appUrl}${PATHS.callback}`],
    scopes: [...SCOPES],
    scope_reasons: {
      "products:read": "Products and their variants are what the search index holds",
      "markets:read": "Each market has its own index, with what its catalog sells",
      "pricing:read": "Documents carry each market's price, for filters and sorting",
      "inventory:read": "Shoppers can filter by availability in their market",
      "channels:read": "Searches show only what the storefront's channel sells",
      "stores:read": "To know which store installed the app",
    },
    privacy_url: `${appUrl}${PATHS.privacy}`,
    publisher: "Hypha",
    webhooks: { url: PATHS.webhooks, events: [...WEBHOOK_EVENTS] },
    extension_points: [{ point: "search.query", version: 1, url: PATHS.extensions }],
    admin: {
      pages: [{ id: "settings", title: "Meilisearch", url: PATHS.settings, nav: "settings" }],
    },
  });
}
