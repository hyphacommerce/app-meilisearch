// The app's HTML: the settings page the admin frames (its script is the bundled
// `settings-client.ts`), the landing page that starts an install, and the privacy note
// the consent screen links to.

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1d21;--muted:#61656e;--line:#dcdfe4;--accent:#3b4cca;--error:#b42318;--panel:#f6f7f9}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e8eaed;--muted:#9aa0a8;--line:#30343b;--accent:#8b98ff;--error:#ff8a80;--panel:#1e2126}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 12px;color:var(--muted)}
label{display:block;font-weight:600;margin:12px 0 4px}input{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.hint{font-weight:400;color:var(--muted);font-size:12px;margin-top:2px}
.actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
button{padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--accent)}button:disabled{opacity:.5;cursor:default}
section{margin-top:24px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}td{padding:4px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}td:last-child{text-align:right}
#message{margin-top:12px;padding:8px 10px;border-radius:6px;background:var(--panel)}#message[data-tone=error]{color:var(--error)}
`;

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style>${head}</head><body><main>${body}</main></body></html>`;
}

/** The settings page; `origins` are the admins allowed to frame it. */
export function settingsPage(origins: readonly string[]): string {
  // `<` can't end the script element from inside JSON.
  const config = JSON.stringify({ origins }).replaceAll("<", "\\u003c");
  return page(
    "Meilisearch",
    `<h1>Meilisearch</h1>
<p>Search for your storefront, answered by your Meilisearch: one index per market, kept up to date from your store's changes.</p>
<div id="message" hidden></div>
<form id="form" hidden autocomplete="off">
  <label for="url">Meilisearch URL<div class="hint">Where your Meilisearch answers, e.g. https://search.example.com</div></label>
  <input id="url" name="url" type="url" required placeholder="https://search.example.com">
  <label for="key">Admin API key<div class="hint">A key that may manage indexes and documents. Stored encrypted; never shown again.</div></label>
  <input id="key" name="key" type="password" placeholder="Admin API key">
  <label for="prefix">Index prefix<div class="hint">Indexes are named &lt;prefix&gt;_&lt;store&gt;_&lt;market&gt;.</div></label>
  <input id="prefix" name="prefix" type="text" pattern="[a-z][a-z0-9_\\-]{0,39}" placeholder="hypha">
  <div class="actions"><button type="submit">Save</button><button type="button" id="reindex" class="secondary" disabled>Reindex now</button></div>
  <section aria-live="polite">
    <dl><dt>Status</dt><dd id="state">…</dd><dt>Last full index</dt><dd id="last">…</dd><dt id="error-row" hidden>Last error</dt><dd id="error"></dd></dl>
    <div id="indexes-block" hidden><table><tbody id="indexes"></tbody></table></div>
  </section>
</form>
<script type="application/json" id="config">${config}</script>`,
    `<script src="/settings.js" defer></script>`,
  );
}

export function landingPage(appUrl: string): string {
  return page(
    "Meilisearch for Hypha",
    `<h1>Meilisearch for Hypha</h1>
<p>Install it from your Hypha admin (Settings → Apps), or enter your Hypha API's address:</p>
<form method="get" action="/install"><label for="api">Hypha API URL</label><input id="api" name="api" type="url" required placeholder="https://api.shop.example"><div class="actions"><button type="submit">Install</button></div></form>
<p style="margin-top:16px">Manifest: <a href="${escape(appUrl)}/manifest.json">${escape(appUrl)}/manifest.json</a></p>`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`);
}

export function privacyPage(): string {
  return page(
    "Privacy",
    `<h1>Privacy</h1>
<p>This app reads your store's products, prices, stock, markets, catalogs and channels to build search indexes in the Meilisearch you configure. It asks for no customer data and stores none. Its own database holds the app's credentials for your store, your Meilisearch URL and key (encrypted), and copies of catalog memberships and fixed prices. Uninstalling the app deletes them; the indexes stay in your Meilisearch.</p>`,
  );
}
