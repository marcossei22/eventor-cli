/**
 * @eventor-run/sdk — cliente HTTP tipado da Management API do Eventor.
 *
 * Núcleo único consumido pelo CLI (9.C) e pelo MCP (9.E). Tipos gerados do
 * OpenAPI; auth em camadas; retry/backoff; paginação; upload por caminho.
 */

export { EventorClient, SDK_VERSION, stripUndefined, stripVersionPrefix } from './client.js';
export type { EventorClientOptions, HttpMethod, PathsWithMethod, RequestOptions, Result } from './client.js';

export {
  API_KEY_PREFIX,
  configPath,
  DEFAULT_BASE_URL,
  looksLikeApiKey,
  MissingCredentialError,
  normalizeBaseUrl,
  readConfigFile,
  resolveConfig,
  writeConfigFile,
} from './config.js';
export type { ConfigOverrides, ResolvedConfig } from './config.js';

export {
  ExitCode,
  EventorApiError,
  EventorError,
  EventorNetworkError,
  isApiErrorBody,
} from './errors.js';
export type { ApiErrorBody } from './errors.js';

// Tipos gerados do OpenAPI — disponíveis pra quem consome o SDK tipar payloads.
export type { components, operations, paths } from './generated/types.js';

import { EventorClient, type EventorClientOptions } from './client.js';
import { resolveConfig, type ConfigOverrides } from './config.js';

/**
 * Cria um client resolvendo a credencial em camadas (flag → env → config → erro).
 * Açúcar pro CLI: `const sdk = createClient({ apiKey: flags.apiKey });`
 */
export function createClient(
  overrides: ConfigOverrides = {},
  options: Omit<EventorClientOptions, 'apiKey' | 'baseUrl'> = {},
): EventorClient {
  const { apiKey, baseUrl } = resolveConfig(overrides);
  return new EventorClient({ apiKey, baseUrl, ...options });
}
