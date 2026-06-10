import type { Writable } from 'node:stream';

/**
 * Contrato de I/O — a regra que governa tudo (PRD §3.1):
 *   stdout = DADOS.  stderr = HUMANOS.
 * Sem TTY (pipe/agente) o stdout é JSON puro; banner/progresso vão pro stderr.
 */
export interface IoOptions {
  json?: boolean;
  quiet?: boolean;
  stdout?: Writable;
  stderr?: Writable;
  isTTY?: boolean;
  noColor?: boolean;
}

export class Io {
  /** Força JSON no stdout mesmo em TTY. */
  readonly json: boolean;
  /** Silencia o stderr (progresso/avisos). */
  readonly quiet: boolean;
  readonly isTTY: boolean;
  readonly color: boolean;

  private readonly stdout: Writable;
  private readonly stderr: Writable;

  constructor(options: IoOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.isTTY = options.isTTY ?? Boolean((process.stdout as { isTTY?: boolean }).isTTY);
    this.json = options.json ?? false;
    this.quiet = options.quiet ?? false;
    this.color = !(options.noColor ?? Boolean(process.env.NO_COLOR)) && this.isTTY;
  }

  /** `true` quando a saída deve ser JSON puro (pipe/agente ou --json). */
  get structured(): boolean {
    return this.json || !this.isTTY;
  }

  /** Escreve dados no stdout. */
  out(text: string): void {
    this.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** Escreve mensagem pra humano no stderr (suprimida por --quiet). */
  info(text: string): void {
    if (this.quiet) return;
    this.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** Erro sempre no stderr (mesmo com --quiet, pra não engolir falha). */
  error(text: string): void {
    this.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  }
}
