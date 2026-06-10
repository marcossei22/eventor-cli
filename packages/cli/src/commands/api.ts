import type { Command } from 'commander';

import { parseBody } from '../body.js';
import { CliContext, type CliDeps, type GlobalFlags } from '../context.js';
import { CliUsageError } from '../errors.js';
import { emit } from '../output.js';
import { fetchAllPages } from '../paginate.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Escape hatch: `eventor api <METHOD> <path>` cobre 100% do spec, mesmo endpoints
 * sem comando dedicado. Tolera /events, /v1/events e a URL completa.
 */
export function registerApi(program: Command, deps: CliDeps): void {
  program
    .command('api')
    .description('Chama qualquer endpoint cru: eventor api GET /events --query status=published')
    .argument('<method>', 'GET|POST|PUT|PATCH|DELETE')
    .argument('<path>', 'caminho do endpoint (ex.: /events ou /events/MAR2026/batches)')
    .option('--body <body>', "JSON inline, @arquivo.json ou - (stdin)")
    .option('--query <pair...>', 'parâmetro de query chave=valor (repetível)')
    .action(async (method: string, path: string, _opts, command: Command) => {
      const flags = command.optsWithGlobals() as GlobalFlags & { body?: string; query?: string[] };
      const ctx = new CliContext(flags, deps);

      const upper = method.toUpperCase();
      if (!METHODS.has(upper)) {
        throw new CliUsageError(`Método inválido: ${method}`, 'Use GET, POST, PUT, PATCH ou DELETE.');
      }

      // DELETE é destrutivo: exige --yes (agente em CI nunca fica pendurado).
      if (upper === 'DELETE') {
        ctx.ensureConfirmed();
      }

      const body = parseBody(flags.body);
      const query = parseQuery(flags.query);

      // --all só faz sentido em GET de coleção: percorre todas as páginas.
      if (upper === 'GET' && flags.all) {
        const items = await fetchAllPages(ctx.client(), path, query ?? {});
        emit(ctx.io, { data: items });
        return;
      }

      const result = await ctx.client().api(upper, path, { body, query });
      emit(ctx.io, result);
    });
}

function parseQuery(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) throw new CliUsageError(`--query inválido: "${pair}"`, 'Use --query chave=valor.');
    out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}
