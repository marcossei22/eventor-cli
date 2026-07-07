import { readFileSync } from 'node:fs';
import type { Command } from 'commander';

import { CliContext, type CliDeps, type GlobalFlags } from '../context.js';
import { CliUsageError } from '../errors.js';
import { emit } from '../output.js';

type IngestFlags = GlobalFlags & {
  event?: string;
  race?: string;
  from?: string;
  modality?: string;
  modalityId?: string;
};

/** Sumário devolvido pela API de import (mesmo envelope no POST e no GET de status). */
interface ImportSummary {
  total_received?: number;
  created?: number;
  updated?: number;
  conflicts?: number;
  errors?: number;
  duration_ms?: number;
}
interface ImportResponse {
  import_id?: number;
  status?: string;
  summary?: ImportSummary;
  results?: Array<Record<string, unknown>>;
}

/**
 * Domínio 6 — ingest pós-prova (Management API `/v1`). Sobe resultados, inscrições
 * e parciais (laps) em lote a partir de um arquivo JSON, e lê o status de um import.
 *
 * `import` (POST) é idempotente/upsert (não é destrutivo → não exige --yes):
 *   - resultados casam pela chave natural do cronometrista `(prova, categoria, bib)`,
 *     com fallback por CPF; `external_id` é só referência livre, NÃO é chave de match.
 *   - inscrições casam por `(evento, external_id)` ou `(evento, CPF)`.
 *
 * Os grupos `result`/`registration` já existem (Domínio 5) — aqui só penduramos
 * os subcomandos novos. `lap` é um grupo próprio.
 */
export function registerIngest(
  groups: { program: Command; result: Command; registration: Command },
  deps: CliDeps,
): void {
  const { program, result, registration } = groups;
  const ctxOf = (command: Command) => new CliContext(command.optsWithGlobals() as IngestFlags, deps);

  // ----------------------------------------------------------- result import
  result
    .command('import')
    .description('Sobe resultados em lote (uma modalidade por envio) a partir de um JSON. Upsert pela chave natural (prova, categoria, bib).')
    .requiredOption('--event <idOrCode>', 'id ou código do evento')
    .requiredOption('--race <idOrCode>', 'id ou código da prova')
    .requiredOption('--from <file>', 'arquivo JSON com os resultados (ou - pra stdin)')
    .option('--modality <name>', 'modalidade do lote por NOME (resolvida contra as da prova; nunca cria)')
    .option('--modality-id <id>', 'modalidade do lote por id (tem prioridade sobre --modality)')
    .addHelpText(
      'after',
      `
O --from aceita o corpo completo {"modality":"Geral","results":[...]} OU um array
puro [...] de resultados. --modality/--modality-id (ou o item) define a modalidade.
Cada resultado exige só "athlete"; net_time/gun_time são obrigatórios salvo status=dns.

Exemplos:
  $ eventor result import --event 260412 --race 26041201 --from geral.json
  $ eventor result import --event 260412 --race 26041201 --modality Morador --from morador.json
  $ cat results.json | eventor result import --event MAR2026 --race 10K --from -`,
    )
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = command.optsWithGlobals() as IngestFlags;
      const event = requireId(flags.event, 'evento', '--event <id-ou-código>');
      const race = requireId(flags.race, 'prova', '--race <id-ou-código>');

      const body = normalizeBody(loadJson(flags.from), 'results');
      applyModality(body, flags);

      const res = (await ctx.client().request('post', '/events/{event}/races/{race}/results', {
        path: { event, race },
        body: body as never,
      })) as ImportResponse;
      reportImport(ctx, res);
    });

  result
    .command('import-status')
    .description('Status/sumário de um import de resultados (ou laps) por id.')
    .argument('<id>', 'id do import (import_id devolvido pelo result import)')
    .requiredOption('--event <idOrCode>', 'id ou código do evento')
    .action(async (id: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      const event = requireId((command.optsWithGlobals() as IngestFlags).event, 'evento', '--event <id-ou-código>');
      emit(
        ctx.io,
        await ctx.client().request('get', '/events/{event}/result-imports/{import}', {
          path: { event, import: id },
        }),
      );
    });

  // ----------------------------------------------------- registration import
  registration
    .command('import')
    .description('Sobe inscrições em lote a partir de um JSON. Idempotente por (evento, external_id) ou (evento, CPF).')
    .requiredOption('--event <idOrCode>', 'id ou código do evento')
    .requiredOption('--race <idOrCode>', 'id ou código da prova')
    .requiredOption('--from <file>', 'arquivo JSON com as inscrições (ou - pra stdin)')
    .addHelpText(
      'after',
      `
O --from aceita o corpo completo {"registrations":[...]} OU um array puro [...].
Cada item exige só "name"; mande external_id pra idempotência forte. Campos extras
são preservados em external_data.

Exemplos:
  $ eventor registration import --event 260401 --race 26040101 --from inscritos.json
  $ cat inscritos.json | eventor registration import --event MAR2026 --race 10K --from -`,
    )
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = command.optsWithGlobals() as IngestFlags;
      const event = requireId(flags.event, 'evento', '--event <id-ou-código>');
      const race = requireId(flags.race, 'prova', '--race <id-ou-código>');

      const body = normalizeBody(loadJson(flags.from), 'registrations');
      const res = (await ctx.client().request('post', '/events/{event}/races/{race}/registrations', {
        path: { event, race },
        body: body as never,
      })) as ImportResponse;
      reportImport(ctx, res);
    });

  registration
    .command('import-status')
    .description('Status/sumário de um import de inscrições por id.')
    .argument('<id>', 'id do import (import_id devolvido pelo registration import)')
    .requiredOption('--event <idOrCode>', 'id ou código do evento')
    .action(async (id: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      const event = requireId((command.optsWithGlobals() as IngestFlags).event, 'evento', '--event <id-ou-código>');
      emit(
        ctx.io,
        await ctx.client().request('get', '/events/{event}/registration-imports/{import}', {
          path: { event, import: id },
        }),
      );
    });

  // -------------------------------------------------------------- lap import
  const lap = program
    .command('lap')
    .description('Parciais por volta (laps) de uma prova. Stream-friendly — pode mandar durante a corrida.');

  lap
    .command('import')
    .description('Sobe parciais por volta (laps) em lote a partir de um JSON.')
    .requiredOption('--event <idOrCode>', 'id ou código do evento')
    .requiredOption('--race <idOrCode>', 'id ou código da prova')
    .requiredOption('--from <file>', 'arquivo JSON com as laps (ou - pra stdin)')
    .addHelpText(
      'after',
      `
O --from aceita o corpo completo {"laps":[...]} OU um array puro [...]. Cada lap
exige lap_number e o "bib" (número da prova) — é por ele que a volta casa com o
resultado. "athlete" (CPF/email) é fallback pra quando não há número.
Acompanhe o resultado em result import-status <id>.

Exemplo:
  $ eventor lap import --event 260412 --race 26041201 --from laps.json`,
    )
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = command.optsWithGlobals() as IngestFlags;
      const event = requireId(flags.event, 'evento', '--event <id-ou-código>');
      const race = requireId(flags.race, 'prova', '--race <id-ou-código>');

      const body = normalizeBody(loadJson(flags.from), 'laps');
      const res = (await ctx.client().request('post', '/events/{event}/races/{race}/laps', {
        path: { event, race },
        body: body as never,
      })) as ImportResponse;
      reportImport(ctx, res);
    });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Lê o `--from` do disco (ou stdin com `-`) e faz o parse JSON. */
