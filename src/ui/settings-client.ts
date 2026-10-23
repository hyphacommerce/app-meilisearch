// The settings page's script, in the admin's iframe (design note 0029, §6.3): it asks
// the admin for a session token through the bridge for every call to the app's own
// backend. Bundled by `scripts/build-ui.ts` into `src/core/ui/generated/`.

import { type Bridge, BridgeError, createBridge } from "@hyphacommerce/app-bridge";

interface SettingsView {
  store: string;
  meilisearch_url: string | null;
  has_api_key: boolean;
  index_prefix: string;
  status: {
    queued: number;
    ready: boolean;
    last_reindex_at: string | null;
    last_error: string | null;
    indexes: { market: string; uid: string; documents: number | null }[];
  };
}

function $(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page has no #${id}`);
  return found;
}

function input(id: string): HTMLInputElement {
  const found = $(id);
  if (!(found instanceof HTMLInputElement)) throw new Error(`#${id} isn't an input`);
  return found;
}

/** The admin's origin: `?origin=`, else the page that framed us, if it's an allowed one. */
function hostOrigin(allowed: readonly string[]): string | undefined {
  const fromQuery = new URLSearchParams(location.search).get("origin");
  const fromReferrer = document.referrer ? new URL(document.referrer).origin : undefined;
  for (const candidate of [fromQuery, fromReferrer])
    if (candidate && allowed.includes(candidate)) return candidate;
  return allowed.length === 1 ? allowed[0] : undefined;
}

function show(message: string, tone: "info" | "error" = "info") {
  const box = $("message");
  box.textContent = message;
  box.dataset.tone = tone;
  box.hidden = message === "";
}

async function call(
  bridge: Bridge,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = await bridge.getSessionToken();
  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error =
      typeof json === "object" && json !== null && "error" in json ? String(json.error) : undefined;
    throw new Error(error ?? `HTTP ${response.status}`);
  }
  return json;
}

/** The backend's settings view (it's this app's own API). */
async function settings(bridge: Bridge, method: string, body?: unknown): Promise<SettingsView> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the app's own response
  return (await call(bridge, method, "/api/settings", body)) as SettingsView;
}

function render(view: SettingsView) {
  input("url").value = view.meilisearch_url ?? "";
  input("prefix").value = view.index_prefix;
  const key = input("key");
  key.value = "";
  key.placeholder = view.has_api_key ? "Stored (leave empty to keep it)" : "Admin API key";
  key.required = !view.has_api_key;
  const reindex = $("reindex");
  if (reindex instanceof HTMLButtonElement) reindex.disabled = view.meilisearch_url === null;

  const s = view.status;
  const state = !view.meilisearch_url
    ? "Not configured"
    : s.queued > 0
      ? `Indexing: ${s.queued} item${s.queued === 1 ? "" : "s"} queued`
      : s.ready
        ? "Up to date"
        : "Waiting to index";
  $("state").textContent = state;
  $("last").textContent = s.last_reindex_at
    ? new Date(s.last_reindex_at).toLocaleString()
    : "Never";
  $("error").textContent = s.last_error ?? "";
  $("error-row").hidden = !s.last_error;
  const list = $("indexes");
  list.replaceChildren(
    ...s.indexes.map((index) => {
      const row = document.createElement("tr");
      for (const text of [index.uid, index.documents === null ? "–" : String(index.documents)]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    }),
  );
  $("indexes-block").hidden = s.indexes.length === 0;
}

const failed = (error: unknown) => {
  const message =
    error instanceof BridgeError
      ? `The admin didn't give a session (${error.code}).`
      : error instanceof Error
        ? error.message
        : String(error);
  show(message, "error");
};

async function main() {
  const config: unknown = JSON.parse($("config").textContent ?? "{}");
  const origins =
    typeof config === "object" &&
    config !== null &&
    "origins" in config &&
    Array.isArray(config.origins)
      ? (config.origins as unknown[]).filter((o): o is string => typeof o === "string")
      : [];
  const origin = window.parent !== window ? hostOrigin(origins) : undefined;
  if (!origin) {
    show(
      "Open this page from your Hypha admin (Settings → Meilisearch): it needs the admin's session.",
      "error",
    );
    return;
  }
  const bridge = createBridge({ hostOrigin: origin, autoResize: true });
  const form = $("form");
  if (!(form instanceof HTMLFormElement)) return;
  let polling: ReturnType<typeof setTimeout> | undefined;

  const refresh = async () => {
    const view = await settings(bridge, "GET");
    render(view);
    clearTimeout(polling);
    if (view.status.queued > 0) polling = setTimeout(() => void refresh().catch(() => {}), 3_000);
  };

  const start = async () => {
    await call(bridge, "POST", "/api/reindex");
    await bridge.toast("Reindexing started", { tone: "info" }).catch(() => {});
    await refresh();
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    show("Checking Meilisearch…");
    const save = async () => {
      const view = await settings(bridge, "PUT", {
        meilisearch_url: data.get("url"),
        api_key: data.get("key"),
        index_prefix: data.get("prefix"),
      });
      render(view);
      show("");
      await bridge.toast("Meilisearch settings saved", { tone: "success" }).catch(() => {});
      await refresh();
    };
    save().catch(failed);
  });
  $("reindex").addEventListener("click", () => {
    start().catch(failed);
  });

  form.hidden = false;
  await refresh().catch(failed);
}

void main();
