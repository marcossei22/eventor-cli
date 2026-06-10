import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { DEFAULT_BASE_URL, normalizeBaseUrl } from './config.js';
import { EventorApiError, EventorNetworkError } from './errors.js';
import type { paths } from './generated/types.js';

// ---------------------------------------------------------------------------
// Helper types derivados do OpenAPI (paths gerado por openapi-typescript).
// Dão cobertura tipada de 100% dos endpoints sem escrever tipo à mão.
// ---------------------------------------------------------------------------

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Paths que expõem um dado método (exclui os `method?: never`). */
export type PathsWithMethod<M extends HttpMethod> = {
  [P in keyof paths]: M extends keyof paths[P] ? (paths[P][M] extends undefined ? never : P) : never;
}[keyof paths];

type Operation<P extends keyof paths, M extends HttpMethod> = M extends keyof paths[P] ? paths[P][M] : never;

type PathParams<Op> = Op extends { parameters: { path: infer P } } ? P : never;
type QueryParams<Op> = Op extends { parameters: { query?: infer Q } } ? ([Q] extends [never] ? never : Q) : never;
type RequiredBody<Op> = Op extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;
type OptionalBody<Op> = Op extends { requestBody?: { content: { 'application/json': infer B } } } ? B : never;

type OkStatus = 200 | 201 | 202 | 204;
type JsonOf<R> = R extends { content: { 'application/json': infer C } } ? C : never;
type SuccessData<Op> = Op extends { responses: infer R }
  ? { [S in OkStatus & keyof R]: JsonOf<R[S]> }[OkStatus & keyof R]
  : never;

/** Resposta final: `null` quando a operação não devolve corpo (204). */
export type Result<P extends keyof paths, M extends HttpMethod> = [SuccessData<Operation<P, M>>] extends [never]
  ? null
  : SuccessData<Operation<P, M>>;

type CommonOptions = { headers?: Record<string, string>; signal?: AbortSignal };

type PathOption<Op> = [PathParams<Op>] extends [never] ? { path?: undefined } : { path: PathParams<Op> };
type QueryOption<Op> = [QueryParams<Op>] extends [never] ? { query?: undefined } : { query?: QueryParams<Op> };
type BodyOption<Op> = Op extends { requestBody: { content: { 'application/json': unknown } } }
  ? { body: RequiredBody<Op> }
  : [OptionalBody<Op>] extends [never]
    ? { body?: undefined }
    : { body?: OptionalBody<Op> };

/** Opções tipadas por (path, método): path/query/body com a obrigatoriedade certa. */
export type RequestOptions<P extends keyof paths, M extends HttpMethod> = PathOption<Operation<P, M>> &
  QueryOption<Operation<P, M>> &
  BodyOption<Operation<P, M>> &
  CommonOptions;

// Para os métodos onde TODAS as opções são opcionais, deixa o arg inteiro opcional.
type AllOptional<T> = object extends T ? true : false;

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export interface EventorClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injeção do fetch (testes). Default: global fetch do Node. */
  fetch?: typeof fetch;
  /** Sufixo de User-Agent (ex.: 'eventor-cli/1.2.3'). */
  userAgent?: string;
  /** Máximo de re-tentativas em 429/5xx/rede. Default 3. */
  maxRetries?: number;
  /** Base do backoff exponencial em ms. Default 300. */
  retryBaseMs?: number;
  /** Hook de espera (testes injetam pra não dormir de verdade). */
  sleep?: (ms: number) => Promise<void>;
}

interface RawRequest {
  method: HttpMethod;
  path: string;
  pathParams?: Record<string, string | number> | undefined;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /** multipart (upload) — quando setado, `body` é ignorado. */
  formData?: FormData | undefined;
}

const IDEMPOTENT: ReadonlySet<HttpMethod> = new Set(['get', 'put', 'delete']);

