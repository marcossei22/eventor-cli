---
name: eventor
description: Configura eventos de corrida na plataforma Eventor de ponta a ponta (criar, precificar, publicar) via o CLI `eventor`. Use quando precisar criar/editar/publicar um evento, lotes, provas, categorias, cupons, importar resultados/inscrições/laps em lote, ou ler/apagar inscrições e resultados de um hub.
---

# Eventor — CLI headless para configurar eventos

O binário `eventor` fala com a Management API do Eventor (`/api/v1`). A API key
resolve **um** hub; você nunca enxerga outro. **stdout = dados, stderr = humano.**
Em pipe/sem-TTY o stdout é JSON puro.

## Quando usar CLI vs MCP

- **CLI (este) — padrão pra scripting, bulk, loops e economia de token.** Um
  comando, uma saída JSON, exit code semântico. Ideal pra agente em loop.
- **MCP** — só pra query pontual em linguagem natural num cliente que fala MCP.
  Carrega N tool-definitions por chamada (caro em token). Pra configurar evento,
  **prefira o CLI**.

## Setup (uma vez)

```bash
eventor auth login --api-key sk_live_...   # valida em /me e grava ~/.config/eventor/config.json (0600)
# ou, sem login: export EVENTOR_API_KEY=sk_live_...   (e EVENTOR_BASE_URL se não for produção)
```

A key precisa do escopo **`manage`**. Sem credencial → exit 4 com hint de onde gerar.

## A regra de ouro: configure o evento com UM comando

Não monte o evento campo a campo. Escreva um `spec.json` e rode `event setup`:

```bash
eventor event setup --from spec.json --dry-run   # mostra o plano (would_create/would_update/unchanged), não escreve nada
eventor event setup --from spec.json             # executa idempotente; re-rodar é seguro
```

`spec.json`:

```json
{
  "event": { "name": "Maratona da Cidade 2026", "code": "MAR2026", "date": "2026-09-13",
             "city": "São Paulo", "state": "SP", "service_fee_cents": 990 },
  "organizer": { "name": "Run Brasil Eventos", "document": "12345678000190" },
  "races": [ { "name": "10K", "distance": 10,
               "modalities": ["Geral", "Morador"], "default_modality": "Geral",
               "categories": [ { "name": "Geral M", "sex": "M", "award_count": 3 },
                               { "name": "Fem 30-39", "sex": "F", "modalities": ["Geral"] } ] },
             { "name": "KIDS", "distance": 0.4, "sem_classificacao": true,
               "categories": [ { "name": "5-7 anos" } ] } ],
  "registration_settings": { "is_free": false, "max_registrations": 3000 },
  "batches": [ { "name": "1º Lote", "max_installments": 6, "race_prices": { "10K": 12900 } } ],
  "registration_fields": [ { "label": "Tamanho da camiseta", "type": "select",
                             "options": [ { "value": "P", "label": "P" }, { "value": "M", "label": "M" } ] } ],
  "modality_questions": [ { "modality": "Morador", "label": "Sou morador (anexe o comprovante)", "type": "file" } ],
  "publish": false
}
```

> `race_prices` usa o **nome da prova** (ex.: `"10K"`); o CLI resolve pra `race_id`.
> Preços em **centavos**. `--dry-run` mostra o mapeamento.
> `sem_classificacao: true` numa prova (ex.: KIDS) — prova sem cronometragem: no
> portal de resultados aparece como **lista de inscritos**, sem tempo/colocação.

### Modalidades (por NOME no spec — o CLI resolve/cria)

- `races[].modalities` é o **conjunto** de modalidades da prova, por **nome**
  (ex.: `["Geral","Morador"]`). O CLI resolve pra id; **nome que não existe é
  criado** (`POST /modalities`, modalidade do hub, reutilizável) e usado.
- `races[].default_modality` é a modalidade padrão/"pura" (default = `"Geral"` ou
  a primeira). No portal de resultados ela aparece sem sufixo; as outras viram
  `"10K Morador"`.
- `categories[].modalities` (opcional) restringe a categoria a um **subconjunto**
  das modalidades da prova. **Omitido = vale em todas** as modalidades da prova.
- `modality_questions` (nível hub) define a **pergunta de opt-in** de uma
  modalidade: quem responder isso no checkout entra naquela modalidade. `type`:
  `checkbox` | `text` | `file` | `select`. Idempotente.
- Modalidade vai sempre por **nome** no spec (o CLI faz "cria-primeiro-pega-id"
  por baixo). Avulso: `eventor modality create --name "Atleta Local"`.

Fluxo headless completo:

