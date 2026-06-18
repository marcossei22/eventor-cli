import { EventorApiError, type EventorClient } from '@eventor-run/sdk';
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';

import { CliContext, type CliDeps, type GlobalFlags } from '../context.js';
import { CliUsageError } from '../errors.js';
import { emit } from '../output.js';

// ---- shape do spec.json (PRD §7.1) ------------------------------------------

interface EventSpec {
  event: Record<string, unknown> & { code?: string; name?: string };
  organizer?: Record<string, unknown> & { name?: string; document?: string };
  races?: Array<
    Record<string, unknown> & {
      name: string;
      // Modalidades da prova por NOME; o CLI resolve/cria (POST /modalities) → modality_ids.
      modalities?: string[];
      default_modality?: string;
      categories?: Array<Record<string, unknown> & { name: string; modalities?: string[] }>;
    }
  >;
  registration_settings?: Record<string, unknown>;
  batches?: Array<Record<string, unknown> & { name: string; race_prices?: Record<string, number> }>;
  registration_fields?: Array<Record<string, unknown> & { label: string }>;
  // Pergunta de opt-in por modalidade (nível hub) — quem responder no checkout entra na modalidade.
  modality_questions?: Array<{ modality: string; label: string; type?: string; options?: unknown }>;
  publish?: boolean;
}

type Action = 'created' | 'updated' | 'unchanged' | 'would_create' | 'would_update';
interface PlanEntry {
  resource: string;
  name: string;
  action: Action;
}

export function registerSetup(parent: Command, deps: CliDeps): void {
  parent
    .command('setup')
    .description('Configura um evento inteiro a partir de um spec.json (idempotente). Use --dry-run pra ver o plano.')
    .requiredOption('--from <file>', 'arquivo spec.json (ou - pra stdin)')
    .addHelpText(
      'after',
      `
spec.json descreve event + organizer + races(+categorias) + registration_settings
+ batches + registration_fields + publish. Em batches, race_prices usa o NOME da
prova (ex.: {"10K": 12900}, em centavos) — o CLI resolve pra race_id.

Exemplos:
  $ eventor event setup --from spec.json --dry-run   # plano, sem escrever
  $ eventor event setup --from spec.json             # aplica (re-rodar é seguro)
  $ cat spec.json | eventor event setup --from -`,
    )
    .action(async (_opts, command: Command) => {
      const flags = command.optsWithGlobals() as GlobalFlags & { from: string };
      const ctx = new CliContext(flags, deps);
      const apply = !flags.dryRun;

      const spec = loadSpec(flags.from);
      const runner = new SetupRunner(ctx.client(), apply, (msg) => ctx.io.info(msg));
      const result = await runner.run(spec);

      emit(ctx.io, { data: result });
    });
}

function loadSpec(from: string): EventSpec {
  let text: string;
  try {
    text = from === '-' ? readFileSync(0, 'utf8') : readFileSync(from, 'utf8');
  } catch {
    throw new CliUsageError(`Não consegui ler o spec: ${from}`, 'Aponte --from pra um arquivo JSON válido ou use - (stdin).');
  }
  let spec: EventSpec;
  try {
    spec = JSON.parse(text) as EventSpec;
  } catch {
    throw new CliUsageError('spec.json não é um JSON válido.');
  }
  if (!spec.event || typeof spec.event !== 'object') {
    throw new CliUsageError('spec.json precisa de um objeto "event".');
  }
  if (!spec.event.name && !spec.event.code) {
    throw new CliUsageError('event precisa de pelo menos "name" ou "code".');
  }
  return spec;
}

/** Orquestra organizer → event → races(+categories) → settings → batches → fields → publish. */
class SetupRunner {
  private readonly plan: PlanEntry[] = [];

  /** O evento já existe no hub? Enquanto não existe (ex.: dry-run de evento novo),
   *  não dá pra listar subrecursos dele — GET /events/{code}/races daria 404. */
  private eventExists = false;

  /** nome (lowercase) → id da modalidade (resolvido/criado em ensureModalities). */
  private readonly modalityIdByName = new Map<string, number | string>();

  constructor(
    private readonly client: EventorClient,
    private readonly apply: boolean,
    private readonly log: (msg: string) => void,
  ) {}

