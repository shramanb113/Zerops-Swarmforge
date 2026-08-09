# SwarmForge

**A multi-agent factory that builds software, running entirely on Zerops.**

Describe a product in one sentence. Three specialized agents — **Architect**, **Coder**,
and **Deployer** — design a service architecture for it, write real working code in the
language that best fits the description, generate a Zerops deployment manifest, and
deploy it as a brand-new service in the same Zerops project. All of it coordinated over
a private message queue, with shared state in managed Postgres, and progress visible
live on a topology dashboard.

Built in 48 hours for a Zerops hackathon.

## Why this needs Zerops, specifically

The pitch only works because every part of it is a **first-class Zerops service** on
the same private network:

- Agents are isolated processes, not threads in one app — each is its own deployable
  Zerops service, coordinating over **NATS JetStream** (a managed Zerops broker type)
  instead of being wired together by hand.
- The Deployer agent doesn't just print a `zerops.yaml` — it calls `zcli` to actually
  **import and deploy the generated product as a new service in the same Zerops
  project**, live, next to the swarm that built it.
- Shared world state (agents, tasks, task events) lives in managed **PostgreSQL**;
  live presence heartbeats live in managed **Valkey**. Both are Zerops-managed service
  types, referenced by the other services via Zerops' `${<hostname>_<varName>}`
  cross-service env var syntax — no manual connection-string wiring.

None of this reduces to "call some APIs from a single backend on a generic PaaS" — the
architecture *is* a fleet of cooperating Zerops services.

## How it works

```
                         ┌─────────────────────┐
   "build me a URL       │   Web Dashboard      │  live topology, task feed,
    shortener in         │   (Next.js)          │  presence, generated-code
    Python"  ──────────► │                      │  viewer, live preview
                         └──────────┬───────────┘
                                    │ POST /tasks
                                    ▼
                         ┌──────────────────────┐
                         │   Control Plane        │  Fastify HTTP API
                         │   (Fastify)            │  owns Postgres migrations
                         └──────────┬─────────────┘
                                    │ publishes task
                                    ▼
                    ┌───────────────────────────────┐
                    │      NATS JetStream queue       │  durable, at-least-once,
                    └───────────────┬─────────────────┘  retry with max_deliver
                                    │
        ┌───────────────┬──────────┴──────────┬────────────────┐
        ▼               ▼                     ▼                │
 ┌─────────────┐  ┌─────────────┐      ┌─────────────┐         │
 │  Architect   │  │    Coder     │      │  Deployer    │        │
 │ (Groq LLM)   │─▶│ (Groq LLM)   │─────▶│ (Groq LLM +  │        │
 │              │  │              │      │  zcli)       │        │
 │ proposes a   │  │ writes real  │      │ generates    │        │
 │ service +    │  │ backend +    │      │ zerops.yaml  │        │
 │ language +   │  │ frontend     │      │ and deploys  │        │
 │ API surface  │  │ code, self-  │      │ the product  │        │
 │              │  │ checks it    │      │ as a new     │        │
 │              │  │ compiles/    │      │ Zerops       │        │
 │              │  │ boots        │      │ service      │        │
 └──────┬───────┘  └──────┬───────┘      └──────┬───────┘        │
        │                 │                     │                │
        └─────────────────┴──────────┬──────────┴────────────────┘
                                      ▼
                       ┌───────────────────────────┐
                       │  Postgres (world state)     │  agents, tasks,
                       │  Valkey (live presence)     │  task_events
                       └───────────────────────────┘
```

1. A user submits a one-sentence product description to the dashboard.
2. **Architect** turns it into a concrete proposal: service name, the best-fit language
   for the job, a list of API endpoints, and a short frontend description.
3. **Coder** implements the proposal for real — a self-contained backend (currently
   **TypeScript/Fastify** or **Python/FastAPI**, chosen per-product by the Architect)
   plus a single static `frontend.html` wired to the backend's actual API with real
   `fetch()` calls — and self-checks the result (`tsc --noEmit`, or a real venv install +
   boot smoke test for Python) before handing off.
4. **Deployer** renders a language-appropriate `zerops.yaml` / service-import manifest
   and drives `zcli` to import and push the product as a new, live Zerops service
   sitting alongside the swarm itself.
5. Every step is an event in Postgres (`task_events`), and every agent's liveness is a
   Valkey heartbeat — the dashboard streams both so the whole build is watchable in
   real time, not a black box.

## Try it with a known-working example

The Architect will *attempt* almost any one-sentence description, but for a demo or
review, use one of these — each has been run through the full
Architect → Coder → Deployer pipeline and confirmed to produce compiling, self-checked,
deployable code:

- `A URL shortener API with click count tracking`
- `A simple task manager API with priorities`
- `A weather lookup API by city name`
- `make a url shortener python backend`
- `make a todo api in python with frontend`
- `A simple REST API in Python that manages a list of book titles - add a book, list all books.`

Mention "python" explicitly to steer the Architect toward the Python/FastAPI profile;
otherwise it defaults to TypeScript/Fastify for most everyday CRUD-shaped descriptions
(see **Supported languages** below for why that matters). Free-form descriptions
outside this list often work too, but haven't been verified end-to-end — an
under-specified or unusual description can still produce a proposal the Coder can't
satisfy, which the pipeline reports as a failed task rather than silently guessing.

## Supported languages

