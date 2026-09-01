# DAL unknown-effect guard (disabled G2 candidate)

This package is a bounded harness-code candidate for the tau-style workflow experiment. It claims each side-effect idempotency key before dispatch, blocks concurrent or post-`unknown` same-key retries for that agent, and releases the key only when `get_effect_status` returns `success` or `definite_failure`.

The bundle row in `plugins/dal-modes/cordis.patch.yml` is disabled. Repository source, compilation, and unit tests are not deployment authority:

- installing or mounting this package requires an exact, unexpired `install_or_mount_plugin` decision for the package digest, target profile, and operation;
- applying it as an optimization generation separately requires an exact, unexpired `apply_optimization_candidate` decision for the candidate and target;
- rollback reinstalls the previous pinned profile generation.

The plugin keeps only per-agent key/status metadata in memory. It persists no tool arguments or results and does not call a model, network service, optimizer, installer, or candidate applier.
