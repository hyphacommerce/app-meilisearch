// Reading JSON we didn't write: plain objects checked before use.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value[field]` when it's a string. */
export function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[field];
  return typeof found === "string" ? found : undefined;
}

/**
 * A response body typed as the API documents it. The APIs this app calls (Hypha's,
 * generated into `@hypha/sdk`'s types, and Meilisearch's) are trusted for their shapes.
 */
export async function documented<T>(response: Response): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a documented API shape
  return (await response.json()) as T;
}
