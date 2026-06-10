# eventor-cli

Cliente **headless** da [Management API do Eventor](https://eventor.run) (`/api/v1`), desenhado com um **agente de IA como usuário primário**. Monorepo com três pacotes sobre um SDK tipado único:

| Pacote | O que é | Status |
|---|---|---|
| [`@eventor/sdk`](packages/sdk) | Cliente HTTP tipado (auth, retry, paginação, upload). Núcleo. | ✅ **9.B** |
| [`@eventor/cli`](packages/cli) | Binário `eventor` (commander). | ✅ **9.C** |
| `@eventor/mcp` | Servidor MCP com tools auto-geradas do spec. | ⏳ 9.E |

A **fonte de verdade** é o OpenAPI 3.1 em [`openapi/eventor-v1.json`](openapi/eventor-v1.json) (gerado pelo backend Laravel). Os tipos do SDK são gerados dele — endpoint novo na API = tipo novo no cliente, sem código escrito à mão.

## Requisitos

- Node ≥ 20 (usa `fetch`/`FormData` nativos — **zero dependência de runtime**)
- pnpm 10

## Setup

```bash
pnpm install
pnpm gen        # regenera os tipos a partir de openapi/eventor-v1.json
pnpm build      # compila os pacotes
pnpm test       # roda os testes
pnpm typecheck
```

## SDK em 30 segundos

```ts
import { EventorClient, createClient } from '@eventor/sdk';

// credencial em camadas: flag → EVENTOR_API_KEY → ~/.config/eventor/config.json
const sdk = createClient({ apiKey: process.env.EVENTOR_API_KEY });

// request tipado (path/query/body inferidos do OpenAPI):
const event = await sdk.request('get', '/events/{event}', { path: { event: 'MAR2026' } });

// paginação automática:
const all = await sdk.all('/events', { query: { status: 'published' } });

// upload por caminho local (sem montar multipart na mão):
await sdk.upload('post', '/events/{event}/logo', { path: { event: 'MAR2026' }, file: './logo.png' });

// escape hatch sem tipos (cobre 100% do spec):
await sdk.api('POST', '/events', { body: { name: 'Maratona' } });
```

### O que o SDK entrega (9.B)

- **Tipos gerados** do OpenAPI (`request`/`all`/`paginate`/`upload` totalmente tipados).
- **Credencial em camadas** (flag → env → config file `0600` → erro `exit 4`).
- **Retry/backoff** exponencial em `429`/`5xx`, respeitando `Retry-After`. `POST`/`PATCH` **não** re-tentam em `5xx` (evita duplicar escrita); `429` re-tenta sempre.
- **Paginação** via `meta.last_page` (`all()` / `paginate()`).
- **Upload** por caminho de arquivo (lê do disco, monta multipart).
- **Erros** preservam o envelope `{error,message,details}` + `hint` acionável e expõem **exit code semântico** (`EventorApiError.exitCode`) pro CLI.

## CLI (`eventor`) — 9.C

Desenhado com **stdout = dados, stderr = humanos**. Sem TTY (pipe/agente) o stdout é JSON puro.

```bash
eventor auth login --api-key sk_live_...        # valida em /me e grava ~/.config/eventor/config.json (0600)
eventor event list --json | jq '.data[].code'   # dados no stdout
eventor event setup --from spec.json --dry-run  # mostra o plano (would_create/would_update/unchanged)
eventor event setup --from spec.json            # executa idempotente (organizer→event→races→batches→…)
eventor event publish --event MAR2026
eventor api GET /events --all                    # escape hatch: cobre 100% do spec, --all pagina tudo
```

- **Exit codes semânticos:** `0` ok · `1` genérico/5xx · `2` uso · `3` not_found · `4` unauthorized · `5` conflict.
- **Erro acionável:** todo erro vira `{"error":{"code","message","hint"}}` no stderr; o agente lê `code` (decide) e `hint` (próximo comando).
- **`event setup`:** workflow consolidado e idempotente; `race_prices` aceita o **nome da prova** (resolvido pra `race_id`); `--dry-run` só faz GETs.
- **Destrutivo (`api DELETE`)** exige `--yes` (agente em CI nunca fica pendurado).
- **`eventor skill install`** instala o [`SKILL.md`](packages/cli/SKILL.md) em `~/.claude/skills/eventor/` — ensina o agente quando/como usar o CLI. `--help` em qualquer comando traz exemplos copiáveis + a tabela de exit codes.

## Publicando no npm (`@eventor/cli` + `@eventor/sdk`)

A publicação é automática ao empurrar uma tag `vX.Y.Z` (workflow [`release.yml`](.github/workflows/release.yml)). Pré-requisitos, **uma vez**:

1. Criar a org **`eventor`** no [npmjs.com](https://www.npmjs.com/org/create) (grátis para pacotes públicos).
2. Gerar um **automation token** (Account → Access Tokens → Granular/Automation, **só publish**) e salvá-lo como secret **`NPM_TOKEN`** do repositório (Settings → Secrets → Actions). É revogável — não é a credencial pessoal.

Depois, a cada release:

```bash
# bump das versões em packages/sdk e packages/cli, commit, então:
git tag v0.1.0 && git push origin v0.1.0   # dispara o workflow → publica sdk depois cli
```

O `pnpm -r publish` publica em ordem (sdk antes do cli) e converte `workspace:*` na versão real. O binário instalado chama-se `eventor` independentemente do nome do pacote (`npx @eventor/cli ...` para uso pontual).

## Decisões (PRD `cli-eventor-headless` §13–14)

- Repo separado do backend Laravel; **CLI antes do MCP**; **commander**; OpenAPI como fonte de verdade.
- Base URL default: `https://eventor.run/api/v1` (sobrescrevível por `--base-url` / `EVENTOR_BASE_URL`).
- Distribuição npm (`@eventor/cli`): decisão da **9.D**.
