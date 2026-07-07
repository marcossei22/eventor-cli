import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type Handler, runCli } from './harness.js';

const SPEC = {
  event: { name: 'Maratona', code: 'MAR2026', date: '2026-09-13' },
  organizer: { name: 'Run Brasil', document: '12345678000190' },
  races: [{ name: '10K', distance: 10, categories: [{ name: 'Geral M', sex: 'M', award_count: 3 }] }],
  registration_settings: { is_free: false },
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
      // Realista: subrecursos de um evento inexistente dão 404 (resolveEvent falha).
      if (path.startsWith('/events/MAR2026/') && !eventCreated) {
        return { status: 404, body: { error: 'not_found', message: 'x' } };
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

    // Regressão: pra um evento NOVO, o dry-run não pode quebrar tentando listar
    // subrecursos de um evento que ainda não existe (dava 404 → abortava). Os
    // filhos têm que entrar como would_create.
    const byResource = (res: string) => out.data.plan.find((p: { resource: string }) => p.resource === res);
    expect(byResource('event').action).toBe('would_create');
    expect(byResource('race').action).toBe('would_create');
    expect(byResource('batch').action).toBe('would_create');
    expect(byResource('registration_field').action).toBe('would_create');
  });
});

const MOD_SPEC = {
  event: { name: 'Volta', code: 'VLT2026', date: '2026-10-01' },
  races: [
    {
      name: '7K',
      distance: 7,
      modalities: ['Geral', 'Morador'],
      default_modality: 'Geral',
      categories: [{ name: 'Fem 30', sex: 'F', modalities: ['Geral'] }],
    },
  ],
  modality_questions: [{ modality: 'Morador', label: 'Sou morador?', type: 'checkbox' }],
};

function modSpecFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'eventor-modspec-')), 'spec.json');
  writeFileSync(file, JSON.stringify(MOD_SPEC));
  return file;
}

/** Fake: "Geral" já existe (id 1); "Morador" é nova (POST → id 7). */
function modFakeServer(): Handler {
  let eventCreated = false;
  return (method, url) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    if (method === 'GET') {
      if (path === '/events/VLT2026') {
        return eventCreated
          ? { status: 200, body: { data: { code: 'VLT2026', status: 'draft' } } }
          : { status: 404, body: { error: 'not_found', message: 'x' } };
      }
      if (path === '/modalities') {
        return { status: 200, body: { data: [{ id: 1, name: 'Geral' }], meta: { last_page: 1 } } };
      }
      if (path.startsWith('/events/VLT2026/') && !eventCreated) {
        return { status: 404, body: { error: 'not_found', message: 'x' } };
      }
      return { status: 200, body: { data: [], meta: { last_page: 1 } } };
    }
    if (method === 'POST' && path === '/events') {
      eventCreated = true;
      return { status: 201, body: { data: { id: 1, code: 'VLT2026' } } };
    }
    if (method === 'POST' && path === '/modalities') return { status: 201, body: { data: { id: 7, name: 'Morador' } } };
    if (method === 'POST' && path.endsWith('/races')) return { status: 201, body: { data: { id: 201, name: '7K' } } };
    if (method === 'POST') return { status: 201, body: { data: { id: 99 } } };
    if (method === 'PUT' || method === 'PATCH') return { status: 200, body: { data: {} } };
    return { status: 200, body: { data: {} } };
  };
}

describe('event setup — modalidades por nome', () => {
  it('resolve/cria modalidade, traduz pra modality_ids e aplica a pergunta de opt-in', async () => {
    const r = await runCli(['event', 'setup', '--from', modSpecFile()], modFakeServer());
    expect(r.code).toBe(0);

    // "Geral" existe → não recria; "Morador" é nova → POST /modalities uma vez.
    const modalityPosts = r.calls.filter((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith('/modalities'));
    expect(modalityPosts).toHaveLength(1);
    expect((modalityPosts[0].body as { name: string }).name).toBe('Morador');

    // Race: modalities(nome) → modality_ids [1,7] + default_modality_id 1, sem as chaves de nome.
    const racePost = r.calls.find((c) => c.method === 'POST' && c.url.endsWith('/races'));
    const raceBody = racePost!.body as Record<string, unknown>;
    expect(raceBody.modality_ids).toEqual([1, 7]);
    expect(raceBody.default_modality_id).toBe(1);
    expect(raceBody.modalities).toBeUndefined();
    expect(raceBody.default_modality).toBeUndefined();

    // Categoria: modalities ['Geral'] → modality_ids [1].
    const catPost = r.calls.find((c) => c.method === 'POST' && c.url.endsWith('/categories'));
    expect((catPost!.body as { modality_ids: number[] }).modality_ids).toEqual([1]);

    // Pergunta de opt-in da Morador → PUT /modalities/7/question.
    const questionPut = r.calls.find((c) => c.method === 'PUT' && c.url.includes('/modalities/7/question'));
    expect(questionPut).toBeDefined();
    expect((questionPut!.body as { label: string }).label).toBe('Sou morador?');
  });
});

const POOL_SPEC = {
  event: { name: 'Corrida', code: 'COR2026', date: '2026-11-01' },
  races: [{ name: '10K', distance: 10 }],
  vacancy_pools: [{ name: 'Geral', max_quantity: 500 }],
  batches: [{ name: 'Lote 1', race_prices: { '10K': { price: 9900, pool: 'Geral' } } }],
};

function poolSpecFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'eventor-poolspec-')), 'spec.json');
  writeFileSync(file, JSON.stringify(POOL_SPEC));
  return file;
}

