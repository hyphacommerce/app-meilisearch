// Hypha's webhooks (design note 0016, §8): a signed event envelope per delivery, through
// `@hyphacommerce/app`'s `webhookHandler`. `Hypha-Store` names the installation, whose secret
// must sign the body (so the header is proven once the signature checks out); the
// delivery ID dedupes retries, and the event becomes marks (`events.ts`).
//
// Answers: 204 handled (or a duplicate), 401 `invalid_signature` (no installation for
// the store, or a wrong signature), 400 `invalid_request` (not an envelope), 500
// `handler_failed` (a payload that breaks its promise, or storage failing: Hypha retries
// and shows it in the admin's delivery log).

import { type WebhookEnvelope, webhookHandler } from "@hyphacommerce/app";

import type { AppContext } from "./context.ts";
import { marksFor } from "./events.ts";
import { appSecret } from "./installations.ts";

export interface WebhookOptions {
  /** Called after an event marked work, to start working it. */
  onMarked?: (store: string, marks: number) => void;
}

/** What an event did, for logs and tests. */
export type WebhookOutcome =
  | { code: "accepted"; store: string; marks: number }
  | { code: "uninstalled"; store: string };

/** Handles one verified event for `store`. A broken payload throws (`PayloadError`). */
export async function applyEvent(
  ctx: AppContext,
  store: string,
  event: WebhookEnvelope,
): Promise<WebhookOutcome> {
  if (event.type === "app.uninstalled") {
    // The last webhook it gets: its tokens are revoked. The indexes stay in the
    // merchant's Meilisearch.
    await ctx.storage.deleteStore(store);
    return { code: "uninstalled", store };
  }
  const marks = marksFor(event);
  await ctx.storage.mark(store, marks, ctx.now());
  return { code: "accepted", store, marks: marks.length };
}

/** The fetch handler for the manifest's `webhooks.url`. */
export function webhooks(
  ctx: AppContext,
  options: WebhookOptions = {},
): (request: Request) => Promise<Response> {
  return webhookHandler({
    // Only the named store's secret is tried: Hypha sends `Hypha-Store` on every delivery.
    secret: async ({ store }) => {
      const row = store ? await ctx.storage.getInstallation(store) : undefined;
      return row ? appSecret(ctx, row).catch(() => undefined) : undefined;
    },
    // A verified delivery always has `store` (no store, no secret, a 401 before these).
    dedupe: {
      seen: (deliveryId, { store }) => (store ? ctx.storage.hasDelivery(store, deliveryId) : false),
      remember: async (deliveryId, { store }) => {
        if (store) await ctx.storage.recordDelivery(store, deliveryId, ctx.now());
      },
    },
    onEvent: async (event, { store }) => {
      if (!store) throw new Error("a verified delivery without Hypha-Store");
      const outcome = await applyEvent(ctx, store, event);
      if (outcome.code === "accepted" && outcome.marks > 0)
        options.onMarked?.(store, outcome.marks);
    },
    onError: (error, event, { store, deliveryId }) =>
      ctx.log("webhook failed", {
        store,
        delivery: deliveryId,
        event: event.type,
        error: String(error),
      }),
  });
}