  async run(spec: EventSpec): Promise<{ plan: PlanEntry[]; event: unknown }> {
    const organizerId = await this.ensureOrganizer(spec.organizer);

    const eventKey = await this.ensureEvent(spec.event, organizerId);

    // Modalidades (nível hub) resolvidas/criadas por NOME → id, antes das provas.
    await this.ensureModalities(spec);

    const raceIdByName = new Map<string, number | string>();
    for (const race of spec.races ?? []) {
      const raceModalityIds = Array.isArray(race.modalities) ? this.resolveModalityIds(race.modalities) : [];
      const raceId = await this.ensureRace(eventKey, race);
      // Em dry-run a race "would_create" não tem id ainda — guarda um placeholder
      // pelo nome só pra validar as referências de race_prices (o body não é enviado).
      raceIdByName.set(race.name, raceId ?? `<${race.name}>`);
      if (raceId !== undefined) {
        for (const category of race.categories ?? []) {
          await this.ensureCategory(eventKey, raceId, category, raceModalityIds);
        }
      }
    }

    if (spec.registration_settings) {
      await this.applyRegistrationSettings(eventKey, spec.registration_settings);
    }

    for (const batch of spec.batches ?? []) {
      await this.ensureBatch(eventKey, batch, raceIdByName);
    }

    for (const field of spec.registration_fields ?? []) {
      await this.ensureField(eventKey, field);
    }

    for (const question of spec.modality_questions ?? []) {
      await this.ensureModalityQuestion(question);
    }

    if (spec.publish) {
      await this.publish(eventKey);
    }

    // Estado final (read-back) só quando aplicamos de fato.
    const event = this.apply ? await this.safeShow(eventKey) : null;
    return { plan: this.plan, event };
  }

  // --------------------------------------------------------------- organizer

  private async ensureOrganizer(organizer: EventSpec['organizer']): Promise<number | string | undefined> {
    if (!organizer?.name) return undefined;

    const existing = (await this.list('/organizers')).find((o) =>
      organizer.document ? str(o.document) === organizer.document : str(o.name) === organizer.name,
    );

    const action = this.decide(existing, organizer);
    this.record('organizer', organizer.name, action);

    if (existing) return num(existing.id);
    if (!this.apply) return undefined;

    const created = await this.write('POST', '/organizers', undefined, organizer);
    return num((created as Envelope).data?.id);
  }

  // ------------------------------------------------------------------- event

  private async ensureEvent(event: EventSpec['event'], organizerId: number | string | undefined): Promise<string> {
    const body = { ...event } as Record<string, unknown>;
    if (organizerId !== undefined && body.organizer_id === undefined) body.organizer_id = organizerId;

    const key = event.code ?? event.name!;
    const existing = await this.safeShow(key);

    const action = this.decide(existing ? (existing as Envelope).data : undefined, event);
    this.record('event', String(event.code ?? event.name), action);

    if (existing) {
      this.eventExists = true;
      const eventKey = String((existing as Envelope).data?.code ?? key);
      if (this.apply && action !== 'unchanged') {
        await this.write('PATCH', '/events/{event}', { event: eventKey }, body);
      }
      return eventKey;
    }

    if (!this.apply) return String(event.code ?? event.name);

    const created = await this.write('POST', '/events', undefined, body);
    this.eventExists = true; // criado agora → subrecursos já podem ser listados
    return String((created as Envelope).data?.code ?? (created as Envelope).data?.id);
  }

  // -------------------------------------------------------------- modalities

  /** Resolve por NOME as modalidades referenciadas no spec; cria as que faltam (POST /modalities). */
  private async ensureModalities(spec: EventSpec): Promise<void> {
    const names = new Set<string>();
    for (const race of spec.races ?? []) {
      for (const m of race.modalities ?? []) names.add(m);
      if (race.default_modality) names.add(race.default_modality);
      for (const cat of race.categories ?? []) for (const m of cat.modalities ?? []) names.add(m);
    }
    for (const q of spec.modality_questions ?? []) if (q.modality) names.add(q.modality);
    if (names.size === 0) return;

    for (const m of await this.list('/modalities')) {
      const id = num(m.id);
      if (id !== undefined) this.modalityIdByName.set(str(m.name).toLowerCase(), id);
    }

    for (const name of names) {
      const key = name.toLowerCase();
      if (this.modalityIdByName.has(key)) {
        this.record('modality', name, 'unchanged');
        continue;
      }
      this.record('modality', name, this.apply ? 'created' : 'would_create');
      if (this.apply) {
        const created = await this.write('POST', '/modalities', undefined, { name });
        const id = num((created as Envelope).data?.id);
        if (id !== undefined) this.modalityIdByName.set(key, id);
      } else {
        this.modalityIdByName.set(key, `<${name}>`); // placeholder dry-run (não é enviado)
      }
    }
  }

  private resolveModalityIds(names: string[]): Array<number | string> {
    return names.map((n) => this.resolveModalityId(n));
  }

  private resolveModalityId(name: string): number | string {
    const id = this.modalityIdByName.get(name.toLowerCase());
    if (id === undefined) {
      throw new CliUsageError(
        `Modalidade "${name}" não foi resolvida.`,
        'Use o mesmo nome em races[].modalities / categories[].modalities / modality_questions.',
      );
    }
    return id;
  }

