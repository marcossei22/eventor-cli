import type { Command } from 'commander';

/**
 * Flags globais padrão. Declaradas na raiz E em cada comando-folha pra que o
 * agente possa colocá-las ANTES ou DEPOIS do comando (`eventor event list --json`
 * e `eventor --json event list` funcionam igual) — o commander parseia opção no
 * comando onde ela aparece.
 */
const GLOBAL_FLAGS: ReadonlyArray<[flag: string, description: string]> = [
  ['--json', 'força saída JSON mesmo em TTY'],
  ['-q, --quiet', 'silencia o stderr (progresso/avisos)'],
  ['--api-key <key>', 'API key do hub (override pontual)'],
  ['--base-url <url>', 'base da API (override pontual)'],
  ['--dry-run', 'mostra o que mudaria sem executar (comandos mutantes)'],
  ['--yes', 'pula confirmação destrutiva'],
  ['--all', 'paginação: percorre todas as páginas → um JSON'],
];

/** Idempotente: só adiciona a flag que ainda não existe (comandos podem já declarar algumas). */
export function addGlobalFlags(cmd: Command): Command {
  for (const [flag, description] of GLOBAL_FLAGS) {
    const long = flag.split(/[\s,]+/).find((token) => token.startsWith('--'));
    if (long && !cmd.options.some((o) => o.long === long)) {
      cmd.option(flag, description);
    }
  }
  return cmd;
}

/**
 * Prepara o programa pra rodar fora do processo (testável):
 *  - exitOverride em TODOS os comandos (subcomando não chama process.exit);
 *  - flags globais em cada folha (comando sem subcomandos).
 */
export function finalizeProgram(cmd: Command): void {
  cmd.exitOverride();
  if (cmd.commands.length === 0) {
    addGlobalFlags(cmd);
    return;
  }
  for (const sub of cmd.commands) {
    finalizeProgram(sub);
  }
}
