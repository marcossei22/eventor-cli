import type { Command } from 'commander';

import { parseBody } from '../body.js';
import { CliContext, type CliDeps, type GlobalFlags } from '../context.js';
import { CliUsageError } from '../errors.js';
import { emit } from '../output.js';
import { fetchAllPages } from '../paginate.js';

/**
 * Domínio 0 — discovery/referência. Listas pequenas (sem paginação) que o agente
 * lê pra resolver ids semânticos antes de configurar o evento.
 */
export function registerDiscovery(program: Command, deps: CliDeps): void {
  const ctxOf = (command: Command) => new CliContext(command.optsWithGlobals() as GlobalFlags, deps);

  const simpleList: Array<{ name: string; path: '/race-templates' | '/products' | '/pipeline-stages'; desc: string }> = [
    { name: 'race-template', path: '/race-templates', desc: 'Lista os templates de prova.' },
    { name: 'product', path: '/products', desc: 'Lista os produtos/serviços.' },
    { name: 'pipeline-stage', path: '/pipeline-stages', desc: 'Lista as colunas do kanban.' },
  ];

  registerModality(program, deps);

  for (const { name, path, desc } of simpleList) {
    program
      .command(name)
      .description(desc)
      .action(async (_opts, command: Command) => {
        const ctx = ctxOf(command);
        emit(ctx.io, await ctx.client().request('get', path));
      });
  }

  registerOrganizerLike(program, deps, {
    name: 'organizer',
    listPath: '/organizers',
    desc: 'organizadores',
  });
  registerOrganizerLike(program, deps, {
    name: 'salesperson',
    listPath: '/salespeople',
    desc: 'vendedores',
  });
}

/**
 * Modalidade: `eventor modality` lista (default); `create` cria do hub (reutilizável);
 * `question` define a pergunta de opt-in (responder no checkout entra na modalidade).
 */
function registerModality(program: Command, deps: CliDeps): void {
  const ctxOf = (command: Command) => new CliContext(command.optsWithGlobals() as GlobalFlags, deps);

  const group = program
    .command('modality')
    .description('Modalidades (globais + do hub). Sem subcomando, lista.')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      emit(ctx.io, await ctx.client().request('get', '/modalities'));
    });

  group
    .command('create')
    .description('Cria uma modalidade do hub (reutilizável em qualquer prova).')
    .option('--name <name>')
    .option('--body <body>', 'JSON inline, @arquivo.json ou - (stdin)')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = command.optsWithGlobals() as GlobalFlags & { name?: string; body?: string };
      const base = (parseBody(flags.body) as Record<string, unknown> | undefined) ?? {};
      if (flags.name) base.name = flags.name;
      if (!base.name) {
        throw new CliUsageError('modality precisa de um nome.', 'Passe --name ou inclua "name" no --body.');
      }
      emit(ctx.io, await ctx.client().request('post', '/modalities', { body: base as never }));
    });

  group
    .command('question')
    .description('Define/atualiza a pergunta de opt-in de uma modalidade (responder no checkout entra nela).')
    .requiredOption('--modality <id>', 'id da modalidade')
    .option('--label <label>', 'texto da pergunta (ex.: "Sou morador?")')
    .option('--type <type>', 'checkbox|text|file|select|multiselect|textarea', 'checkbox')
    .option('--body <body>', 'JSON inline, @arquivo.json ou - (stdin)')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = command.optsWithGlobals() as GlobalFlags & { modality: string; label?: string; type?: string; body?: string };
      const base = (parseBody(flags.body) as Record<string, unknown> | undefined) ?? {};
      if (flags.label) base.label = flags.label;
      if (flags.type) base.type = flags.type;
      if (!base.label) {
        throw new CliUsageError('a pergunta precisa de um label.', 'Passe --label ou inclua "label" no --body.');
      }
      emit(ctx.io, await ctx.client().api('PUT', `/modalities/${encodeURIComponent(flags.modality)}/question`, { body: base }));
    });
}

function registerOrganizerLike(
  program: Command,
  deps: CliDeps,
  config: { name: string; listPath: '/organizers' | '/salespeople'; desc: string },
): void {
  const ctxOf = (command: Command) => new CliContext(command.optsWithGlobals() as GlobalFlags, deps);
  const group = program.command(config.name).description(`Gestão de ${config.desc}.`);

  group
    .command('list')
    .description(`Lista ${config.desc} (--all percorre todas as páginas).`)
    .option('--q <termo>', 'busca')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = command.optsWithGlobals() as GlobalFlags & { q?: string };
      // ?q não está tipado no spec (controller lê dinâmico) → escape hatch.
      const query: Record<string, string | number | undefined> = flags.q ? { q: flags.q } : {};
      if (flags.all) {
        emit(ctx.io, { data: await fetchAllPages(ctx.client(), config.listPath, query) });
        return;
      }
      emit(ctx.io, await ctx.client().api('GET', config.listPath, { query }));
    });

  group
    .command('create')
    .description(`Cria um ${config.name}.`)
    .option('--body <body>', 'JSON inline, @arquivo.json ou - (stdin)')
    .option('--name <name>')
    .option('--document <doc>')
    .action(async (_opts, command: Command) => {
      const ctx = ctxOf(command);
      const flags = command.optsWithGlobals() as GlobalFlags & { body?: string; name?: string; document?: string };
      const base = (parseBody(flags.body) as Record<string, unknown> | undefined) ?? {};
      if (flags.name) base.name = flags.name;
      if (flags.document) base.document = flags.document;
      if (!base.name) {
        throw new CliUsageError(`${config.name} precisa de um nome.`, 'Passe --name ou inclua "name" no --body.');
      }
      emit(ctx.io, await ctx.client().request('post', config.listPath, { body: base as never }));
    });
}