```bash
eventor event setup --from spec.json          # cria/atualiza tudo
eventor event publish --event MAR2026         # publica
eventor event show --event MAR2026 --json     # read-back pra conferir
```

## Mapa recurso → comando

| Precisa | Comando |
|---|---|
| logar / conferir credencial | `eventor auth login\|status\|logout` |
| listar/ver/criar/editar evento | `eventor event list\|show\|create\|update --event <id\|code>` |
| publicar / despublicar / finalizar | `eventor event publish\|unpublish\|finalize --event <code>` |
| mover no kanban | `eventor event stage --event <code> --stage-kind published` |
| subir logo/banner/PDF | `eventor event upload --event <code> --kind logo --file ./logo.png` |
| montar evento inteiro | `eventor event setup --from spec.json` |
| referência (resolver ids) | `eventor modality` · `race-template` · `product` · `pipeline-stage` |
| criar modalidade / pergunta de opt-in | `eventor modality create --name <nome>` · `eventor modality question --modality <id> --label <txt> --type checkbox\|file` |
| organizadores / vendedores | `eventor organizer list\|create` · `eventor salesperson list\|create` |
| inscrições: listar / apagar uma / limpar em lote | `eventor registration list\|delete\|clear --event <code>` |
| resultados: listar / apagar / limpar prova ou evento | `eventor result list\|delete\|clear --event <code>` |
| **importar** resultados em lote (cronometragem) | `eventor result import --event <code> --race <id\|code> --from results.json` |
| **importar** inscrições em lote | `eventor registration import --event <code> --race <id\|code> --from inscritos.json` |
| **importar** parciais por volta (laps) | `eventor lap import --event <code> --race <id\|code> --from laps.json` |
| status/sumário de um import | `eventor result import-status <id> --event <code>` · `eventor registration import-status <id> --event <code>` |
| homologar / voltar pra provisório uma prova | `eventor result status homologated\|provisional --event <code> --race <id>` |
| qualquer endpoint do spec | `eventor api <METHOD> <path>` |

`--event` aceita **id ou code** (a API resolve os dois).

## Escape hatch: cobre 100% da API

Endpoints sem comando dedicado (lotes, cupons, campos, addons) são
alcançáveis por `eventor api`:

```bash
eventor api GET /events --query status=published       # filtra
eventor api GET /events --all | jq '.data[].code'      # --all junta todas as páginas
eventor api POST /events/MAR2026/coupons --body '{"code":"PROMO10","type":"percent","value":10}'
eventor api POST /events --body @evento.json           # body de arquivo
echo '{"name":"X"}' | eventor api POST /events --body -  # body do stdin
eventor api DELETE /events/MAR2026/batches/5 --yes     # destrutivo exige --yes
```

Tolera o path: `/events`, `/v1/events` e a URL completa funcionam igual.

## Importar resultados e inscrições em lote (ingest pós-prova)

A ingestão de dados de cronometragem vive na **Management API `/api/v1`** — os antigos
endpoints `POST /api/integrations/*` foram **removidos**. Evento e prova vão na **URL**
(aceitam id ou code) e a key precisa do escopo **`manage`**. Você dá um arquivo JSON e o
CLI lê do disco — nada de montar payload na mão.

```bash
# resultados — UMA modalidade por envio (ex.: sobe "Geral", depois "Morador")
eventor result import --event 260412 --race 26041201 --from geral.json
eventor result import --event 260412 --race 26041201 --modality Morador --from morador.json

# inscrições
eventor registration import --event 260401 --race 26040101 --from inscritos.json

# parciais por volta (laps) — stream-friendly, pode mandar durante a corrida
eventor lap import --event 260412 --race 26041201 --from laps.json

# status/sumário de um import (o import_id vem no retorno do import)
eventor result import-status 57 --event 260412
eventor registration import-status 42 --event 260401
```

**Formato do `--from`:** aceita o **corpo completo** (`{"modality":"Geral","results":[...]}`,
`{"registrations":[...]}`, `{"laps":[...]}`) **ou um array puro** dos itens; use `-` pra ler
do stdin. Pra resultados, `--modality <nome>`/`--modality-id <id>` define a modalidade do
lote (sobrescreve a do arquivo; id ganha de nome). A modalidade é resolvida contra as
**declaradas na prova** — nunca é criada; categoria sim, é auto-criada.

**Match de resultados por chave natural:** o upsert casa por `(prova, categoria, bib)`; sem
bib, cai pro CPF; sem identidade, cria linha nova. **`external_id` é só referência livre —
NÃO é chave de idempotência** (reusar o mesmo `external_id` não colapsa linhas; cada bib é
uma linha). Inscrições casam por `(evento, external_id)` ou, sem ele, `(evento, CPF)`.

