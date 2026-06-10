import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { EventorError, ExitCode } from './errors.js';

/** Host canônico do go-live. A API key resolve o hub, então não há subdomínio por hub. */
export const DEFAULT_BASE_URL = 'https://eventor.run/api/v1';

/** Prefixo esperado das keys de produção (validação barata antes de bater na rede). */
export const API_KEY_PREFIX = 'sk_live_';

export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
}

export interface ConfigOverrides {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

interface ConfigFile {
  api_key?: string;
  base_url?: string;
}

/** Caminho do config (respeita XDG_CONFIG_HOME). Escrito por `eventor auth login`. */
export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'eventor', 'config.json');
}

export function readConfigFile(path = configPath()): ConfigFile {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as ConfigFile;
    }
  } catch {
    // ausente/ilegível → trata como vazio; a resolução decide se erra.
  }
  return {};
}

/** Grava o config com permissão 0600 (só o dono lê). Usado pelo `auth login`. */
export function writeConfigFile(data: ResolvedConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const body: ConfigFile = { api_key: data.apiKey, base_url: data.baseUrl };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Resolve a credencial em camadas explícitas (PRD §6.5):
 *   flag → env (EVENTOR_API_KEY/EVENTOR_BASE_URL) → config file → erro(exit 4).
 * `baseUrl` sempre tem default; só a `apiKey` é obrigatória.
 */
export function resolveConfig(overrides: ConfigOverrides = {}, path = configPath()): ResolvedConfig {
  const file = readConfigFile(path);

  const apiKey =
    overrides.apiKey?.trim() ||
    process.env.EVENTOR_API_KEY?.trim() ||
    file.api_key?.trim() ||
    '';

  const baseUrl =
    overrides.baseUrl?.trim() ||
    process.env.EVENTOR_BASE_URL?.trim() ||
    file.base_url?.trim() ||
    DEFAULT_BASE_URL;

  if (!apiKey) {
    throw new MissingCredentialError();
  }

  return { apiKey, baseUrl: normalizeBaseUrl(baseUrl) };
}

/** Tira a barra final pra concatenação previsível com os paths. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** `true` se a key tem cara de key de produção (prefixo `sk_live_`). */
export function looksLikeApiKey(key: string): boolean {
  return key.startsWith(API_KEY_PREFIX) && key.length >= 32;
}

/** Sem credencial em nenhuma camada → exit 4. */
export class MissingCredentialError extends EventorError {
  constructor() {
    super('Nenhuma API key encontrada.', {
      code: 'no_credential',
      hint: 'Passe --api-key, defina EVENTOR_API_KEY, ou rode `eventor auth login`. Gere a key (escopo `manage`) no painel do hub.',
    });
    this.name = 'MissingCredentialError';
  }

  override get exitCode(): ExitCode {
    return ExitCode.Unauthorized;
  }
}
