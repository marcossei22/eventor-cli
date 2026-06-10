import {
  configPath,
  DEFAULT_BASE_URL,
  EventorClient,
  looksLikeApiKey,
  readConfigFile,
  writeConfigFile,
} from '@eventor/sdk';
import { rmSync } from 'node:fs';
import type { Command } from 'commander';

import { CliContext, type CliDeps, type GlobalFlags } from '../context.js';
import { CliUsageError } from '../errors.js';
import { emit } from '../output.js';

interface MeResponse {
  data: { hub: { id: number | string; name: string; slug: string }; scopes: string[] };
}

export function registerAuth(program: Command, deps: CliDeps): void {
  const auth = program.command('auth').description('Login, status e logout da credencial.');

  auth
    .command('login')
    .description('Valida a API key no endpoint /me e grava ~/.config/eventor/config.json (0600).')
    .option('--api-key <key>', 'API key do hub (escopo manage).')
    .option('--base-url <url>', 'Base da API (default eventor.run).')
    .action(async (_opts, command: Command) => {
      const flags = command.optsWithGlobals() as GlobalFlags;
      const ctx = new CliContext(flags, deps);

      const apiKey = flags.apiKey?.trim();
      if (!apiKey) {
        throw new CliUsageError('Faltou a API key.', 'Passe --api-key sk_live_... (gere no painel do hub, escopo manage).');
      }
      if (!looksLikeApiKey(apiKey)) {
        ctx.io.info('aviso: a key não tem o prefixo sk_live_ — seguindo mesmo assim.');
      }

      const baseUrl = flags.baseUrl?.trim() || DEFAULT_BASE_URL;
      const client = makeClient(apiKey, baseUrl, deps);

      // /me valida key + escopo manage (a rota exige manage) sem efeito colateral.
      const me = (await client.request('get', '/me')) as MeResponse;

      writeConfigFile({ apiKey, baseUrl });

      emit(ctx.io, {
        data: { hub: me.data.hub, scopes: me.data.scopes, saved_to: configPath() },
      });
      ctx.io.info(`✓ logado no hub "${me.data.hub.name}" (escopos: ${me.data.scopes.join(', ')}).`);
    });

  auth
    .command('status')
    .description('Mostra o hub e os escopos da credencial atual.')
    .action(async (_opts, command: Command) => {
      const flags = command.optsWithGlobals() as GlobalFlags;
      const ctx = new CliContext(flags, deps);
      const me = (await ctx.client().request('get', '/me')) as MeResponse;
      emit(ctx.io, { data: { hub: me.data.hub, scopes: me.data.scopes, config: configPath() } });
    });

  auth
    .command('logout')
    .description('Apaga a credencial gravada localmente.')
    .action((_opts, command: Command) => {
      const flags = command.optsWithGlobals() as GlobalFlags;
      const ctx = new CliContext(flags, deps);
      const path = configPath();
      const existed = Object.keys(readConfigFile(path)).length > 0;
      try {
        rmSync(path, { force: true });
      } catch {
        // já não existia — idempotente.
      }
      emit(ctx.io, { data: { removed: existed, config: path } });
    });
}

function makeClient(apiKey: string, baseUrl: string, deps: CliDeps): EventorClient {
  // auth login usa a key explícita (não a resolução em camadas). Respeita a
  // injeção de client dos testes quando presente.
  if (deps.clientFactory) {
    return deps.clientFactory({ apiKey, baseUrl }, { userAgent: deps.userAgent ?? 'eventor-cli' });
  }
  return new EventorClient({ apiKey, baseUrl, userAgent: deps.userAgent ?? 'eventor-cli' });
}
