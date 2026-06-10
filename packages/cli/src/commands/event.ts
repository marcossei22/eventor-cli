import type { Command } from 'commander';

import { parseBody, parseSetFlags } from '../body.js';
import { CliContext, type CliDeps, type GlobalFlags } from '../context.js';
import { CliUsageError } from '../errors.js';
import { emit } from '../output.js';

type EventFlags = GlobalFlags & {
  event?: string;
  body?: string;
  set?: string[];
  status?: string;
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  name?: string;
  code?: string;
  date?: string;
  city?: string;
  state?: string;
  kind?: string;
  file?: string;
  stageId?: string;
  stageKind?: string;
};

const UPLOAD_KINDS: Record<string, string> = {
  logo: '/events/{event}/logo',
  banner: '/events/{event}/banner',
  'regulation-pdf': '/events/{event}/regulation-pdf',
};

export function registerEvent(program: Command, deps: CliDeps): Command {
  const event = program.command('event').description('Gestão de eventos (CRUD + ciclo de vida + uploads).');
  const ctxOf = (command: Command) => new CliContext(command.optsWithGlobals() as EventFlags, deps);
  const flagsOf = (command: Command) => command.optsWithGlobals() as EventFlags;

  event
    .command('list')
    .description('Lista eventos do hub (filtros opcionais; --all percorre todas as páginas).')
    .option('--status <status>', 'filtra por status')
    .option('--q <termo>', 'busca por nome/código')
    .option('--date-from <YYYY-MM-DD>')
    .option('--date-to <YYYY-MM-DD>')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const query = clean({
        status: flags.status,
        q: flags.q,
        date_from: flags.dateFrom,
        date_to: flags.dateTo,
      });

      if (flags.all) {
        emit(ctx.io, { data: await ctx.client().all('/events', { query }) });
        return;
      }
      emit(ctx.io, await ctx.client().request('get', '/events', { query }));
    });

  event
    .command('show')
    .description('Estado completo de um evento.')
    .option('--event <idOrCode>', 'id ou código do evento')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const key = requireEvent(flagsOf(command));
      emit(ctx.io, await ctx.client().request('get', '/events/{event}', { path: { event: key } }));
    });

  event
    .command('create')
    .description('Cria um evento. Use --body com o JSON, ou os atalhos --name/--code/--date/...')
    .option('--body <body>', 'JSON inline, @arquivo.json ou - (stdin)')
    .option('--name <name>')
    .option('--code <code>')
    .option('--date <YYYY-MM-DD>')
    .option('--city <city>')
    .option('--state <UF>')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const base = (parseBody(flags.body) as Record<string, unknown> | undefined) ?? {};
      const body = {
        ...base,
        ...clean({
          name: flags.name,
          code: flags.code,
          date: flags.date,
          city: flags.city,
          state: flags.state,
        }),
      };
      if (!body.name) {
        throw new CliUsageError('Evento precisa de um nome.', 'Passe --name ou inclua "name" no --body.');
      }
      emit(ctx.io, await ctx.client().request('post', '/events', { body: body as never }));
    });

  event
    .command('update')
    .description('Atualiza campos de um evento (PATCH parcial).')
    .option('--event <idOrCode>')
    .option('--body <body>', 'JSON inline, @arquivo.json ou - (stdin)')
    .option('--set <pair...>', 'campo=valor (repetível)')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const key = requireEvent(flags);
      const body = { ...(parseBody(flags.body) as object | undefined), ...parseSetFlags(flags.set) };
      if (Object.keys(body).length === 0) {
        throw new CliUsageError('Nada pra atualizar.', 'Passe --body ou --set campo=valor.');
      }
      emit(ctx.io, await ctx.client().request('patch', '/events/{event}', { path: { event: key }, body: body as never }));
    });

  for (const action of ['publish', 'unpublish', 'finalize'] as const) {
    event
      .command(action)
      .description(`Move o evento para o estado "${action}".`)
      .option('--event <idOrCode>')
      .action(async (_opts, command: Command) => {
        const ctx = ctxOf(command);
        const key = requireEvent(flagsOf(command));
        emit(ctx.io, await ctx.client().request('post', `/events/{event}/${action}`, { path: { event: key } }));
      });
  }

  event
    .command('stage')
    .description('Move o evento de coluna no kanban (por id ou tipo).')
    .option('--event <idOrCode>')
    .option('--stage-id <id>')
    .option('--stage-kind <kind>', 'planned|published|finished|canceled')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const key = requireEvent(flags);
      const body = clean({
        stage_id: flags.stageId ? Number(flags.stageId) : undefined,
        stage_kind: flags.stageKind,
      });
      if (Object.keys(body).length === 0) {
        throw new CliUsageError('Informe a coluna.', 'Passe --stage-id ou --stage-kind.');
      }
      emit(ctx.io, await ctx.client().request('post', '/events/{event}/stage', { path: { event: key }, body: body as never }));
    });

  event
    .command('upload')
    .description('Sobe logo, banner ou PDF de regulamento a partir de um arquivo local.')
    .option('--event <idOrCode>')
    .requiredOption('--kind <kind>', 'logo|banner|regulation-pdf')
    .requiredOption('--file <path>', 'caminho do arquivo')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = flagsOf(command);
      const key = requireEvent(flags);
      const path = UPLOAD_KINDS[flags.kind ?? ''];
      if (!path) {
        throw new CliUsageError(`Tipo de upload inválido: ${flags.kind}`, 'Use --kind logo|banner|regulation-pdf.');
      }
      const result = await ctx.client().upload('post', path as '/events/{event}/logo', {
        path: { event: key },
        file: flags.file as string,
      });
      emit(ctx.io, result);
    });

  return event;
}

function requireEvent(flags: EventFlags): string {
  const key = flags.event?.trim();
  if (!key) {
    throw new CliUsageError('Faltou identificar o evento.', 'Passe --event <id-ou-código> (ex.: --event MAR2026).');
  }
  return key;
}

function clean<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}
