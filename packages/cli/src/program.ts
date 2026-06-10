import { Command, CommanderError } from 'commander';

import { registerApi } from './commands/api.js';
import { registerAuth } from './commands/auth.js';
import { registerDiscovery } from './commands/discovery.js';
import { registerEvent } from './commands/event.js';
import { registerSetup } from './commands/setup.js';
import { registerSkill } from './commands/skill.js';
import { CLI_VERSION, type CliDeps } from './context.js';
import { CliUsageError, reportError } from './errors.js';
import { addGlobalFlags, finalizeProgram } from './flags.js';
import { Io } from './io.js';

const HELP_CODES = new Set(['commander.helpDisplayed', 'commander.help', 'commander.version']);

export function buildProgram(deps: CliDeps): Command {
  const program = new Command();

  program
    .name('eventor')
    .description('Cliente headless da Management API do Eventor — configura eventos ponta a ponta.')
    .version(CLI_VERSION, '-v, --version', 'mostra a versão');
  addGlobalFlags(program);

  // stdout = dados (help/version). stderr de erro é engolido: emitimos nosso
  // próprio envelope {error:{code,message,hint}} de forma consistente.
  program.configureOutput({
    writeOut: (str) => void (deps.stdout ?? process.stdout).write(str),
    writeErr: () => {},
  });

  registerAuth(program, deps);
  registerApi(program, deps);
  const eventCmd = registerEvent(program, deps);
  registerDiscovery(program, deps);
  registerSetup(eventCmd, deps); // `eventor event setup`
  registerSkill(program, deps);

  program.addHelpText('after', HELP_EPILOG);

  finalizeProgram(program);
  return program;
}

const HELP_EPILOG = `
Exemplos:
  $ eventor auth login --api-key sk_live_...            # grava credencial (0600)
  $ eventor event setup --from spec.json --dry-run      # plano sem escrever
  $ eventor event setup --from spec.json                # configura tudo (idempotente)
  $ eventor event publish --event MAR2026
  $ eventor event list --json | jq '.data[].code'       # dados no stdout
  $ eventor api GET /events --all | jq '.data | length' # escape hatch + paginação

Exit codes:
  0 ok    1 erro/5xx    2 uso    3 not_found    4 unauthorized    5 conflict

Saída: stdout = dados (JSON em pipe/--json), stderr = humano/erros.
Credencial: --api-key > EVENTOR_API_KEY > ~/.config/eventor/config.json.`;

/**
 * Roda o CLI e devolve o exit code (sem chamar process.exit — testável).
 * Toda falha vira o envelope `{error:{code,message,hint}}` no stderr.
 */
export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io = new Io({
    stdout: deps.stdout as never,
    stderr: deps.stderr as never,
    ...(deps.isTTY !== undefined ? { isTTY: deps.isTTY } : {}),
  });

  try {
    const program = buildProgram(deps); // finalizeProgram() já aplicou exitOverride recursivo
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (HELP_CODES.has(err.code)) return 0;
      // Erro de uso do commander (opção desconhecida, arg faltando) → exit 2.
      return reportError(new CliUsageError(err.message.replace(/^error:\s*/i, '')), io);
    }
    return reportError(err, io);
  }
}
