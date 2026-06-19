import type { Command } from 'commander';

import { CliContext, type CliDeps, type GlobalFlags } from '../context.js';
import { CliUsageError } from '../errors.js';
import { emit } from '../output.js';
import { fetchAllPages } from '../paginate.js';

type OperationalFlags = GlobalFlags & {
  event?: string;
  race?: string;
  category?: string;
  status?: string;
  origin?: string;
  q?: string;
};

/**
 * Domínio 5 — leitura operacional + limpeza. Inscrições e resultados de um
 * evento: list pros dois, delete pontual e (resultados) clear da prova inteira
 * pra desfazer import errado antes de reimportar.
 *
 * Devolve os grupos `result`/`registration` pra que o ingest (Domínio 6) pendure
 * neles os subcomandos de upload (`import`, `import-status`) sem recriar o grupo.
 */
export function registerOperational(program: Command, deps: CliDeps): { result: Command; registration: Command } {
  const ctxOf = (command: Command) => new CliContext(command.optsWithGlobals() as OperationalFlags, deps);
  const flagsOf = (command: Command) => command.optsWithGlobals() as OperationalFlags;

  // ----------------------------------------------------------- registration
  const registration = program
    .command('registration')
    .description('Inscrições de um evento (listar, apagar uma, ou limpar em lote as de API/CSV).');

  registration
    .command('list')
    .description('Lista inscrições do evento (--all percorre todas as páginas).')
    .option('--event <idOrCode>', 'id ou código do evento')
    .option('--race <id>', 'filtra por prova')
    .option('--category <id>', 'filtra por categoria')
    .option('--status <status>', 'confirmed|canceled')
    .option('--q <termo>', 'busca por nome/documento/email/número')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const key = requireEvent(flags);
      const query = clean({
        race_id: flags.race,
        category_id: flags.category,
        status: flags.status,
        q: flags.q,
      });

      const path = `/events/${encodeURIComponent(key)}/registrations`;
      if (flags.all) {
        emit(ctx.io, { data: await fetchAllPages(ctx.client(), path, query) });
        return;
      }
      emit(ctx.io, await ctx.client().api('GET', path, { query }));
    });

  registration
    .command('delete')
    .description('Apaga uma inscrição subida via API/CSV. Inscrição de checkout (online) é recusada (409) — cancele pelo painel.')
    .argument('<id>', 'id da inscrição')
    .option('--event <idOrCode>', 'id ou código do evento')
    .action(async (id: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      const key = requireEvent(flagsOf(command));
      ctx.ensureConfirmed();
      emit(
        ctx.io,
        await ctx.client().request('delete', '/events/{event}/registrations/{registration}', {
          path: { event: key, registration: id },
        }),
      );
    });

  registration
    .command('clear')
    .description('Apaga EM LOTE as inscrições do evento subidas via API/CSV. Checkout (online) é sempre preservado. Filtros opcionais por prova/status/origem.')
    .option('--event <idOrCode>', 'id ou código do evento')
    .option('--race <id>', 'limita a uma prova')
    .option('--status <status>', 'limita a um status (confirmed|canceled)')
    .option('--origin <origin>', 'limita a uma origem (api|csv) — online é recusado (422)')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const key = requireEvent(flags);
      ctx.ensureConfirmed();
      const query = clean({ race_id: flags.race, status: flags.status, origin: flags.origin });
      emit(ctx.io, await ctx.client().api('DELETE', `/events/${encodeURIComponent(key)}/registrations`, { query }));
    });

  // ----------------------------------------------------------------- result
  const result = program
    .command('result')
    .description('Resultados de um evento (listar, apagar pontual, limpar prova ou evento inteiro).');

  result
    .command('list')
    .description('Lista resultados do evento (--all percorre todas as páginas).')
    .option('--event <idOrCode>', 'id ou código do evento')
    .option('--race <id>', 'filtra por prova')
    .option('--category <id>', 'filtra por categoria')
    .option('--status <status>', 'filtra por status do resultado')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const key = requireEvent(flags);
      const query = clean({
        race_id: flags.race,
        category_id: flags.category,
        status: flags.status,
      });

      const path = `/events/${encodeURIComponent(key)}/results`;
      if (flags.all) {
        emit(ctx.io, { data: await fetchAllPages(ctx.client(), path, query) });
        return;
      }
      emit(ctx.io, await ctx.client().api('GET', path, { query }));
    });

  result
    .command('delete')
    .description('Apaga um resultado de vez (hard delete — some do site e do reimport).')
    .argument('<id>', 'id do resultado')
    .option('--event <idOrCode>', 'id ou código do evento')
    .action(async (id: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      const key = requireEvent(flagsOf(command));
      ctx.ensureConfirmed();
      emit(
        ctx.io,
        await ctx.client().request('delete', '/events/{event}/results/{result}', {
          path: { event: key, result: id },
        }),
      );
    });

  result
    .command('clear')
    .description('Apaga TODOS os resultados — do evento inteiro, ou de uma prova com --race. Desfaz um import errado antes de reimportar.')
    .option('--event <idOrCode>', 'id ou código do evento')
    .option('--race <id>', 'limita a uma prova (sem --race = evento inteiro)')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const key = requireEvent(flags);
      ctx.ensureConfirmed();
      if (flags.race) {
        emit(
          ctx.io,
          await ctx.client().request('delete', '/events/{event}/races/{race}/results', {
            path: { event: key, race: String(flags.race) },
          }),
        );
        return;
      }
      emit(
        ctx.io,
        await ctx.client().request('delete', '/events/{event}/results', { path: { event: key } }),
      );
    });

  result
    .command('status')
    .description('Marca o resultado de UMA prova como provisional|homologated. Decisão explícita do hub — import nunca muda esse status. É reversível.')
    .argument('<status>', 'provisional | homologated')
    .option('--event <idOrCode>', 'id ou código do evento')
    .option('--race <id>', 'id da prova (homologação é por prova)')
    .action(async (status: string, _opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const key = requireEvent(flags);

      if (status !== 'provisional' && status !== 'homologated') {
        throw new CliUsageError(`Status inválido: ${status}`, 'Use provisional ou homologated.');
      }
      const race = flags.race?.trim();
      if (!race) {
        throw new CliUsageError('Faltou identificar a prova.', 'Passe --race <id> (a homologação é por prova).');
      }

      emit(
        ctx.io,
        await ctx.client().request('patch', '/events/{event}/races/{race}', {
          path: { event: key, race: Number(race) },
          body: { results_status: status } as never,
        }),
      );
    });

  return { result, registration };
}

function requireEvent(flags: OperationalFlags): string {
  const key = flags.event?.trim();
  if (!key) {
    throw new CliUsageError('Faltou identificar o evento.', 'Passe --event <id-ou-código> (ex.: --event MAR2026).');
  }
  return key;
}

function clean<T extends Record<string, unknown>>(obj: T): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v as string | number;
  }
  return out;
}
