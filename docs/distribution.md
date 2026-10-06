# Portable packages and onboarding

Status: Implemented locally for the 0.2.0 release set; npm publication is separate.
Change: `chg-dal-workspace-autonomy-20260916`.

## Workspace setup

The installed `dal setup [--dir <directory>]` command creates local evidence
directories, the feedback skill and instructions through the existing non-overwrite
initializer, then returns diagnostics. `dal doctor [--dir <directory>]` is read-only:
it validates packaged policy/schema/template assets, checks scaffold presence and
counts schema-valid final and checkpoint records. It reports invalid records without
echoing their contents. The record scan is bounded to 1,000 files and marks truncation.
Presence of instructions is not proof that the host loads them. Existing AGENTS.md
and gitignore files are preserved and require integration review.

Neither command installs or mounts plugins, reads credentials, probes subscription
access, runs a model, or changes home-level configuration. `automatic_loop_ready`
remains false without a specific authorized campaign. `text_campaign_available`
identifies the installed text-loop capability without probing authentication. Setup
is usable from a packaged CLI without a DAL checkout; it is not yet the complete
one-command DSH integration described in the target architecture.

The CLI tarball includes its schemas, policy and the two global-install templates.
`@lunarmoon26/dal/cli` is the supported executable export. The improvement plugin
declares an exact DAL dependency and resolves that export using its own package
resolution context. `dal-modes` declares exact dependencies for all named plugin
rows. Installing the dependency set is distinct from mounting its rows into DSH;
the recorder remains enabled by default, other rows disabled, and HMR application
remains quarantined.

## Release verification

### DSH compatibility

Change `chg-dsh-020rc2-compat` targets DSH `0.2.0-rc.2` and Cordis `4.0.4`.
Root runtime dependencies, the isolated native text host and tool-plugin peer
requirements use that release set. Compatibility is verified by type checking,
offline service/protocol tests and the repository gate, not by a version bump
alone. The recorder remains privacy-safe, the native text host remains tool-free,
approval boundaries are unchanged and HMR candidate application stays quarantined.

Acceptance requires aligned manifests/lockfile, repaired API consumers, passing
focused tests and `pnpm run check`. Historical records, digest-bound benchmark
images, grants and capsules retain their original identity; dependency migration
does not rebaseline or authorize their use with a new runtime. Installed profiles,
credentials, plugin mounts, publication and live model calls are outside this
change. Old DSH releases are not claimed as supported by the migrated packages.

Current dependency manifests supersede the historical version pins in
`docs/spec.md` (DAL-017 and the original live extension) and earlier research
evidence. Those observations and their capsule source identities are preserved;
they are not refreshed into claims about the new release.

DSH `0.2.0-rc.2` compatibility deltas:

- Sandbox confinement awaits the provider result and maps asynchronous
  unavailability to the existing fail-closed DAL error. Enforcement and diagnostic
  evidence retain the provider's values.
- Workflow tools import the JSON-value type from `dsh-util-values`, its new owner.
- Recording correlates native `message.toolCallId`/`message.source.callId`, rejects
  conflicting identifiers and treats `message.isError` as failure even without
  structured error facts. Legacy event fixtures remain supported.
- Prompt digests come from an initial single-text `system/message`, not the retired
  request-header field. Additional system nodes, unsupported content or any surface
  replacement invalidate the digest and controller enrollment conservatively;
  DAL does not retain raw prompt history to reconstruct that surface. No configured
  pin substitutes for unknown observed provenance.
- Native-host checks use actual DSH service types rather than the former
  mixed-version structural context cast. The release consumer smoke selects its
  tools peer from the root manifest instead of an obsolete hard-coded version.

Migration verification (2026-10-06): `pnpm run check` passes with 1,256 tests
passed and seven opt-in integration tests skipped. Capsules, deterministic
guardrails and benchmark scorecards pass. `release:pack` builds eight tarballs;
the clean-consumer `release:smoke` passes CLI, schema/template, plugin-import and
offline replay checks without mounting DSH or calling a model. Synthetic tests
use real 0.2.0-rc.2 session/message constructors, but do not claim full launcher,
profile, OAuth, live provider or OS sandbox integration. Existing DAL package
versions remain 0.2.0; these changed artifacts are not published, and an immutable
npm release needs a separately chosen new DAL version before publication.

From a source checkout:

```sh
pnpm run release:check
pnpm run release:pack
pnpm run release:smoke
```

The first command validates committed versions, repository identity and internal
dependency pins. The second builds and packs all eight packages into
`.dal/release/<version>/`, checks required contents, and writes SHA-512 integrity
bindings. Lifecycle build hooks are under `scripts.prepack` (a top-level `prepack`
property is not an npm lifecycle hook).

The smoke test installs those exact tarballs in a disposable consumer directory,
with lifecycle scripts disabled, and checks the executable, workspace initialization,
diagnostics, packaged install-template digests, plugin imports and CLI resolution.
It installs the public DSH tools host peer explicitly. It performs no DSH plugin
mount or model request. It requires registry access for public dependencies and
cleans up its consumer directory even on failure. Repository tests additionally
exercise campaign replay; a package import alone is not runtime integration proof.

## Tokenless publishing

The workflow `.github/workflows/publish.yml` runs for a newly created `v<version>`
tag. All eight committed manifests use that version; release automation never
rewrites versions. The tagged commit must belong to main. The workflow runs the
repository gate, packages and consumer smoke, then publishes the same integrity-
checked tarballs in dependency order with the entry-point bundle last. Prereleases
use `next`; stable releases use `latest`. Concurrent releases of the same tag do
not cancel an active publication. Existing npm versions are immutable; a partial
release requires reconciliation before retrying publication.

Before the first OIDC release, the npm package owner configures **each package**:

- GitHub owner: `lunarmoon26`
- Repository: `dsh-adaptive-loop`
- Workflow filename: `publish.yml`
- Allowed action: direct `npm publish`
- Environment: unset, matching this workflow

The GitHub-hosted job grants `id-token: write`, uses a supported Node/npm release,
and supplies no `NPM_TOKEN` or `NODE_AUTH_TOKEN`. New packages may require an initial
interactive owner publication before their package settings can be configured.
Setting up the workflow locally does not configure npm account trust. Tagging,
pushing and publishing remain explicit release operations.

Pattern: [agent-skill-runtime's workflow](https://github.com/lunarmoon26/agent-skill-runtime/blob/main/.github/workflows/npm-publish.yml),
inspected at file identity `8dbac4f2a2962c55ae5342ff8663c7b117cfd5e5`;
requirements: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).
Registry publication and GitHub OIDC have not been executed by this local change.
