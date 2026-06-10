import { describe, expect, it } from 'vitest';

import { runCli } from './harness.js';

describe('contrato de I/O e exit codes', () => {
  it('event list --json: dados no stdout (JSON puro), stderr vazio, exit 0', async () => {
    const r = await runCli(
      ['event', 'list'],
      [{ status: 200, body: { data: [{ code: 'MAR2026', name: 'Maratona', status: 'planned' }], meta: {}, links: {} } }],
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const parsed = JSON.parse(r.stdout);
    expect(parsed.data[0].code).toBe('MAR2026');
  });

  it('not_found → exit 3, envelope de erro no stderr, stdout vazio', async () => {
    const r = await runCli(
      ['event', 'show', '--event', 'NOPE'],
      [{ status: 404, body: { error: 'not_found', message: "Evento 'NOPE' não encontrado neste hub." } }],
    );
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr).error.code).toBe('not_found');
  });

  it('401 → exit 4 com hint', async () => {
    const r = await runCli(
      ['event', 'list'],
      [{ status: 401, body: { error: 'invalid_api_key', message: 'inválida' } }],
    );
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stderr).error).toMatchObject({ code: 'invalid_api_key' });
    expect(JSON.parse(r.stderr).error.hint).toBeTruthy();
  });

  it('409 → exit 5', async () => {
    const r = await runCli(
      ['api', 'DELETE', '/events/E/batches/5', '--yes'],
      [{ status: 409, body: { error: 'batch_has_sales', message: 'tem vendas' } }],
    );
    expect(r.code).toBe(5);
  });

  it('falta --event → erro de uso (exit 2)', async () => {
    const r = await runCli(['event', 'show'], [{ status: 200, body: { data: {} } }]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe('usage_error');
  });

  it('comando desconhecido → exit 2', async () => {
    const r = await runCli(['frobnicate'], [{ status: 200, body: {} }]);
    expect(r.code).toBe(2);
  });
});

describe('segurança destrutiva (no-TTY)', () => {
  it('api DELETE sem --yes → exit 2 (no_tty) e nenhuma chamada de rede', async () => {
    const r = await runCli(['api', 'DELETE', '/events/E/batches/5'], [{ status: 204 }]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe('no_tty');
    expect(r.calls).toHaveLength(0);
  });

  it('api DELETE com --yes → 204 → exit 0', async () => {
    const r = await runCli(['api', 'DELETE', '/events/E/batches/5', '--yes'], [{ status: 204 }]);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.method).toBe('DELETE');
  });
});

describe('mapeamento de comandos', () => {
  it('event publish → POST /events/{event}/publish', async () => {
    const r = await runCli(['event', 'publish', '--event', 'MAR2026'], [{ status: 200, body: { data: { status: 'published' } } }]);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/api/v1/events/MAR2026/publish' });
  });

  it('api GET tolera prefixo /api/v1 e passa --query', async () => {
    const r = await runCli(
      ['api', 'GET', '/api/v1/events', '--query', 'status=published'],
      [{ status: 200, body: { data: [] } }],
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.url).toBe('https://api.test/api/v1/events?status=published');
  });

  it('modality list → GET /modalities', async () => {
    const r = await runCli(['modality'], [{ status: 200, body: { data: [{ id: 1, name: '5km' }] } }]);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.url).toBe('https://api.test/api/v1/modalities');
  });
});
