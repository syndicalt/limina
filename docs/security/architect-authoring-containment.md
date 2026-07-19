# Architect authoring isolation and reviewed import

`architect-daemon.mjs` does not execute a model CLI on the host. The former
`claude --dangerously-skip-permissions` path and its attended override have been
removed. Untrusted model output crosses the system only as a bounded Python source
file and is executed by the fixed broker in `architect-isolation.mjs`.

## Trust boundaries

The broker uses the already-installed ARM64 image at this exact digest:

```text
postgres@sha256:be01cf82fc7dbba824acf0a82e150b4b360f3ff93c6631d7844af431e841a95c
```

Every invocation uses `--pull=never`; a missing image, wrong architecture, or
wrong digest fails closed. The broker, not request text or generated source,
constructs every Docker argument.

The workflow has three distinct authorities:

1. **Source generation:** a trusted fixed Node worker receives one validated
   request file and the Anthropic key. It has outbound Docker bridge networking,
   but no repository, user home, Docker socket, SSH agent, editor capability, GPU
   device, or host process namespace. The response is accepted only as one bounded
   fenced Python source file. It is not executed in this container.
2. **Blender execution and mechanical QC:** separate containers run with
   `--network=none`, a read-only root, all capabilities dropped,
   `no-new-privileges`, non-root UID/GID, bounded memory/CPU/PIDs/fds, and a wall
   timeout. They receive no provider or editor credential. Blender can read only
   the staged source/request and write only the staged output directory. QC can
   read only the candidate and write only staged evidence. No GPU device is
   mounted; Blender is CPU-only. `/tmp` is a bounded ephemeral tmpfs for process
   scratch, while the carrier image's declared PostgreSQL volume is explicitly
   over-mounted read-only. The only durable execution mount is one pre-created
   `candidate.glb` file, protected by a 128 MiB file-size rlimit; the source does
   not receive a writable staging directory.
3. **Reviewed import:** a successful job stops at `awaiting-reviewed-import` in
   `.limina/architect-staging/job-*/manifest.json`. Import requires a separate
   review record whose hashes bind both that exact manifest and candidate. Import
   rejects traversal, symlinks, replacement of an existing asset, artifact drift,
   and non-canonical target names. Only then can `architect-run.mjs` invoke the
   engine QC and held catalog proposal.

The host `/usr` and `/etc/alternatives` trees are mounted read-only because the
local image intentionally supplies isolation rather than Blender. The networked
generation worker additionally receives only the host CA certificate directory,
read-only, for TLS verification. No other host `/etc`, home, repository, runtime
socket, or device tree is mounted. Docker-group access is root-equivalent, so
`architect-isolation.mjs` is privileged trusted broker code: generated source
must never receive its CLI arguments or `/var/run/docker.sock`.

## Operation

The daemon needs the private editor capability to read the authoritative request
queue and the provider key for the networked generation worker:

```sh
LIMINA_EDITOR_TOKEN='<private capability>' \
ANTHROPIC_API_KEY='<private provider key>' \
node tools/design/architect-daemon.mjs --once
```

The resulting state entry names a stage manifest and its SHA-256. Review the GLB,
manifest, isolated QC evidence, and source. Then create a private review file:

```json
{
  "schema": "limina.architect-import-review/v1",
  "decision": "approve",
  "manifestSha256": "sha256:<64 lowercase hex characters>",
  "artifactSha256": "sha256:<64 lowercase hex characters>",
  "targetAssetId": "reviewed-prop.glb",
  "reviewer": "human-reviewer-id"
}
```

Import and continue through the ordinary engine pipeline with:

```sh
LIMINA_EDITOR_TOKEN='<private capability>' node tools/design/architect-run.mjs \
  --isolated-manifest .limina/architect-staging/job-.../manifest.json \
  --import-review /private/path/review.json
```

That command performs the reviewed import first, then the existing transform-aware
sanity/card/engine-render/held-publication sequence. It is intentionally a human
action; the daemon cannot synthesize the approval record or call it autonomously.

## Threat model and residual risks

The boundary is designed to contain prompt injection and malicious generated
Python: request text cannot alter mounts or commands; Python has no network,
credentials, host filesystem, Docker socket, or GPU; only a bounded staging output
is writable. Behavioral tests attempt each of those escapes through a real Docker
run and prove hash-bound, symlink-resistant reviewed import.

Residual trusted computing base:

- the local Docker daemon, Linux kernel/container boundary, fixed image bytes,
  host Blender/Node binaries under the read-only `/usr` mount, and this broker;
- the fixed network worker and Anthropic endpoint, which necessarily receive the
  provider key and request text (but cannot write the repository);
- the human reviewer, who decides whether the candidate/source are acceptable;
- engine QC after import, which retains its own GPU-safety and HITL rules.

This is not a defense against a kernel/container-runtime escape or a malicious
replacement of the pinned local image under the same digest. Image provenance and
host runtime patching remain operational responsibilities. A timeout force-removes
the broker-chosen container name; failures do not fall back to host execution or
pull another image.
