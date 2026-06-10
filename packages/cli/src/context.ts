import { createClient, type EventorClient, type EventorClientOptions } from '@eventor/sdk';

import { NoTtyError } from './errors.js';
import { Io } from './io.js';

export interface GlobalFlags {
  json?: boolean;
  quiet?: boolean;
  apiKey?: string;
  baseUrl?: string;
  dryRun?: boolean;
  yes?: boolean;
  all?: boolean;
}

/** Fábrica de client — injetável nos testes (mock de fetch). */
export type ClientFactory = (
  overrides: { apiKey?: string; baseUrl?: string },
  options?: Omit<EventorClientOptions, 'apiKey' | 'baseUrl'>,
) => EventorClient;

export interface CliDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  isTTY?: boolean;
  clientFactory?: ClientFactory;
  userAgent?: string;
}

const defaultFactory: ClientFactory = (overrides, options) => createClient(overrides, options);

/** Estado de um comando: io + flags + client resolvido sob demanda. */
export class CliContext {
  readonly io: Io;
  readonly flags: GlobalFlags;

  private readonly factory: ClientFactory;
  private readonly userAgent: string;
  private clientInstance?: EventorClient;

  constructor(flags: GlobalFlags, deps: CliDeps = {}) {
    this.flags = flags;
    this.factory = deps.clientFactory ?? defaultFactory;
    this.userAgent = deps.userAgent ?? `eventor-cli/${CLI_VERSION}`;
    this.io = new Io({
      json: flags.json ?? false,
      quiet: flags.quiet ?? false,
      stdout: deps.stdout as never,
      stderr: deps.stderr as never,
      ...(deps.isTTY !== undefined ? { isTTY: deps.isTTY } : {}),
    });
  }

  /** Resolve a credencial em camadas (pode lançar MissingCredentialError → exit 4). */
  client(): EventorClient {
    if (!this.clientInstance) {
      const overrides: { apiKey?: string; baseUrl?: string } = {};
      if (this.flags.apiKey) overrides.apiKey = this.flags.apiKey;
      if (this.flags.baseUrl) overrides.baseUrl = this.flags.baseUrl;
      this.clientInstance = this.factory(overrides, { userAgent: this.userAgent });
    }
    return this.clientInstance;
  }

  /** Operações destrutivas exigem --yes (agente em CI nunca fica pendurado). */
  ensureConfirmed(): void {
    if (!this.flags.yes) {
      throw new NoTtyError('Operação destrutiva. Repita com --yes pra confirmar.');
    }
  }
}

export const CLI_VERSION = '0.1.0';