export class EventorClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EventorClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? `eventor-sdk/${SDK_VERSION}`;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 300;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch indisponível: use Node >= 20 ou injete options.fetch.');
    }
  }

  /**
   * Request tipado contra o spec. `path` aceita o template (ex.: '/events/{event}')
   * e os placeholders são preenchidos por `options.path`.
   */
  request<P extends PathsWithMethod<M>, M extends HttpMethod>(
    method: M,
    path: P,
    ...args: AllOptional<RequestOptions<P, M>> extends true
      ? [options?: RequestOptions<P, M>]
      : [options: RequestOptions<P, M>]
  ): Promise<Result<P, M>> {
    const options = (args[0] ?? {}) as {
      path?: Record<string, string | number>;
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    };

    return this.send({
      method,
      path: path as string,
      pathParams: options.path,
      query: options.query,
      body: options.body,
      headers: options.headers,
      signal: options.signal,
    }) as Promise<Result<P, M>>;
  }

  /**
   * Itera TODAS as páginas de um endpoint paginado (envelope {data,meta,links}),
   * usando meta.last_page. Equivale ao `--all` do CLI.
   */
  async *paginate<P extends PathsWithMethod<'get'>>(
    path: P,
    options?: RequestOptions<P, 'get'>,
  ): AsyncGenerator<PageItem<P>, void, unknown> {
    const base = (options ?? {}) as {
      path?: Record<string, string | number>;
      query?: Record<string, unknown>;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    };

    let page = 1;
    let lastPage = 1;

    do {
      const payload = (await this.send({
        method: 'get',
        path: path as string,
        pathParams: base.path,
        query: { ...base.query, page },
        headers: base.headers,
        signal: base.signal,
      })) as { data?: unknown; meta?: { last_page?: number; page?: number } } | null;

      const items = Array.isArray(payload?.data) ? payload.data : [];
      for (const item of items) {
        yield item as PageItem<P>;
      }

      lastPage = payload?.meta?.last_page ?? page;
      page += 1;
    } while (page <= lastPage);
  }

  /** Coleta todas as páginas num array só. */
  async all<P extends PathsWithMethod<'get'>>(
    path: P,
    options?: RequestOptions<P, 'get'>,
  ): Promise<PageItem<P>[]> {
    const items: PageItem<P>[] = [];
    for await (const item of this.paginate(path, options)) {
      items.push(item);
    }
    return items;
  }

  /**
   * Upload de arquivo por caminho local (o agente nunca monta multipart/base64).
   * Lê o arquivo do disco e manda como multipart no campo `field` (default 'file').
   */
  async upload<P extends PathsWithMethod<'post'>>(
    method: 'post',
    path: P,
    options: { file: string; field?: string } & PathOption<Operation<P, 'post'>> & CommonOptions,
  ): Promise<Result<P, 'post'>> {
    const opts = options as unknown as {
      file: string;
      field?: string;
      path?: Record<string, string | number>;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    };

    const bytes = await readFile(opts.file);
    const form = new FormData();
    form.append(opts.field ?? 'file', new Blob([new Uint8Array(bytes)]), basename(opts.file));

    return this.send({
      method,
      path: path as string,
      pathParams: opts.path,
      headers: opts.headers,
      signal: opts.signal,
      formData: form,
    }) as Promise<Result<P, 'post'>>;
  }

  /**
   * Escape hatch sem tipos: cobre qualquer endpoint. Tolera path com ou sem
   * `/v1` (normaliza). Usado pelo `eventor api` do CLI.
   */
  async api(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    return this.send({
      method: method.toLowerCase() as HttpMethod,
      path: stripVersionPrefix(path),
      query: options.query,
      body: options.body,
      headers: options.headers,
    });
  }

  // ----------------------------------------------------------------- interno

  private async send(req: RawRequest): Promise<unknown> {
    const url = this.buildUrl(req.path, req.pathParams, req.query);
    const canRetry = IDEMPOTENT.has(req.method);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, this.buildInit(req));
      } catch (cause) {
        // Erro de rede: transitório → re-tenta (com teto), senão estoura.
        if (attempt < this.maxRetries) {
          await this.backoff(attempt, null);
          attempt += 1;
          continue;
        }
        throw new EventorNetworkError(`Falha de rede ao chamar ${req.method.toUpperCase()} ${url}.`, {
          cause,
          transient: true,
        });
      }

      const retriableStatus = response.status === 429 || response.status >= 500;
      const retriable = retriableStatus && attempt < this.maxRetries && (response.status === 429 || canRetry);

      if (retriable) {
        await this.backoff(attempt, response.headers.get('retry-after'));
        attempt += 1;
        continue;
      }

      return this.parse(response);
    }
  }

  private buildInit(req: RawRequest): RequestInit {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      ...req.headers,
    };

    const init: RequestInit = { method: req.method.toUpperCase(), headers };
    if (req.signal) init.signal = req.signal;

    if (req.formData) {
      init.body = req.formData; // o runtime define o Content-Type (boundary).
    } else if (req.body !== undefined && req.method !== 'get') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(stripUndefined(req.body));
    }

    return init;
  }

  private buildUrl(
    path: string,
    pathParams?: Record<string, string | number>,
    query?: Record<string, unknown>,
  ): string {
    let resolved = path.startsWith('/') ? path : `/${path}`;

    if (pathParams) {
      for (const [key, value] of Object.entries(pathParams)) {
        resolved = resolved.replace(`{${key}}`, encodeURIComponent(String(value)));
      }
    }

    const url = new URL(`${this.baseUrl}${resolved}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  private async parse(response: Response): Promise<unknown> {
    if (response.status === 204) return null;

    const text = await response.text();
    const body: unknown = text.length > 0 ? safeJsonParse(text) : null;

    if (!response.ok) {
      throw EventorApiError.fromResponse(response.status, body);
    }

    return body;
  }

  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const fromHeader = parseRetryAfter(retryAfter);
    const exponential = this.retryBaseMs * 2 ** attempt;
    const jitter = exponential * 0.25 * deterministicJitter(attempt);
    await this.sleep(Math.max(fromHeader ?? 0, Math.round(exponential + jitter)));
  }
}

/** Tipo de cada item de uma página (o elemento de `data`). */
type PageItem<P extends PathsWithMethod<'get'>> = SuccessData<Operation<P, 'get'>> extends { data: infer D }
  ? D extends readonly (infer Item)[]
    ? Item
    : never
  : never;

// ---------------------------------------------------------------------------
// utilitários puros
// ---------------------------------------------------------------------------

export const SDK_VERSION = '0.1.1';

/** Remove chaves `undefined` recursivamente (a API valida; não mandar lixo). */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val !== undefined) out[key] = stripUndefined(val);
    }
    return out as T;
  }
  return value;
}

/** Tolera `/events`, `/v1/events` e `/api/v1/events` no escape hatch. */
export function stripVersionPrefix(path: string): string {
  return path
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/?(api\/)?v1\//, '/')
    .replace(/^(?!\/)/, '/');
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Retry-After em segundos ou HTTP-date → ms. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Jitter determinístico (sem Math.random) pra espalhar re-tentativas. */
function deterministicJitter(attempt: number): number {
  return ((attempt * 2654435761) % 1000) / 1000;
}