function loadJson(from: string | undefined): unknown {
  if (!from) {
    throw new CliUsageError('Faltou o arquivo de entrada.', 'Passe --from arquivo.json (ou - pra stdin).');
  }

  let text: string;
  try {
    text = from === '-' ? readFileSync(0, 'utf8') : readFileSync(from, 'utf8');
  } catch {
    throw new CliUsageError(`Não consegui ler o arquivo: ${from}`, 'Confira o caminho passado em --from (ou use - pra stdin).');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new CliUsageError('--from não é um JSON válido.', 'O arquivo deve conter o corpo do POST ou um array puro de itens.');
  }
}

/**
 * Aceita o corpo completo `{ [key]: [...] }` OU um array puro `[...]` e devolve
 * sempre o corpo no formato que a API espera (`{ [key]: [...] }`).
 */
function normalizeBody(parsed: unknown, key: 'results' | 'registrations' | 'laps'): Record<string, unknown> {
  if (Array.isArray(parsed)) {
    return { [key]: parsed };
  }
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)[key])) {
    return parsed as Record<string, unknown>;
  }
  throw new CliUsageError(
    `O arquivo precisa ter um array "${key}" (ou ser um array puro de itens).`,
    `Ex.: {"${key}":[ ... ]} ou [ ... ].`,
  );
}

/** Aplica `--modality`/`--modality-id` no topo do lote (sobrescrevem o que veio no arquivo). */
function applyModality(body: Record<string, unknown>, flags: IngestFlags): void {
  if (flags.modalityId !== undefined) {
    const id = Number(flags.modalityId);
    if (!Number.isInteger(id)) {
      throw new CliUsageError(`--modality-id inválido: ${flags.modalityId}`, 'Passe um id numérico inteiro.');
    }
    body.modality_id = id;
  }
  if (flags.modality !== undefined) {
    body.modality = flags.modality;
  }
}

/** Exige um identificador (evento/prova) ou estoura erro de uso com a dica certa. */
function requireId(value: string | undefined, what: string, flag: string): string {
  const key = value?.trim();
  if (!key) {
    throw new CliUsageError(`Faltou identificar o ${what}.`, `Passe ${flag}.`);
  }
  return key;
}

/**
 * Emite o resultado de um import. Em pipe/--json sai o envelope completo
 * (`import_id`, `summary`, `results`); em TTY humano sai uma linha de sumário no
 * stderr + a tabela de `outcome` por item no stdout.
 */
function reportImport(ctx: CliContext, res: ImportResponse): void {
  if (ctx.io.structured) {
    emit(ctx.io, res);
    return;
  }

  ctx.io.info(summaryLine(res));
  const rows = Array.isArray(res?.results) ? res.results : undefined;
  emit(ctx.io, rows ? { data: rows } : res);
}

function summaryLine(res: ImportResponse): string {
  const s = res?.summary ?? {};
  const id = res?.import_id ?? '?';
  return (
    `import #${id}: ${s.created ?? 0} criados, ${s.updated ?? 0} atualizados, ` +
    `${s.conflicts ?? 0} conflitos, ${s.errors ?? 0} erros (${s.total_received ?? '?'} recebidos)`
  );
}