  /** Pergunta de opt-in da modalidade (por hub). PUT idempotente. */
  private async ensureModalityQuestion(q: { modality: string; label: string; type?: string; options?: unknown }): Promise<void> {
    const id = this.resolveModalityId(q.modality);
    this.record('modality_question', `${q.modality}: ${q.label}`, this.apply ? 'updated' : 'would_update');
    if (this.apply && typeof id === 'number') {
      await this.write('PUT', '/modalities/{modality}/question', { modality: id }, {
        label: q.label,
        type: q.type ?? 'checkbox',
        ...(q.options !== undefined ? { options: q.options } : {}),
      });
    }
  }

  // -------------------------------------------------------------------- race

  private async ensureRace(eventKey: string, race: Record<string, unknown>): Promise<number | string | undefined> {
    // modalities(nome) → modality_ids(id) + default_modality(nome) → default_modality_id.
    const body = { ...race };
    delete body.modalities;
    delete body.default_modality;
    if (Array.isArray(race.modalities)) {
      const ids = this.resolveModalityIds(race.modalities as string[]);
      body.modality_ids = ids;
      const def = race.default_modality ? this.resolveModalityId(race.default_modality as string) : ids[0];
      if (def !== undefined) body.default_modality_id = def;
    }

    const existing = (await this.existingEventChildren('/events/{event}/races', { event: eventKey })).find(
      (r) => str(r.name) === str(race.name),
    );

    // modality_ids é array (shallowMatches ignora arrays); quando declarado, força o
    // sync do conjunto a cada run (idempotente no servidor).
    let action = this.decide(existing, body);
    if (existing && action === 'unchanged' && Array.isArray(body.modality_ids)) {
      action = this.apply ? 'updated' : 'would_update';
    }
    this.record('race', str(race.name), action);

    if (existing) {
      const id = num(existing.id);
      if (this.apply && action !== 'unchanged' && id !== undefined) {
        await this.write('PATCH', '/events/{event}/races/{race}', { event: eventKey, race: id }, body);
      }
      return id;
    }

    if (!this.apply) return undefined;
    const created = await this.write('POST', '/events/{event}/races', { event: eventKey }, body);
    return num((created as Envelope).data?.id);
  }

  private async ensureCategory(
    eventKey: string,
    raceId: number | string,
    category: Record<string, unknown>,
    raceModalityIds: Array<number | string>,
  ): Promise<void> {
    // categories[].modalities(nome) → modality_ids(id). Sem modalidades na categoria,
    // herda TODAS as da prova (default do Hub: categoria nasce em todas as modalidades).
    const body = { ...category };
    delete body.modalities;
    const modalityIds = Array.isArray(category.modalities)
      ? this.resolveModalityIds(category.modalities as string[])
      : raceModalityIds;
    if (modalityIds.length > 0) body.modality_ids = modalityIds;

    const existing = (
      await this.existingEventChildren('/events/{event}/races/{race}/categories', { event: eventKey, race: raceId })
    ).find((c) => str(c.name) === str(category.name));

    // Com modality_ids (array, ignorado por shallowMatches), força o reconcile do grupo.
    let action = this.decide(existing, body);
    if (existing && action === 'unchanged' && Array.isArray(body.modality_ids)) {
      action = this.apply ? 'updated' : 'would_update';
    }
    this.record('category', `${category.name}`, action);

    if (!this.apply) return;
    if (existing) {
      const id = num(existing.id);
      if (action !== 'unchanged' && id !== undefined) {
        await this.write(
          'PATCH',
          '/events/{event}/races/{race}/categories/{category}',
          { event: eventKey, race: raceId, category: id },
          body,
        );
      }
      return;
    }
    await this.write('POST', '/events/{event}/races/{race}/categories', { event: eventKey, race: raceId }, body);
  }

  // ------------------------------------------------------- registration settings

  private async applyRegistrationSettings(eventKey: string, settings: Record<string, unknown>): Promise<void> {
    this.record('registration_settings', eventKey, this.apply ? 'updated' : 'would_update');
    if (this.apply) {
      await this.write('PUT', '/events/{event}/registration-settings', { event: eventKey }, settings);
    }
  }

  // ------------------------------------------------------------------- batch

  private async ensureBatch(
    eventKey: string,
    batch: Record<string, unknown> & { name: string; race_prices?: Record<string, number> },
    raceIdByName: Map<string, number | string>,
  ): Promise<void> {
    const body = { ...batch } as Record<string, unknown>;
    if (batch.race_prices) {
      body.race_prices = this.mapRacePrices(batch.race_prices, raceIdByName);
    }

    const existing = (await this.existingEventChildren('/events/{event}/batches', { event: eventKey })).find(
      (b) => str(b.name) === str(batch.name),
    );

    const action = existing ? (this.apply ? 'updated' : 'would_update') : this.apply ? 'created' : 'would_create';
    this.record('batch', str(batch.name), action);

    if (!this.apply) return;
    if (existing) {
      const id = num(existing.id);
      if (id !== undefined) {
        await this.write('PATCH', '/events/{event}/batches/{batch}', { event: eventKey, batch: id }, body);
      }
      return;
    }
    await this.write('POST', '/events/{event}/batches', { event: eventKey }, body);
  }

