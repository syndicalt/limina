# Limina Exchange — Product Roadmap (the skills & content marketplace)

> **Type:** product roadmap — a separate **product/service**, not an engine phase. Lives beside the
> engine roadmap, not inside it.
> **Parent / depends on:** [`post-mvp-roadmap.md`](./post-mvp-roadmap.md) **Phase 10** (the hosted
> registry mechanism + third-party contribution process) and the packaging substrate already shipped in
> **Phase 4** — versioned packages, manifest, capability attestation, content-hash provenance, the policy
> engine, and QuickJS isolation. The Exchange is the *product* built around that substrate; the substrate
> is not rebuilt here.
> **Synergy:** world/asset listings can render live previews using the **Phase 8** browser/WebGPU runtime
> (a world is just a log you can replay — so a listing page can *run* the world, not just screenshot it).
> **Standing principle:** the Exchange is **optional to the engine**. limina runs fully offline without it;
> the engine never takes a runtime dependency on the Exchange. The Exchange consumes the engine's trust
> primitives, never the other way around.

**Decisions baked in (chosen at kickoff):**
- **Hybrid monetization from day one** — free *and* paid listings, revenue share, licensing, payouts, tax.
  Monetization is launch-blocking, not a later tier.
- **Two consumers** — humans via a web UI (browse / publish / buy / install) **and** agents via a
  permissioned API + MCP endpoint (search / evaluate / license / install at runtime). The agent-consumable
  side is the part no ordinary package registry has.
- **Full content marketplace** — skills, packages, whole worlds, and assets. This means large-binary CDN,
  previews/thumbnails (and live world previews), and asset licensing, on top of the code-listing surface.

---

## What it is

A marketplace where developers (and agents) publish, discover, license, and install limina **skills,
packages, worlds, and assets** — consumable both by people on a website and by agents at runtime through a
governed API. Think "npm + Unity Asset Store + a model hub," but agent-native and built on limina's existing
content-hash provenance and capability attestation, with payments and a hard trust boundary because the
things being traded are *executable capabilities that run with permissions inside worlds*.

## The trust & safety spine (cross-cutting — the load-bearing concern)

This is the one part that can sink the product, so it runs through every stage rather than being a single
stage. A listing here is not a static asset — it is code an agent may install and execute, possibly after
*paying* for it, possibly *without a human in the loop*. The spine:

- **Capability transparency.** Every listing surfaces its permission/capability footprint, read from the
  manifest + attestation, before anyone (human or agent) installs it. No hidden permissions.
- **Verified provenance & signing.** Content-hash provenance (already the scheme) + publisher signing +
  verified-publisher badges. Integrity is checked on install; the hash is the identity.
- **Pre-publish sandbox verification.** Listings are exercised in the engine's QuickJS isolation + policy
  engine before they earn a "verified" badge — over-permissioned or misbehaving skills are caught here.
- **Yank, deprecate, advisories.** A bad version can be pulled and an advisory pushed to everyone who
  installed it. Version-pinning + lockfiles + integrity-on-install make this enforceable.
- **Governed agent install.** An agent can only install/license within its policy profile and budget
  (Phase 4 policy engine), rate-limited, fully traced. Buying and running a skill is itself a governed,
  audited action.

Stages **X2** and **X4** are where the spine becomes concrete; it is called out here because it is
launch-blocking and shapes everything else.

---

## The path — sequencing at a glance

| Stage | Goal in one line | Launch status |
|---|---|---|
| **X0 — Foundations & de-risk** | Architecture, providers, legal, trust model; prove the round-trip | pre-launch |
| **X1 — Catalog, identity & listings** | Publish and browse skills/packages/worlds/assets | launch-blocking |
| **X2 — Trust & safety, surfaced** | Capability transparency, sandbox-verify, signing, yank | launch-blocking |
| **X3 — Monetization** | Free + paid, licensing, checkout, entitlements, payouts, tax | launch-blocking |
| **X4 — Agent-native consumption** | Agents search / license / install at runtime, governed | launch-blocking* |
| **→ Public launch (beta)** | Humans and agents transact on a trusted, monetized catalog | milestone |
| **X5 — Quality, discovery & curation** | Ratings, usage signals, trending, collections, compat | post-launch |
| **X6 — Growth & operations at scale** | Publisher analytics, orgs/teams, disputes, abuse-at-scale, i18n | post-launch |

\*X4 is launch-blocking because dual-consumer was chosen, but it layers cleanly on X1/X3's APIs — if launch
timing demands it, it can fast-follow a human-only beta. Call that out explicitly rather than dropping it
silently.

---

## X0 — Foundations & de-risk  *(pre-launch)*
**Goal:** make the load-bearing architecture and provider choices, and prove the riskiest round-trip end to
end before building the product on top of it.

**Work:**
- **Stack & architecture.** A dedicated marketplace web app + registry service (separate from the static
  Astro showcase, sharing brand). TypeScript end to end for continuity with the engine. A registry API, a
  relational store for metadata, object storage + CDN for **content-addressed** artifacts (the content hash
  *is* the storage key — natural integrity + cache), and a search index. Recommend, don't prescribe.
- **Payments & legal.** Choose a payments + payouts + tax provider that supports marketplace split payments
  (revenue share) and multi-jurisdiction tax. Draft the licensing framework (license types, the publisher
  agreement, content policy, takedown process). This is slow; start it in X0.
- **Trust model.** Decide how pre-publish sandbox verification runs (reuse QuickJS isolation + policy
  engine), what "verified" means, and how capability footprints are extracted from manifests/attestation.
