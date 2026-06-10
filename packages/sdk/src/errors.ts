/**
 * Erros do SDK e o mapeamento HTTP → exit code semântico que o CLI (9.C) usa.
 *
 * O envelope de erro da Management API é `{ error, message, details }`. O SDK
 * preserva isso e acrescenta um `hint` acionável (o "próximo comando"), que é a
 * prática de maior ROI pra auto-recuperação do agente (PRD §6.3).
 */

/** Exit codes semânticos (PRD §6.2). Reexportados pelo CLI. */
export const ExitCode = {
  Ok: 0,
  Generic: 1,
  Usage: 2,
  NotFound: 3,
  Unauthorized: 4,
  Conflict: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Corpo de erro da API (envelope `{error,message,details}`). */
export interface ApiErrorBody {
  error: string;
  message: string;
  details?: Record<string, unknown> | null;
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).error === 'string' &&
    typeof (value as Record<string, unknown>).message === 'string'
  );
}

interface EventorErrorOptions {
  code?: string;
  hint?: string;
  cause?: unknown;
}

/** Base de todos os erros do SDK. */
export class EventorError extends Error {
  /** Código machine-parseable (enum), quando houver. */
  readonly code?: string;
  /** Dica acionável apontando o próximo passo. */
  readonly hint?: string;

  constructor(message: string, options: EventorErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'EventorError';
    this.code = options.code;
    this.hint = options.hint;
  }

  /** Exit code semântico (default: genérico). Sobrescrito nas subclasses. */
  get exitCode(): ExitCode {
    return ExitCode.Generic;
  }
}

/**
 * Erro retornado pela API (status >= 400 com envelope `{error,message,details}`).
 */
export class EventorApiError extends EventorError {
  readonly status: number;
  readonly details?: Record<string, unknown> | null;

  constructor(
    status: number,
    body: ApiErrorBody,
    options: { hint?: string } = {},
  ) {
    super(body.message, { code: body.error, hint: options.hint ?? hintForErrorCode(body.error) });
    this.name = 'EventorApiError';
    this.status = status;
    this.details = body.details ?? null;
  }

  /** Constrói a partir de uma resposta HTTP, com fallback se o corpo não vier no envelope. */
  static fromResponse(status: number, body: unknown): EventorApiError {
    if (isApiErrorBody(body)) {
      return new EventorApiError(status, body);
    }

    return new EventorApiError(status, {
      error: fallbackCodeForStatus(status),
      message: typeof body === 'string' && body.length > 0 ? body : `Requisição falhou com HTTP ${status}.`,
      details: null,
    });
  }

  override get exitCode(): ExitCode {
    if (this.status === 401 || this.status === 403) return ExitCode.Unauthorized;
    if (this.status === 404) return ExitCode.NotFound;
    if (this.status === 409) return ExitCode.Conflict;
    if (this.status >= 500) return ExitCode.Generic;
    return ExitCode.Generic;
  }
}

/** Falha de rede/transporte (DNS, timeout, conexão recusada). */
export class EventorNetworkError extends EventorError {
  /** Transitório → vale a pena re-tentar (vs permanente). */
  readonly transient: boolean;

  constructor(message: string, options: EventorErrorOptions & { transient?: boolean } = {}) {
    super(message, options);
    this.name = 'EventorNetworkError';
    this.transient = options.transient ?? true;
  }
}

function fallbackCodeForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'invalid_api_key';
    case 403:
      return 'forbidden_scope';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 422:
      return 'validation_failed';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'server_error' : 'request_failed';
  }
}

/** Dicas-base por código de erro conhecido. O CLI pode enriquecer com o comando exato. */
function hintForErrorCode(code: string): string | undefined {
  switch (code) {
    case 'invalid_api_key':
      return 'Confira a API key (Authorization: Bearer <key>). Gere/regenere no painel do hub.';
    case 'forbidden_scope':
      return 'A key precisa do escopo `manage`. Regenere a key habilitando esse escopo.';
    case 'rate_limited':
      return 'Limite de 300/min atingido — aguarde e re-tente (o SDK já respeita Retry-After).';
    case 'validation_failed':
      return 'Confira os campos enviados em `details`.';
    default:
      return undefined;
  }
}
