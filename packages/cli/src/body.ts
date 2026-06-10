import { readFileSync } from 'node:fs';

import { CliUsageError } from './errors.js';

/**
 * Resolve o `--body` em três formas (PRD §5.3):
 *   '{...}'        inline JSON
 *   @arquivo.json  lê do disco
 *   -              lê do stdin
 * Retorna `undefined` se não houver body.
 */
export function parseBody(raw: string | undefined, stdin: () => string = readStdin): unknown {
  if (raw === undefined) return undefined;

  let text: string;
  if (raw === '-') {
    text = stdin();
  } else if (raw.startsWith('@')) {
    const path = raw.slice(1);
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      throw new CliUsageError(`Não consegui ler o arquivo de body: ${path}`, 'Confira o caminho passado em --body @arquivo.');
    }
  } else {
    text = raw;
  }

  text = text.trim();
  if (text.length === 0) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    throw new CliUsageError('--body não é um JSON válido.', 'Passe JSON inline, @arquivo.json ou - (stdin).');
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Converte `--set chave=valor` repetido num objeto (valores JSON quando possível). */
export function parseSetFlags(pairs: string[] | undefined): Record<string, unknown> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      throw new CliUsageError(`--set inválido: "${pair}"`, 'Use --set chave=valor.');
    }
    const key = pair.slice(0, idx);
    const rawValue = pair.slice(idx + 1);
    out[key] = coerce(rawValue);
  }
  return out;
}

function coerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}
