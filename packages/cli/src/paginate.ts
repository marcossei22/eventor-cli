import type { EventorClient } from '@eventor-run/sdk';

/**
 * Percorre todas as páginas de um endpoint de coleção via o escape hatch `api()`
 * (envelope {data,meta}). Usado por comandos cujo filtro de query não está
 * tipado no spec (ex.: ?q=) ou pelo `--all`.
 */
export async function fetchAllPages(
  client: EventorClient,
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<unknown[]> {
  const items: unknown[] = [];
  let page = 1;
  let lastPage = 1;

  do {
    const payload = (await client.api('GET', path, { query: { ...stringify(query), page: String(page) } })) as {
      data?: unknown;
      meta?: { last_page?: number };
    };
    if (Array.isArray(payload?.data)) items.push(...payload.data);
    lastPage = payload?.meta?.last_page ?? page;
    page += 1;
  } while (page <= lastPage);

  return items;
}

function stringify(query: Record<string, string | number | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) out[k] = String(v);
  }
  return out;
}
