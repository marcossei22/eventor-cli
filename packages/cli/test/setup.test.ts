import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type Handler, runCli } from './harness.js';

const SPEC = {
  event: { name: 'Maratona', code: 'MAR2026', date: '2026-09-13' },
  organizer: { name: 'Run Brasil', document: '12345678000190' },
  races: [{ name: '10K', distance: 10, categories: [{ name: 'Geral M', sex: 'M', award_count: 3 }] }],
  registration_settings: { is_free: false, max_registrations: 3000 },
  batches: [{ name: '1º Lote', max_installments: 6, race_prices: { '10K': 12900 } }],
  registration_fields: [{ label: 'Camiseta', type: 'select', options: [{ value: 'P', label: 'P' }] }],
  publish: true,
};

function specFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'eventor-spec-')), 'spec.json');
  writeFileSync(file, JSON.stringify(SPEC));
  return file;
}

/** Fake server stateful: tudo vazio até criar; o evento "aparece" após o POST. */
function fakeServer(): Handler {
  let eventCreated = false;
  return (method, url) => {
    const path = new URL(url).pathname.replace('/api/v1', '');

    if (method === 'GET') {
      if (path === '/events/MAR2026') {
        return eventCreated
          ? { status: 200, body: { data: { code: 'MAR2026', status: 'published' } } }
          : { status: 404, body: { error: 'not_found', message: 'x' } };
      }
      return { status: 200, body: { data: [], meta: { last_page: 1 } } };
    }
    if (method === 'POST' && path === '/events') {
      eventCreated = true;
      return { status: 201, body: { data: { id: 1, code: 'MAR2026' } } };
    }
    if (method === 'POST' && path.endsWith('/races')) {
      return { status: 201, body: { data: { id: 201, name: '10K' } } };
    }
    if (method === 'POST') return { status: 201, body: { data: { id: 99 } } };
    if (method === 'PUT' || method === 'PATCH') return { status: 200, body: { data: {} } };
    return { status: 200, body: { data: {} } };
  };
}

describe('event setup --dry-run', () => {
  it('não escreve nada e devolve um plano de would_create', async () => {
    const r = await runCli(['event', 'setup', '--from', specFile(), '--dry-run'], fakeServer());

    expect(r.code).toBe(0);
    const writes = r.calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(0); // dry-run = só GETs

    const out = JSON.parse(r.stdout);
    expect(out.data.event).toBeNull();
    expect(out.data.plan.length).toBeGreaterThan(0);
    expect(out.data.plan.every((p: { action: string }) => p.action.startsWith('would') || p.action === 'unchanged')).toBe(true);
    expect(out.data.plan.find((p: { resource: string }) => p.resource === 'event').action).toBe('would_create');
  });
});

describe('event setup (apply)', () => {
  it('cria organizer→event→race→categoria→lote→campo→publish e mapeia race_prices por nome', async () => {
    const r = await runCli(['event', 'setup', '--from', specFile()], fakeServer());

    expect(r.code).toBe(0);

    // Sequência de escritas esperada.
    const posts = r.calls.filter((c) => c.method === 'POST').map((c) => new URL(c.url).pathname.replace('/api/v1', ''));
    expect(posts).toContain('/organizers');
    expect(posts).toContain('/events');
    expect(posts).toContain('/events/MAR2026/races');
    expect(posts).toContain('/events/MAR2026/races/201/categories');
    expect(posts).toContain('/events/MAR2026/batches');
    expect(posts).toContain('/events/MAR2026/registration-fields');
    expect(posts).toContain('/events/MAR2026/publish');

    // race_prices: "10K" → race_id 201.
    const batchPost = r.calls.find((c) => c.method === 'POST' && c.url.endsWith('/batches'));
    expect((batchPost!.body as { race_prices: Record<string, number> }).race_prices).toEqual({ '201': 12900 });

    // registration-settings via PUT.
    expect(r.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/registration-settings'))).toBe(true);

    // Estado final lido de volta.
    const out = JSON.parse(r.stdout);
    expect(out.data.event.data.code).toBe('MAR2026');
    expect(out.data.plan.find((p: { resource: string }) => p.resource === 'event').action).toBe('created');
  });
});
