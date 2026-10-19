// Hypha's webhooks (design note 0016, §8): a signed event envelope per delivery. The
// signature identifies the installation (webhooks carry no `Hypha-Store` header, so
// each installation's secret is tried; a header, when Hypha sends one, picks it), the
// delivery ID dedupes retries, and the event becomes marks (`events.ts`).

import { SIGNATURE_HEADER, verifySignature } from "@hypha/app";

import type { AppContext } from "./context.ts";
import { type EventEnvelope, PayloadError, marksFor } from "./events.ts";
import { appSecret, candidates } from "./installations.ts";
import { isRecord } from "./json.ts";
import type { InstallationRow } from "./storage.ts";

export const DELIVERY_ID_HEADER = "Hypha-Delivery-Id";
export const EVENT_TYPE_HEADER = "Hypha-Event-Type";

export type WebhookOutcome =
  | { status: 401; code: "invalid_signature" }
  | { status: 400; code: "invalid_event"; error: string }
  | { status: 200; code: "duplicate" | "accepted" | "uninstalled"; store: string; marks: number };

function isEnvelope(value: unknown): value is EventEnvelope {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    isRecord(value.data) &&
    isRecord(value.subject)
  );
}

/** The installation whose secret signs the body, if any. */
async function signedBy(
  ctx: AppContext,
  request: Request,
  raw: Uint8Array,
): Promise<InstallationRow | undefined> {
  const header = request.headers.get(SIGNATURE_HEADER);
  if (!header) return undefined;
  for (const row of await candidates(ctx, request.headers.get("Hypha-Store"))) {
    const secret = await appSecret(ctx, row).catch(() => undefined);
    if (secret && (await verifySignature(secret, header, raw))) return row;
  }
  return undefined;
}

export async function handleWebhook(ctx: AppContext, request: Request): Promise<WebhookOutcome> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const row = await signedBy(ctx, request, raw);
  if (!row) return { status: 401, code: "invalid_signature" };

  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { status: 400, code: "invalid_event", error: "the body isn't JSON" };
  }
  if (!isEnvelope(event))
    return { status: 400, code: "invalid_event", error: "the body isn't an event" };

  const delivery = request.headers.get(DELIVERY_ID_HEADER) ?? `event:${event.id}`;
  const now = ctx.now();
  if (!(await ctx.storage.recordDelivery(row.store, delivery, now)))
    return { status: 200, code: "duplicate", store: row.store, marks: 0 };

  try {
    if (event.type === "app.uninstalled") {
      // The last webhook it gets: its tokens are revoked. The indexes stay in the
      // merchant's Meilisearch.
      await ctx.storage.deleteStore(row.store);
      return { status: 200, code: "uninstalled", store: row.store, marks: 0 };
    }
    const marks = marksFor(event);
    await ctx.storage.mark(row.store, marks, now);
    return { status: 200, code: "accepted", store: row.store, marks: marks.length };
  } catch (error) {
    // Not handled: let Hypha retry (and show it in the admin's delivery log).
    await ctx.storage.forgetDelivery(row.store, delivery);
    if (error instanceof PayloadError)
      return { status: 400, code: "invalid_event", error: error.message };
    throw error;
  }
}
