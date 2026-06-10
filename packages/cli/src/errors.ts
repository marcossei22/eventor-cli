import { EventorApiError, EventorError, EventorNetworkError, ExitCode } from '@eventor-run/sdk';

import type { Io } from './io.js';

/** Erro de uso do CLI (flag inválida, falta arg, confirmação ausente). Exit 2. */
export class CliUsageError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CliUsageError';
    this.hint = hint;
  }
}

/** Precisaria de confirmação interativa e não há TTY (PRD §6.4). Exit 2. */
export class NoTtyError extends CliUsageError {
  constructor(hint = 'Repita com --yes, ou passe --api-key=... em vez de logar interativamente.') {
    super('Confirmação interativa necessária e nenhum TTY disponível.', hint);
    this.name = 'NoTtyError';
  }
}

interface ErrorEnvelope {
  error: { code: string; message: string; hint?: string };
}

/** Monta o envelope `{error:{code,message,hint}}` (PRD §6.3) a partir de qualquer erro. */
export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  if (err instanceof EventorApiError) {
    return envelope(err.code ?? 'api_error', err.message, err.hint);
  }
  if (err instanceof EventorNetworkError) {
    return envelope(err.code ?? 'network_error', err.message, err.hint);
  }
  if (err instanceof NoTtyError) {
    return envelope('no_tty', err.message, err.hint);
  }
  if (err instanceof CliUsageError) {
    return envelope('usage_error', err.message, err.hint);
  }
  if (err instanceof EventorError) {
    return envelope(err.code ?? 'error', err.message, err.hint);
  }
  if (err instanceof Error) {
    return envelope('error', err.message, undefined);
  }
  return envelope('error', String(err), undefined);
}

/** Mapeia o erro pro exit code semântico (PRD §6.2). */
export function exitCodeFor(err: unknown): number {
  if (err instanceof CliUsageError) return ExitCode.Usage; // 2
  if (err instanceof EventorError) return err.exitCode;
  return ExitCode.Generic; // 1
}

/** Imprime o erro no stderr (sempre) e devolve o exit code. */
export function reportError(err: unknown, io: Io): number {
  const env = toErrorEnvelope(err);
  io.error(JSON.stringify(env, null, io.structured ? 0 : 2));
  return exitCodeFor(err);
}

function envelope(code: string, message: string, hint: string | undefined): ErrorEnvelope {
  const error: ErrorEnvelope['error'] = { code, message };
  if (hint) error.hint = hint;
  return { error };
}
