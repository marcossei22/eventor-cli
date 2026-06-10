import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BASE_URL,
  looksLikeApiKey,
  MissingCredentialError,
  normalizeBaseUrl,
  readConfigFile,
  resolveConfig,
  writeConfigFile,
} from '../src/config.js';

const ENV_KEYS = ['EVENTOR_API_KEY', 'EVENTOR_BASE_URL', 'XDG_CONFIG_HOME'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tmpConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'eventor-cfg-')), 'config.json');
}

describe('resolveConfig — camadas', () => {
  it('flag tem precedência sobre env e arquivo', () => {
    process.env.EVENTOR_API_KEY = 'env_key';
    const path = tmpConfigPath();
    writeConfigFile({ apiKey: 'file_key', baseUrl: 'https://file.example/api/v1' }, path);

    const cfg = resolveConfig({ apiKey: 'flag_key', baseUrl: 'https://flag.example/api/v1' }, path);
    expect(cfg.apiKey).toBe('flag_key');
    expect(cfg.baseUrl).toBe('https://flag.example/api/v1');
  });

  it('env vem antes do arquivo', () => {
    process.env.EVENTOR_API_KEY = 'env_key';
    const path = tmpConfigPath();
    writeConfigFile({ apiKey: 'file_key', baseUrl: 'https://file.example/api/v1' }, path);

    const cfg = resolveConfig({}, path);
    expect(cfg.apiKey).toBe('env_key');
    // base_url não veio em env → cai no arquivo.
    expect(cfg.baseUrl).toBe('https://file.example/api/v1');
  });

  it('cai no arquivo quando não há flag nem env', () => {
    const path = tmpConfigPath();
    writeConfigFile({ apiKey: 'file_key', baseUrl: 'https://file.example/api/v1' }, path);
    expect(resolveConfig({}, path).apiKey).toBe('file_key');
  });

  it('usa o baseUrl default quando ninguém define', () => {
    expect(resolveConfig({ apiKey: 'k' }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('sem credencial em nenhuma camada → MissingCredentialError (exit 4)', () => {
    const path = tmpConfigPath();
    try {
      resolveConfig({}, path);
      throw new Error('deveria ter lançado');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingCredentialError);
      expect((e as MissingCredentialError).exitCode).toBe(4);
    }
  });
});

describe('config file', () => {
  it('grava com permissão 0600 e relê', () => {
    const path = tmpConfigPath();
    writeConfigFile({ apiKey: 'sk_live_abc', baseUrl: 'https://x/api/v1' }, path);

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);

    expect(readConfigFile(path)).toEqual({ api_key: 'sk_live_abc', base_url: 'https://x/api/v1' });
    // sanity: é JSON legível
    expect(JSON.parse(readFileSync(path, 'utf8')).api_key).toBe('sk_live_abc');
  });

  it('arquivo ausente → objeto vazio', () => {
    expect(readConfigFile('/no/such/eventor/config.json')).toEqual({});
  });
});

describe('helpers', () => {
  it('normalizeBaseUrl tira barras finais', () => {
    expect(normalizeBaseUrl('https://x/api/v1/')).toBe('https://x/api/v1');
    expect(normalizeBaseUrl('https://x/api/v1///')).toBe('https://x/api/v1');
  });

  it('looksLikeApiKey valida prefixo sk_live_ e tamanho', () => {
    expect(looksLikeApiKey('sk_live_'.padEnd(40, 'a'))).toBe(true);
    expect(looksLikeApiKey('nope')).toBe(false);
    expect(looksLikeApiKey('sk_live_short')).toBe(false);
  });
});
