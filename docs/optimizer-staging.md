# Optimizer Candidate Staging

Change: `chg-dal-evolution-staging-integrity-20260905`
Owner: DAL-021 staging behavior; exact exchange/candidate/verdict syntax remains in the existing optimizer schemas.

`dal optimize evaluate --exchange <file> --candidate <file> --output <verdict-file> [--candidate-out .dal/candidates/<name>.md]` validates only; it does not activate a candidate.

The general overwrite-capable JSON writer is removed. `dal optimize prepare` publishes exchanges exclusively as `.dal/check/<exchange-id>.json`; consumers use the printed `exchange_path`, not the former fixed `optimizer-exchange.json` filename. Existing exchange files remain untouched.

Acceptance criteria:

1. Candidate exchange identity, skills surface, target URI, and declared base digest match the exchange. The adapter hashes the actual on-disk base bytes against the exchange before decoding or reconstructing. Drift produces an invalid verdict with `base-content-digest: false`, no reconstruction, and no candidate output.
2. Every validation check passes before candidate text is returned or staged. Rejected candidates may produce a diagnostic verdict, but never a candidate file.
3. Candidate output is a new raw UTF-8 Markdown file, with no JSON quoting or added newline, exclusively created with mode `0600`. Existing destinations (including hard links and symlinks) are never replaced, even for identical text.
4. The only candidate output root is `.dal/candidates/` under the invocation's physical working directory. Output must be a direct child with a `.md` extension. Outside paths, nested paths, symlinked `.dal` or `candidates` directories, and symlink destinations fail closed. Missing staging directories are created with mode `0700`. Staging does not write to the exchange target or installable skill paths.
5. Focused regression tests precede `pnpm run check`; no model, network, install, activation, or evaluator implementation is part of this increment.
6. Verdict publication is exclusive and precedes candidate staging. An existing verdict destination fails with `OPTIMIZE_OUTPUT_CONFLICT`, preserves its exact bytes, prints no successful evaluation result, and stages no candidate.

Staging errors fail the command; an exclusively published verdict can remain when subsequent candidate staging fails. This local filesystem guard is not an OS sandbox against another process with the same user's authority racing directory replacement. Full proposer confinement and independent candidate-bound evaluation remain roadmap work. No persisted schema fields change.