/** Fake: pacote "Geral" é novo (POST /vacancy-pools → id 55); prova 10K → id 201. */
function poolFakeServer(): Handler {
  let eventCreated = false;
  return (method, url) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    if (method === 'GET') {
      if (path === '/events/COR2026') {
        return eventCreated
          ? { status: 200, body: { data: { code: 'COR2026', status: 'draft' } } }
          : { status: 404, body: { error: 'not_found', message: 'x' } };
      }
      if (path.startsWith('/events/COR2026/') && !eventCreated) {
        return { status: 404, body: { error: 'not_found', message: 'x' } };
      }
      return { status: 200, body: { data: [], meta: { last_page: 1 } } };
    }
    if (method === 'POST' && path === '/events') {
      eventCreated = true;
      return { status: 201, body: { data: { id: 1, code: 'COR2026' } } };
    }
    if (method === 'POST' && path.endsWith('/vacancy-pools')) return { status: 201, body: { data: { id: 55, name: 'Geral' } } };
    if (method === 'POST' && path.endsWith('/races')) return { status: 201, body: { data: { id: 201, name: '10K' } } };
    if (method === 'POST') return { status: 201, body: { data: { id: 99 } } };
    if (method === 'PUT' || method === 'PATCH') return { status: 200, body: { data: {} } };
    return { status: 200, body: { data: {} } };
  };
}

describe('event setup — pacotes de vagas (ADR #19)', () => {
  it('cria o pacote e resolve nome→pool_id em race_prices', async () => {
    const r = await runCli(['event', 'setup', '--from', poolSpecFile()], poolFakeServer());
    expect(r.code).toBe(0);

    // Pacote criado uma vez, antes do lote.
    const poolPosts = r.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/vacancy-pools'));
    expect(poolPosts).toHaveLength(1);
    expect((poolPosts[0].body as { name: string; max_quantity: number })).toEqual({ name: 'Geral', max_quantity: 500 });

    // race_prices: "10K" → 201, pool "Geral" → 55.
    const batchPost = r.calls.find((c) => c.method === 'POST' && c.url.endsWith('/batches'));
    expect((batchPost!.body as { race_prices: Record<string, unknown> }).race_prices).toEqual({
      '201': { price: 9900, pool_id: 55 },
    });
  });

  it('erra cedo quando race_prices referencia um pacote não declarado', async () => {
    const bad = { ...POOL_SPEC, batches: [{ name: 'Lote 1', race_prices: { '10K': { price: 9900, pool: 'Inexistente' } } }] };
    const file = join(mkdtempSync(join(tmpdir(), 'eventor-badpool-')), 'spec.json');
    writeFileSync(file, JSON.stringify(bad));

    const r = await runCli(['event', 'setup', '--from', file], poolFakeServer());
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Inexistente');
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

    // race_prices: atalho legado "10K": 12900 → { race_id 201: { price, pool_id null } } (ADR #19).
    const batchPost = r.calls.find((c) => c.method === 'POST' && c.url.endsWith('/batches'));
    expect((batchPost!.body as { race_prices: Record<string, unknown> }).race_prices).toEqual({
      '201': { price: 12900, pool_id: null },
    });

    // registration-settings via PUT.
    expect(r.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/registration-settings'))).toBe(true);

    // Estado final lido de volta.
    const out = JSON.parse(r.stdout);
    expect(out.data.event.data.code).toBe('MAR2026');
    expect(out.data.plan.find((p: { resource: string }) => p.resource === 'event').action).toBe('created');
  });
});
