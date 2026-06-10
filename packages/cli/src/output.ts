import type { Io } from './io.js';

/**
 * Emite o resultado de um comando no stdout, respeitando o contrato de I/O:
 *  - structured (pipe/agente ou --json) → JSON puro, sem prosa.
 *  - TTY humano → tabela pra listas de objetos planos, senão JSON indentado.
 */
export function emit(io: Io, data: unknown): void {
  if (io.structured) {
    io.out(JSON.stringify(data));
    return;
  }

  const rows = asTableRows(data);
  if (rows) {
    io.out(renderTable(rows));
    return;
  }

  io.out(JSON.stringify(data, null, 2));
}

/** Extrai `data` do envelope se for lista de objetos planos; senão null. */
function asTableRows(data: unknown): Array<Record<string, unknown>> | null {
  const list = unwrap(data);
  if (!Array.isArray(list) || list.length === 0) return null;
  const allFlatObjects = list.every(
    (item) => item !== null && typeof item === 'object' && !Array.isArray(item) && isFlat(item as Record<string, unknown>),
  );
  return allFlatObjects ? (list as Array<Record<string, unknown>>) : null;
}

function unwrap(data: unknown): unknown {
  if (data !== null && typeof data === 'object' && 'data' in data) {
    return (data as { data: unknown }).data;
  }
  return data;
}

function isFlat(obj: Record<string, unknown>): boolean {
  return Object.values(obj).every((v) => v === null || typeof v !== 'object');
}

function renderTable(rows: Array<Record<string, unknown>>): string {
  // Colunas: união das chaves preservando a ordem do primeiro item.
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => cell(r[col]).length)),
  );

  const header = columns.map((col, i) => col.toUpperCase().padEnd(widths[i]!)).join('  ');
  const body = rows
    .map((row) => columns.map((col, i) => cell(row[col]).padEnd(widths[i]!)).join('  '))
    .join('\n');

  return `${header}\n${body}`;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}
