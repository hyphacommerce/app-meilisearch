// A small Meilisearch client over `fetch`: only the calls this app makes, typed by what
// it reads back. Meilisearch writes are asynchronous tasks, applied in order per index.

import { stringField } from "./json.ts";

export class MeiliError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "MeiliError";
    this.status = status;
    this.code = code;
  }
}

export interface MeiliTask {
  taskUid: number;
  indexUid: string | null;
  status: string;
  type: string;
}

export interface MeiliSearchQuery {
  indexUid: string;
  q?: string;
  filter?: string[];
  sort?: string[];
  distinct?: string;
  facets?: string[];
  offset?: number;
  limit?: number;
  page?: number;
  hitsPerPage?: number;
  attributesToRetrieve?: string[];
}

export interface MeiliSearchResult {
  indexUid: string;
  hits: Record<string, unknown>[];
  /** With `page`/`hitsPerPage`: exhaustive, up to the index's `maxTotalHits`. */
  totalHits?: number;
  estimatedTotalHits?: number;
  facetDistribution?: Record<string, Record<string, number>>;
}

export interface MeiliClientOptions {
  url: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Per request; none by default. */
  timeoutMs?: number;
}

export class MeiliClient {
  readonly url: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number | undefined;

  constructor(options: MeiliClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs;
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const timeout = timeoutMs ?? this.#timeoutMs;
    let response: Response;
    try {
      response = await this.#fetch(`${this.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(timeout === undefined ? {} : { signal: AbortSignal.timeout(timeout) }),
      });
    } catch (error) {
      throw new MeiliError(`Meilisearch unreachable: ${String(error)}`, 0, "unreachable");
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      throw new MeiliError(
        stringField(json, "message") ?? `HTTP ${response.status}`,
        response.status,
        stringField(json, "code"),
      );
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Meilisearch's documented shapes
    return json as T;
  }

  /** The version, which also checks the key (`/health` needs none). */
  version(): Promise<{ pkgVersion: string }> {
    return this.request("GET", "/version");
  }

  updateSettings(index: string, settings: Record<string, unknown>): Promise<MeiliTask> {
    return this.request("PATCH", `/indexes/${encodeURIComponent(index)}/settings`, settings);
  }

  /** Adds or replaces whole documents by their `id`. */
  addDocuments(index: string, documents: readonly unknown[]): Promise<MeiliTask> {
    return this.request(
      "POST",
      `/indexes/${encodeURIComponent(index)}/documents?primaryKey=id`,
      documents,
    );
  }

  deleteByFilter(index: string, filter: string): Promise<MeiliTask> {
    return this.request("POST", `/indexes/${encodeURIComponent(index)}/documents/delete`, {
      filter,
    });
  }

  deleteIndex(index: string): Promise<MeiliTask> {
    return this.request("DELETE", `/indexes/${encodeURIComponent(index)}`);
  }

  async multiSearch(
    queries: readonly MeiliSearchQuery[],
    timeoutMs?: number,
  ): Promise<MeiliSearchResult[]> {
    if (queries.length === 0) return [];
    const body = await this.request<{ results: MeiliSearchResult[] }>(
      "POST",
      "/multi-search",
      { queries },
      timeoutMs,
    );
    return body.results;
  }

  async stats(index: string): Promise<{ numberOfDocuments: number } | undefined> {
    try {
      return await this.request("GET", `/indexes/${encodeURIComponent(index)}/stats`);
    } catch (error) {
      if (error instanceof MeiliError && error.code === "index_not_found") return undefined;
      throw error;
    }
  }

  task(uid: number): Promise<MeiliTask & { error?: { message: string } | null }> {
    return this.request("GET", `/tasks/${uid}`);
  }

  /** Waits for a task to finish (tests and tools; the app never waits). */
  async waitForTask(uid: number, timeoutMs = 10_000): Promise<MeiliTask> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const task = await this.task(uid);
      if (task.status === "succeeded") return task;
      if (task.status === "failed" || task.status === "canceled")
        throw new MeiliError(task.error?.message ?? `task ${uid} ${task.status}`, 0, task.status);
      if (Date.now() > until) throw new MeiliError(`task ${uid} still ${task.status}`, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Waits until every task enqueued so far has finished (tests and tools). */
  async waitForIdle(timeoutMs = 20_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await this.request<{ total: number }>(
        "GET",
        "/tasks?statuses=enqueued,processing&limit=1",
      );
      if (tasks.total === 0) return;
      if (Date.now() > until) throw new MeiliError("tasks still running", 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** A string as a filter literal: double-quoted, with `"` and `\` escaped. */
export function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