  /** Traduz race_prices de nome-da-prova → race_id (IDs semânticos, PRD §7.1). */
  private mapRacePrices(
    prices: Record<string, number>,
    raceIdByName: Map<string, number | string>,
  ): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [raceName, price] of Object.entries(prices)) {
      const id = raceIdByName.get(raceName);
      if (id === undefined) {
        throw new CliUsageError(
          `race_prices referencia a prova "${raceName}", que não está em races.`,
          'Inclua a prova em "races" (com o mesmo nome) antes de precificá-la no lote.',
        );
      }
      out[String(id)] = price;
    }
    return out;
  }

  // ----------------------------------------------------------- registration fields

  private async ensureField(eventKey: string, field: Record<string, unknown> & { label: string }): Promise<void> {
    const existing = (await this.existingEventChildren('/events/{event}/registration-fields', { event: eventKey })).find(
      (f) => str(f.label) === str(field.label),
    );

    const action = this.decide(existing, field);
    this.record('registration_field', str(field.label), action);

    if (!this.apply) return;
    if (existing) {
      const id = num(existing.id);
      if (action !== 'unchanged' && id !== undefined) {
        await this.write('PATCH', '/events/{event}/registration-fields/{field}', { event: eventKey, field: id }, field);
      }
      return;
    }
    await this.write('POST', '/events/{event}/registration-fields', { event: eventKey }, field);
  }

  // ----------------------------------------------------------------- publish

  private async publish(eventKey: string): Promise<void> {
    this.record('publish', eventKey, this.apply ? 'updated' : 'would_update');
    if (this.apply) {
      await this.write('POST', '/events/{event}/publish', { event: eventKey }, undefined);
    }
  }

  // ----------------------------------------------------------------- helpers

  private async list(path: string, pathParams?: Record<string, string | number>): Promise<Array<Record<string, unknown>>> {
    const payload = (await this.client.api('GET', interpolate(path, pathParams), { query: { per_page: 200 } })) as Envelope;
    return Array.isArray(payload.data) ? (payload.data as Array<Record<string, unknown>>) : [];
  }

  /**
   * Lista subrecursos de um evento, mas só se o evento já existe. Quando ele
   * ainda não existe (dry-run de evento novo), o GET /events/{code}/... daria
   * 404 — então retorna [] e tudo cai naturalmente em "would_create".
   */
  private async existingEventChildren(
    path: string,
    pathParams: Record<string, string | number>,
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.eventExists) return [];
    return this.list(path, pathParams);
  }

  private async safeShow(key: string): Promise<unknown | undefined> {
    try {
      return await this.client.request('get', '/events/{event}', { path: { event: key } });
    } catch (err) {
      if (err instanceof EventorApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Escrita via escape hatch (paths dinâmicos com ids numéricos sem fricção de tipo). */
  private write(
    method: 'POST' | 'PATCH' | 'PUT',
    pathTemplate: string,
    params: Record<string, string | number> | undefined,
    body: unknown,
  ): Promise<unknown> {
    return this.client.api(method, interpolate(pathTemplate, params), { body });
  }

  private decide(existing: Record<string, unknown> | undefined, desired: Record<string, unknown>): Action {
    if (!existing) return this.apply ? 'created' : 'would_create';
    return shallowMatches(existing, desired)
      ? 'unchanged'
      : this.apply
        ? 'updated'
        : 'would_update';
  }

  private record(resource: string, name: string, action: Action): void {
    this.plan.push({ resource, name, action });
    this.log(`  ${action.padEnd(12)} ${resource} ${name}`);
  }
}

// ---- utils ------------------------------------------------------------------

interface Envelope {
  data?: Record<string, unknown> & { id?: unknown; code?: unknown };
}

function interpolate(path: string, params?: Record<string, string | number>): string {
  if (!params) return path;
  let out = path;
  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, encodeURIComponent(String(v)));
  return out;
}

/** Já está no estado desejado? Compara só as chaves presentes em `desired`. */
function shallowMatches(existing: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(desired)) {
    if (value === null || typeof value === 'object') continue; // ignora nested/relations
    // eslint-disable-next-line eqeqeq
    if (existing[key] != value) return false;
  }
  return true;
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function num(value: unknown): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return value;
  return undefined;
}
