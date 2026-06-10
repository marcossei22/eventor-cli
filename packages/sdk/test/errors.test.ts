import { describe, expect, it } from 'vitest';

import { EventorApiError, ExitCode, isApiErrorBody } from '../src/errors.js';

describe('EventorApiError.fromResponse', () => {
  it('preserva o envelope {error,message,details} e infere hint', () => {
    const err = EventorApiError.fromResponse(403, {
      error: 'forbidden_scope',
      message: 'A API key não tem o escopo `manage`.',
      details: null,
    });

    expect(err.status).toBe(403);
    expect(err.code).toBe('forbidden_scope');
    expect(err.message).toContain('manage');
    expect(err.hint).toMatch(/escopo `manage`/);
    expect(err.exitCode).toBe(ExitCode.Unauthorized); // 4
  });

  it('mapeia status → exit code', () => {
    const cases: Array<[number, number]> = [
      [401, ExitCode.Unauthorized],
      [403, ExitCode.Unauthorized],
      [404, ExitCode.NotFound],
      [409, ExitCode.Conflict],
      [422, ExitCode.Generic],
      [500, ExitCode.Generic],
    ];
    for (const [status, exit] of cases) {
      const err = EventorApiError.fromResponse(status, { error: 'x', message: 'm' });
      expect(err.exitCode, `status ${status}`).toBe(exit);
    }
  });

  it('faz fallback quando o corpo não vem no envelope', () => {
    const err = EventorApiError.fromResponse(500, 'Internal Server Error');
    expect(err.code).toBe('server_error');
    expect(err.message).toBe('Internal Server Error');
    expect(err.details).toBeNull();
  });

  it('details de validação ficam acessíveis', () => {
    const err = EventorApiError.fromResponse(422, {
      error: 'validation_failed',
      message: 'inválido',
      details: { name: ['obrigatório'] },
    });
    expect(err.details).toEqual({ name: ['obrigatório'] });
  });
});

describe('isApiErrorBody', () => {
  it('aceita só objetos com error+message string', () => {
    expect(isApiErrorBody({ error: 'x', message: 'y' })).toBe(true);
    expect(isApiErrorBody({ error: 'x' })).toBe(false);
    expect(isApiErrorBody('nope')).toBe(false);
    expect(isApiErrorBody(null)).toBe(false);
  });
});