- **De-risk spike.** Prove `publish → content-hash provenance → CDN → install → integrity-verify` against
  the engine's *existing* provenance, for one skill and one large asset.

**Gate:** architecture, payment/tax provider, and licensing framework documented; the publish→verify→install
round-trip works against real engine provenance for both a code listing and a large binary.

---

## X1 — Catalog, identity & listings  *(launch-blocking)*
**Goal:** a publisher can put skills, packages, worlds, and assets on a public, searchable catalog, and a
human can find and install them.

**Work:**
- **Identity.** Publisher accounts, organizations/teams, API tokens, 2FA; the basis for verified publishers.
- **Listing model.** Listing *types* — skill, package, world, asset — each versioned (semver), with manifest
  validation, README/docs, screenshots, and engine-version compatibility. Worlds and assets bring
  large-binary upload, CDN delivery, thumbnails, and **live world previews** (render via the Phase 8 browser
  runtime where available).
- **Discovery.** Public read-only catalog, search, categories/tags, listing pages.
- **Web UI.** Browse, listing detail, publisher profiles, and a CLI/web publish flow. Free listings function
  end to end here; the paid path is designed in but lands in X3.

**Gate:** a publisher creates an account, publishes a versioned skill, a package, and a world with a live
preview; a human finds them by search and installs via CLI with integrity verification.

---

## X2 — Trust & safety, surfaced  *(launch-blocking)*
**Goal:** turn the trust spine into concrete, visible product surface — nobody installs anything whose
capability footprint and provenance they can't see.

**Work:** capability/permission footprint on every listing (from manifest + attestation); publisher signing
+ verified-publisher badges; the pre-publish sandbox-verification pipeline (QuickJS isolation + policy
engine) producing a "verified" badge; automated scanning; abuse/vulnerability reporting; yank + deprecate;
security advisories pushed to installers; version-pinning, lockfiles, and integrity-on-install.

**Gate:** an over-permissioned or malicious listing is caught and blocked before publish; every listing shows
its capability footprint and provenance; a yank + advisory reaches everyone who installed the bad version.

---

## X3 — Monetization  *(launch-blocking — hybrid from day one)*
**Goal:** publishers can sell, buyers can buy, and entitlements are enforced — for both humans and agents.

**Work:**
- **Listing economics.** Free and paid listings; licensing models (one-time, subscription, per-seat,
  metered/per-use); pricing, trials, refunds.
- **Checkout & entitlements.** Human checkout on the web; an **entitlement** is a license token bound to the
  content hash and the buyer — a paid artifact only installs/runs with a valid entitlement, enforced at
  install and at runtime.
- **Payouts & tax.** Revenue share, publisher payouts, tax/VAT, chargeback/refund handling, reporting.
- **Agent purchase.** An agent can license a paid skill **within its policy budget**, governed and audited
  (this is unusual and trust-sensitive — gated hard by the policy engine and per-session limits).

**Gate:** a publisher sells a paid skill; a human buys and installs it; an agent licenses one within budget;
the publisher is paid out; entitlements are enforced at install and run; a refund/chargeback resolves cleanly.

---

## X4 — Agent-native consumption  *(launch-blocking* — the differentiator)*
**Goal:** an agent inside a world can search the Exchange, read a listing's capability footprint, license or
install it, and use it — all within its permission profile and budget, fully traced.

**Work:** a permissioned Exchange **API + MCP endpoint** (search, inspect capability footprint, check
entitlement, install) that an in-world or external agent can `callTool`; runtime governance so install/
license is bounded by the Phase 4 policy engine, rate-limited, and recorded in the world log like any other
action; resolution/dependency handling for runtime install.

**Gate:** an in-world agent searches the Exchange, installs (or licenses + installs) a skill strictly within
its policy budget, uses it, and the whole transaction is governed and traced.

---

## → Public launch (beta)
**Milestone:** humans and agents transact on a trusted, monetized catalog of skills, packages, worlds, and
assets — capability-transparent, provenance-verified, with working payments and payouts. This is the bundle
of X1–X4; if timing forces it, X4 can fast-follow a human-only beta (stated, not silent).

---

## X5 — Quality, discovery & curation at scale  *(post-launch)*
**Goal:** make the good stuff findable as the catalog grows.

**Work:** ratings/reviews, download/usage signals, trending, curated collections, editorial features,
recommendations, an engine-version compatibility matrix, and "agents who used X also used Y" style signals
that feed the agent-consumption API too.

**Gate:** discovery quality measurably beats raw search; curated collections drive a meaningful share of
installs.

---

## X6 — Growth & operations at scale  *(post-launch)*
**Goal:** run it as a real business and a real platform.

**Work:** publisher analytics/dashboards, org/team management and seat licensing, dispute/refund/chargeback
operations, abuse and fraud handling at scale, SLAs and status, internationalization (currency, language,
tax), and partner/enterprise terms.

**Gate:** the platform sustains a growing publisher base with bounded operational load and a healthy
trust/abuse posture.

---

## Out of scope (non-goals)

- **Rebuilding the engine's trust primitives.** The Exchange *reuses* QuickJS isolation, the policy engine,
  capability attestation, and content-hash provenance — it does not reinvent them.
- **A general app store for arbitrary binaries.** Scope is limina skills, packages, worlds, and assets.
- **Making the engine depend on the Exchange.** The engine must run fully offline; the Exchange is an
  optional service the engine (or an agent) can reach, never a runtime dependency.
- **Hosting agent "brains"/memory.** Recall and intelligence stay external (the standing substrate
  principle); the Exchange trades capabilities and content, not cognition.
