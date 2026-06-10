import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { EventorApiError, EventorClient, stripUndefined, stripVersionPrefix } from '../src/index.js';

interface Call {
  url: string;
  init: RequestInit;
}

/** Mock de fetch: consome uma fila de respostas e registra as chamadas. */
function mockFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  let i = 0;

  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    const payload = spec.body === undefined ? '' : JSON.stringify(spec.body);
    return new Response(payload.length > 0 ? payload : null, {
      status: spec.status,
      headers: spec.headers ?? (payload.length > 0 ? { 'content-type': 'application/json' } : {}),
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof EventorClient>[0]> = {},
) {
  const sleep = vi.fn(async () => {});
  const client = new EventorClient({
    apiKey: 'sk_live_test_key_0000000000000000',
    baseUrl: 'https://api.test/api/v1',
    fetch: fetchImpl,
    retryBaseMs: 1,
    sleep,
    ...overrides,
  });
  return { client, sleep };
}

describe('request — URL, headers, body', () => {
  it('interpola path params e querystring, e seta headers de auth', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: { data: { id: 1, code: 'MAR2026' } } }]);
    const { client } = makeClient(impl);

    await client.request('get', '/events/{event}', { path: { event: 'MAR2026' }, query: { foo: 'bar' } });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.test/api/v1/events/MAR2026?foo=bar');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk_live_test_key_0000000000000000');
    expect(headers.Accept).toBe('application/json');
    expect(String(headers['User-Agent'])).toContain('eventor-sdk/');
  });

  it('serializa o body removendo undefined e seta Content-Type', async () => {
    const { impl, calls } = mockFetch([{ status: 201, body: { data: { id: 9 } } }]);
    const { client } = makeClient(impl);

    await client.request('post', '/events', {
      body: { name: 'X', code: undefined, city: 'SP' } as never,
    });

    const init = calls[0]!.init;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'X', city: 'SP' });
  });

  it('GET não manda body', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: { data: [] } }]);
    const { client } = makeClient(impl);
    await client.request('get', '/events');
    expect(calls[0]!.init.body).toBeUndefined();
  });
});

describe('respostas', () => {
  it('devolve o corpo parseado no sucesso', async () => {
    const { impl } = mockFetch([{ status: 200, body: { data: { code: 'MAR2026' } } }]);
    const { client } = makeClient(impl);
    const res = (await client.request('get', '/events/{event}', { path: { event: 'MAR2026' } })) as {
      data: { code: string };
    };
    expect(res.data.code).toBe('MAR2026');
  });

  it('204 → null', async () => {
    const { impl } = mockFetch([{ status: 204 }]);
    const { client } = makeClient(impl);
    const res = await client.request('delete', '/events/{event}/batches/{batch}', {
      path: { event: 'E', batch: 5 },
    });
    expect(res).toBeNull();
  });

  it('erro → EventorApiError com status/code/hint', async () => {
    const { impl } = mockFetch([
      { status: 409, body: { error: 'batch_has_sales', message: 'Lote tem vendas.' } },
    ]);
    const { client } = makeClient(impl);

    await expect(
      client.request('delete', '/events/{event}/batches/{batch}', { path: { event: 'E', batch: 5 } }),
    ).rejects.toMatchObject({ status: 409, code: 'batch_has_sales' });
  });
});

describe('retry/backoff', () => {
  it('re-tenta no 429 honrando Retry-After e depois sucede', async () => {
    const { impl, calls } = mockFetch([
      { status: 429, body: { error: 'rate_limited', message: 'devagar' }, headers: { 'retry-after': '2' } },
      { status: 200, body: { data: [] } },
    ]);
    const { client, sleep } = makeClient(impl);

    await client.request('get', '/events');

    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(2000); // Retry-After: 2s
  });

  it('NÃO re-tenta 5xx em POST (evita duplicar escrita)', async () => {
    const { impl, calls } = mockFetch([{ status: 500, body: { error: 'server_error', message: 'boom' } }]);
    const { client, sleep } = makeClient(impl);

    await expect(client.request('post', '/events', { body: { name: 'X' } as never })).rejects.toBeInstanceOf(
      EventorApiError,
    );
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('re-tenta 5xx em GET até o teto e então estoura', async () => {
    const { impl, calls } = mockFetch([{ status: 503, body: { error: 'server_error', message: 'down' } }]);
    const { client } = makeClient(impl, { maxRetries: 2 });

    await expect(client.request('get', '/events')).rejects.toBeInstanceOf(EventorApiError);
    expect(calls).toHaveLength(3); // 1 inicial + 2 retries
  });
});

describe('paginação', () => {
  it('all() percorre as páginas via meta.last_page', async () => {
    const { impl, calls } = mockFetch([
      { status: 200, body: { data: [{ id: 1 }, { id: 2 }], meta: { page: 1, last_page: 2 } } },
      { status: 200, body: { data: [{ id: 3 }], meta: { page: 2, last_page: 2 } } },
    ]);
    const { client } = makeClient(impl);

    const items = (await client.all('/events')) as Array<{ id: number }>;
    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('page=1');
    expect(calls[1]!.url).toContain('page=2');
  });
});

describe('upload', () => {
  it('manda multipart com o arquivo lido do disco', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eventor-up-'));
    const file = join(dir, 'logo.png');
    writeFileSync(file, Buffer.from('PNGDATA'));

    const { impl, calls } = mockFetch([{ status: 200, body: { data: { logo_url: 'x' } } }]);
    const { client } = makeClient(impl);

    await client.upload('post', '/events/{event}/logo', { path: { event: 'MAR2026' }, file });

    const init = calls[0]!.init;
    expect(calls[0]!.url).toBe('https://api.test/api/v1/events/MAR2026/logo');
    expect(init.body).toBeInstanceOf(FormData);
    const sent = (init.body as FormData).get('file') as File;
    expect(sent).toBeTruthy();
    expect(sent.name).toBe('logo.png');
    // Content-Type não é setado à mão (o runtime define o boundary).
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});

describe('escape hatch api()', () => {
  it('tolera prefixo de versão e normaliza o método', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: { data: [] } }]);
    const { client } = makeClient(impl);

    await client.api('GET', '/api/v1/events', { query: { status: 'published' } });
    expect(calls[0]!.url).toBe('https://api.test/api/v1/events?status=published');
    expect(calls[0]!.init.method).toBe('GET');
  });
});

describe('utilitários puros', () => {
  it('stripUndefined remove chaves undefined recursivamente', () => {
    expect(stripUndefined({ a: 1, b: undefined, c: { d: undefined, e: 2 } })).toEqual({ a: 1, c: { e: 2 } });
  });

  it('stripVersionPrefix aceita /events, /v1/events e URL completa', () => {
    expect(stripVersionPrefix('/events')).toBe('/events');
    expect(stripVersionPrefix('/v1/events')).toBe('/events');
    expect(stripVersionPrefix('api/v1/events')).toBe('/events');
    expect(stripVersionPrefix('https://x.test/api/v1/events')).toBe('/events');
  });
});
