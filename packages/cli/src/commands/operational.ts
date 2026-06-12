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
  q?: string;
};

/**
 * Domínio 5 — leitura operacional + limpeza. Inscrições e resultados de um
 * evento: list pros dois, delete pontual e (resultados) clear da prova inteira
 * pra desfazer import errado antes de reimportar.
 */
export function registerOperational(program: Command, deps: CliDeps): void {
  const ctxOf = (command: Command) => new CliContext(command.optsWithGlobals() as OperationalFlags, deps);
  const flagsOf = (command: Command) => command.optsWithGlobals() as OperationalFlags;

  // ----------------------------------------------------------- registration
  const registration = program
    .command('registration')
    .description('Inscrições de um evento (listar + apagar as subidas via API/CSV).');

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

  // ----------------------------------------------------------------- result
  const result = program
    .command('result')
    .description('Resultados de um evento (listar, apagar pontual, limpar a prova).');

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
    .description('Apaga TODOS os resultados de uma prova (desfaz um import errado antes de reimportar).')
    .option('--event <idOrCode>', 'id ou código do evento')
    .requiredOption('--race <id>', 'id da prova')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const key = requireEvent(flags);
      ctx.ensureConfirmed();
      emit(
        ctx.io,
        await ctx.client().request('delete', '/events/{event}/races/{race}/results', {
          path: { event: key, race: String(flags.race) },
        }),
      );
    });
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
