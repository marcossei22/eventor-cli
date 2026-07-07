import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type CannedResponse, type Handler, runCli } from './harness.js';

function jsonFile(content: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'eventor-ingest-')), 'in.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const IMPORT_OK = {
  import_id: 57,
  status: 'success',
  summary: { total_received: 1, created: 1, updated: 0, conflicts: 0, errors: 0, duration_ms: 12 },
  results: [{ external_id: 'x-1', outcome: 'created', result_id: 812, athlete_id: 42 }],
};

function path(url: string): string {
  return new URL(url).pathname.replace('/api/v1', '');
}

describe('result import', () => {
  it('manda o corpo completo {modality,results} pro POST da prova e devolve o envelope', async () => {
    const file = jsonFile({ modality: 'Geral', results: [{ athlete: { document: '1' }, bib: '10', net_time: '00:41:03' }] });
    const server: Handler = (method, url) =>
      method === 'POST' && path(url) === '/events/260412/races/26041201/results'
        ? { status: 200, body: IMPORT_OK }
        : { status: 500, body: { error: 'x', message: 'rota inesperada' } };

    const r = await runCli(['result', 'import', '--event', '260412', '--race', '26041201', '--from', file], server);

    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].method).toBe('POST');
    expect(r.calls[0].body).toEqual({
      modality: 'Geral',
      results: [{ athlete: { document: '1' }, bib: '10', net_time: '00:41:03' }],
    });
    // structured (não-TTY) → envelope completo no stdout.
    expect(JSON.parse(r.stdout)).toEqual(IMPORT_OK);
  });

  it('aceita um array puro + --modality (flag entra no topo do lote)', async () => {
    const file = jsonFile([{ athlete: { name: 'João' }, bib: '7' }]);
    const r = await runCli(
      ['result', 'import', '--event', 'MAR2026', '--race', '10K', '--modality', 'Morador', '--from', file],
      [{ status: 200, body: IMPORT_OK }],
    );

    expect(r.code).toBe(0);
    expect(r.calls[0].body).toEqual({ results: [{ athlete: { name: 'João' }, bib: '7' }], modality: 'Morador' });
  });

  it('--modality-id vira inteiro e sobrescreve a modalidade do arquivo', async () => {
    const file = jsonFile({ modality: 'Geral', results: [{ athlete: {} }] });
    const r = await runCli(
      ['result', 'import', '--event', 'E', '--race', 'R', '--modality-id', '7', '--from', file],
      [{ status: 200, body: IMPORT_OK }],
    );

    expect(r.code).toBe(0);
    const body = r.calls[0].body as Record<string, unknown>;
    expect(body.modality_id).toBe(7);
    expect(body.modality).toBe('Geral'); // id ganha no servidor; a flag de nome não foi passada
  });

  it('é upsert (não destrutivo): não exige --yes', async () => {
    const file = jsonFile([{ athlete: {} }]);
    const r = await runCli(['result', 'import', '--event', 'E', '--race', 'R', '--from', file], [
      { status: 200, body: IMPORT_OK },
    ]);
    expect(r.code).toBe(0);
  });

  it('em TTY mostra o sumário no stderr e a tabela de outcomes no stdout', async () => {
    const file = jsonFile([{ athlete: {} }]);
    const r = await runCli(['result', 'import', '--event', 'E', '--race', 'R', '--from', file], [
      { status: 200, body: IMPORT_OK },
    ], { isTTY: true });

    expect(r.code).toBe(0);
    expect(r.stderr).toContain('import #57');
    expect(r.stderr).toContain('1 criados');
    expect(r.stdout).toContain('OUTCOME'); // header da tabela de results
    expect(r.stdout).toContain('created');
  });

  it('rejeita JSON inválido com erro de uso (exit 2)', async () => {
    const file = jsonFile('{ não é json');
    const r = await runCli(['result', 'import', '--event', 'E', '--race', 'R', '--from', file], []);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe('usage_error');
  });

  it('rejeita arquivo sem o array esperado (exit 2)', async () => {
    const file = jsonFile({ foo: 'bar' });
    const r = await runCli(['result', 'import', '--event', 'E', '--race', 'R', '--from', file], []);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe('usage_error');
  });
});

describe('registration import', () => {
  it('embrulha array puro em {registrations} e posta na prova', async () => {
    const file = jsonFile([{ external_id: 'r1', name: 'João', document: '123' }]);
    const reg: CannedResponse = {
      status: 200,
      body: {
        import_id: 42,
        status: 'success',
        summary: { total_received: 1, created: 1, updated: 0, conflicts: 0, errors: 0 },
        results: [{ external_id: 'r1', outcome: 'created', registration_id: 501 }],
      },
    };
    const r = await runCli(['registration', 'import', '--event', '260401', '--race', '26040101', '--from', file], [reg]);

    expect(r.code).toBe(0);
    expect(path(r.calls[0].url)).toBe('/events/260401/races/26040101/registrations');
    expect(r.calls[0].body).toEqual({ registrations: [{ external_id: 'r1', name: 'João', document: '123' }] });
  });
});

describe('lap import', () => {
  it('embrulha array puro em {laps} e posta na prova', async () => {
    const file = jsonFile([{ athlete: { document: '1' }, lap_number: 1, partial_time: '00:05:03' }]);
    const r = await runCli(['lap', 'import', '--event', '260412', '--race', '26041201', '--from', file], [
      { status: 200, body: { import_id: 9, status: 'success', summary: { total_received: 1 }, results: [] } },
    ]);

    expect(r.code).toBe(0);
    expect(path(r.calls[0].url)).toBe('/events/260412/races/26041201/laps');
    expect(r.calls[0].body).toEqual({ laps: [{ athlete: { document: '1' }, lap_number: 1, partial_time: '00:05:03' }] });
  });

  it('aceita laps casadas por bib (sem athlete)', async () => {
    const file = jsonFile([{ bib: '20', lap_number: 3, partial_time: '00:09:40' }]);
    const r = await runCli(['lap', 'import', '--event', '260412', '--race', '26041201', '--from', file], [
      { status: 200, body: { import_id: 9, status: 'success', summary: { total_received: 1 }, results: [] } },
    ]);

    expect(r.code).toBe(0);
    expect(r.calls[0].body).toEqual({ laps: [{ bib: '20', lap_number: 3, partial_time: '00:09:40' }] });
  });
});

describe('import-status', () => {
  it('result import-status faz GET em result-imports/{id}', async () => {
    const r = await runCli(['result', 'import-status', '57', '--event', '260412'], [
      { status: 200, body: { import_id: 57, kind: 'result', status: 'success' } },
    ]);
    expect(r.code).toBe(0);
    expect(r.calls[0].method).toBe('GET');
    expect(path(r.calls[0].url)).toBe('/events/260412/result-imports/57');
  });

  it('registration import-status faz GET em registration-imports/{id}', async () => {
    const r = await runCli(['registration', 'import-status', '42', '--event', '260401'], [
      { status: 200, body: { import_id: 42, status: 'success' } },
    ]);
    expect(r.code).toBe(0);
    expect(r.calls[0].method).toBe('GET');
    expect(path(r.calls[0].url)).toBe('/events/260401/registration-imports/42');
  });
});