**Re-import é seguro (preserve-on-absent):** reenviar a lista atualiza em vez de duplicar, e
campos **omitidos** preservam o valor atual (protege edição manual do admin). Pode mandar a
lista completa todo dia.

**Saída e limites:** o retorno traz `summary` (`created`/`updated`/`conflicts`/`errors`) e um
`outcome` por item (`created`/`updated`/`conflict`/`error`). Import é **upsert, não
destrutivo** → não exige `--yes`. Se algum item falha a validação, a API devolve 422 (exit 1,
veja `code`/`message` no stderr). Limites: resultados 1–5000/req, inscrições 1–2000/req — pra
cargas maiores, fatie em vários arquivos.

## Apagar inscrições e resultados (destrutivo — exige `--yes`)

```bash
# pontual
eventor registration delete 42 --event MAR2026 --yes   # uma inscrição (só API/CSV)
eventor result delete 99 --event MAR2026 --yes         # um resultado (hard delete)

# em lote (desfazer import errado antes de reimportar)
eventor registration clear --event MAR2026 --yes               # todas as de API/CSV do evento
eventor registration clear --event MAR2026 --race 7 --yes      # só de uma prova
eventor registration clear --event MAR2026 --origin csv --yes  # só de uma origem
eventor result clear --event MAR2026 --yes             # TODOS os resultados do evento
eventor result clear --event MAR2026 --race 7 --yes    # só de uma prova
```

- Inscrição de **checkout** (origin `online`) NUNCA é apagada — nem no `delete`
  (409 `registration_from_checkout`) nem no `clear` (que só varre API/CSV;
  `--origin online` é recusado com 422 `cannot_bulk_delete_checkout`). Tem
  pedido/pagamento atrelado; o caminho é cancelar pelo painel.
- `clear` é o jeito certo de desfazer um import errado: apaga tudo
  (inclusive desclassificados) e o próximo `POST /results`/`/registrations`
  recria do zero. Resposta traz `{"data":{"deleted":n}}`.

## Homologar resultado (provisório → oficial)

O resultado de cada **prova** tem um status de publicação (`results_status`):
`provisional` (recém-publicado, ainda sujeito a recurso/correção) ou
`homologated` (oficial, chancelado pelo hub). É **por prova** — a 5K pode estar
homologada com a 10K ainda provisória. No portal público, prova provisória mostra
um aviso "resultado provisório"; homologada vira "resultado oficial".

```bash
eventor result status homologated  --event MAR2026 --race 7   # marca a prova 7 como oficial
eventor result status provisional  --event MAR2026 --race 7   # volta pra provisório (reversível)
```

- A homologação é uma **decisão explícita** — reimportar resultados (`POST /results`)
  **nunca** muda o status. Toda prova nova nasce `provisional`.
- `--race` é obrigatório (homologação é por prova). É reversível, então não exige `--yes`.
- Resposta traz a prova atualizada: `{"data":{"id":7,"results_status":"homologated"}}`.

## Flags úteis (em qualquer comando)

`--json` (força JSON) · `--quiet` (silencia stderr) · `--api-key`/`--base-url`
(override) · `--dry-run` (não executa) · `--yes` (pula confirmação) · `--all`
(pagina tudo) · `--body` (`'{...}'` | `@arquivo` | `-`).

## Troubleshooting — exit codes e auto-recuperação

Todo erro vem como `{"error":{"code","message","hint"}}` no **stderr**. Leia
`code` pra decidir e `hint` pro próximo comando.

| Exit | Significado | O que fazer |
|---|---|---|
| 0 | sucesso (inclui no-op idempotente) | seguir |
| 1 | erro genérico / 5xx do servidor | re-tentar (o SDK já faz backoff); se persistir, reportar |
| 2 | uso incorreto (flag/arg, ou destrutivo sem `--yes`) | corrigir o comando |
| 3 | not found (404) | conferir o `--event`/id; listar pra achar o code |
| 4 | sem credencial / key inválida / sem escopo `manage` | `eventor auth login` ou regenerar a key com escopo manage |
| 5 | conflito (409) — já existe ou tem dependência | re-rodar com `--update`/`--set is_active=false`, ou usar `event setup` (idempotente) |

**Anti-patterns**
- ❌ Montar o JSON do evento campo a campo com vários `api POST`. ✅ Use `event setup`.
- ❌ Tratar exit 5 (conflito) como falha fatal. ✅ É recuperável (desativar em vez de deletar, ou re-aplicar).
- ❌ Paginar na mão. ✅ `--all`.
- ❌ Montar multipart/base64 pra upload. ✅ `event upload --file ./x.png` (lê do disco).
