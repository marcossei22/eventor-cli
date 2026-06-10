import { EventorClient } from '@eventor-run/sdk';
import { Writable } from 'node:stream';

import type { ClientFactory } from '../src/context.js';
import { run } from '../src/program.js';

/** Resposta canned por chamada (fila) ou por handler (method,url,body). */
export type CannedResponse = { status: number; body?: unknown; headers?: Record<string, string> };
export type Handler = (method: string, url: string, body: unknown) => CannedResponse;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  calls: Array<{ method: string; url: string; body: unknown }>;
}

function collector(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function toResponse(spec: CannedResponse): Response {
  const payload = spec.body === undefined ? '' : JSON.stringify(spec.body);
  return new Response(payload.length > 0 ? payload : null, {
    status: spec.status,
    headers: spec.headers ?? (payload.length > 0 ? { 'content-type': 'application/json' } : {}),
  });
}

/** Roda o CLI com fetch mockado + streams coletados. `responder` = fila ou handler. */
export async function runCli(
  argv: string[],
  responder: CannedResponse[] | Handler,
  opts: { isTTY?: boolean } = {},
): Promise<RunResult> {
  const out = collector();
  const err = collector();
  const calls: RunResult['calls'] = [];
  let i = 0;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });

    if (Array.isArray(responder)) {
      const spec = responder[Math.min(i, responder.length - 1)]!;
      i += 1;
      return toResponse(spec);
    }
    return toResponse(responder(method, String(url), body));
  }) as unknown as typeof fetch;

  const clientFactory: ClientFactory = (overrides, options) =>
    new EventorClient({
      apiKey: overrides.apiKey ?? 'sk_live_test_key_0000000000000000',
      baseUrl: overrides.baseUrl ?? 'https://api.test/api/v1',
      fetch: fetchImpl,
      sleep: async () => {},
      retryBaseMs: 1,
      ...options,
    });

  const code = await run(argv, {
    stdout: out.stream,
    stderr: err.stream,
    isTTY: opts.isTTY ?? false,
    clientFactory,
  });

  return { code, stdout: out.text(), stderr: err.text(), calls };
}