The Architect is prompted to choose from four languages (TypeScript, Python, Go,
Rust), but the Coder only has a **real implementation for two: TypeScript/Fastify and
Python/FastAPI.** If the Architect ever proposes Go or Rust, the Coder and Deployer
both silently fall back to the TypeScript profile — the product gets built and
deployed as TypeScript regardless of its `language` label in the database. This is a
known, unresolved gap: Go/Rust were left in the Architect's language enum from the
original design but their Coder profiles were never built (see the multilingual-coder
spec/plan under `docs/superpowers/`). Effectively, **only TypeScript and Python are
safe to expect** from a real run today.

## Hackathon constraints

This was built in a 48-hour window, so scope was cut deliberately rather than left
unfinished-and-hidden. Worth knowing before you judge or extend it:

- **Only 3 of the originally-designed 6 agents were built**: Architect, Coder,
  Deployer. Tester, Observer, and Healer exist only as design docs
  (`docs/superpowers/specs/2026-08-09-swarmforge-healer-design.md`) — there is no
  self-healing loop and no continuous self-testing in this build, only the one-shot
  build → deploy pipeline.
- **Go and Rust are unimplemented** (see above) despite being in the Architect's
  language choices.
- **Generated backends are intentionally single-file.** The Coder is instructed to
  produce one `index.ts`/`main.py` per product rather than a multi-file project — fine
  for the small CRUD-shaped services this targets, not representative of how you'd
  structure a larger service.
- **No auth, rate-limiting, or multi-tenancy** on the control-plane API or on
  generated products — anyone who can reach `POST /tasks` can queue a build, and
  every generated backend is unauthenticated by default.
- **`DEPLOY_DRY_RUN` defaults to `true`.** A fresh clone logs the `zcli` commands it
  would run rather than actually deploying, so cloning the repo can never surprise
  someone with a real Zerops bill. Real deploys are an explicit opt-in (see below).

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language/runtime | Node.js + TypeScript (ESM, NodeNext) everywhere except generated products | one toolchain for the whole swarm |
| Agent intelligence | [Groq](https://groq.com) via a thin `LLMClient` interface | fast inference; provider is swappable without touching agent logic |
| Message broker | NATS JetStream | a managed Zerops broker type, with durable consumers and retry |
| Database | PostgreSQL 16 (Drizzle ORM) | managed Zerops service; world-state source of truth |
| Presence | Valkey 7.2 | managed Zerops service; agent heartbeats |
| Frontend | Next.js (App Router) | live topology + task feed dashboard |
| Generated backends | TypeScript/Fastify or Python/FastAPI | chosen per-product by the Architect |
| Deploy target | Zerops (`zcli`), both for the swarm itself and for every product it builds | the whole point |

## Repo layout

```
packages/agent-framework/   shared library: Postgres/Valkey/NATS access, Groq LLMClient,
                             the ZeropsAgent base class every agent extends
services/control-plane/     Fastify API: POST /tasks, GET /world-state, GET /presence
services/agent-architect/   proposes architecture + language + API surface
services/agent-coder/       writes and self-checks the product's real code
services/agent-deployer/    renders zerops.yaml and drives zcli to deploy the product
apps/web/                   Next.js dashboard: live topology, task feed, code viewer
docs/superpowers/specs/     design docs, one per sub-project
docs/superpowers/plans/     implementation plans, one per sub-project
```

## Running it locally

```bash
cp .env.example .env                        # fill in GROQ_API_KEY
cp apps/web/.env.local.example apps/web/.env.local

pnpm install
docker-compose up -d                        # local Postgres/Valkey/NATS
pnpm build                                  # compile every package/service once
pnpm --filter control-plane dev             # in one terminal
pnpm --filter agent-architect dev           # …and so on for each agent
pnpm --filter web dev                       # dashboard on http://localhost:3001
```

`DEPLOY_DRY_RUN=true` (the `.env.example` default) makes the Deployer agent log the
`zcli` commands it *would* run instead of executing them — safe for local development
without a real Zerops project on hand.

Run the test suite with `pnpm test` (aliases the framework package to source, no build
required), or a single file with `pnpm vitest run <path>`. `pnpm smoke` runs an
end-to-end check against `CONTROL_PLANE_URL` — point it at a real deployment to verify
that too.

## Deploying for real

SwarmForge deploys in two halves, matching where each half's traffic actually needs to
live:

### 1. The swarm itself → Zerops

`zerops.yaml` and `zerops-project-import.yaml` at the repo root already describe the
full stack: `postgresql@16`, `valkey@7.2`, `nats@2.12`, plus one Zerops service each for
`control-plane`, `agent-architect`, `agent-coder`, and `agent-deployer`.

```bash
zcli login <your-zerops-api-token>
zcli project service-import zerops-project-import.yaml   # creates the managed + agent services
zcli push control-plane                                  # repeat per service: agent-architect,
                                                           # agent-coder, agent-deployer
```

Before the first real push, set each agent service's `GROQ_API_KEY` secret in the
Zerops GUI (never commit it), and set `agent-deployer`'s `DEPLOY_DRY_RUN` env var to
`false` once you're ready for it to actually deploy the products it builds, not just
log the commands.

### 2. The dashboard → Vercel

`apps/web` is a standalone Next.js app with exactly one external dependency: the
control-plane's URL.

```bash
cd apps/web
vercel login
vercel --prod
```

Set one environment variable in the Vercel project settings:

```
NEXT_PUBLIC_CONTROL_PLANE_URL=https://<your-control-plane-service>-<project>.app.zerops.io
```

### 3. Products the swarm builds → the same Zerops project

This is the Deployer agent's job at runtime, not a manual step: once `DEPLOY_DRY_RUN`
is `false`, every product the swarm finishes building is imported and pushed as its own
new Zerops service in the same project via `zcli`, right alongside the swarm that
built it.
