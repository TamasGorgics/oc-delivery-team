# Evaluation model presets

`team eval run --models <preset>` loads `<preset>.json` from this directory. A preset may contain:

- `hostModel`: optional OpenCode `provider/model` used by the headless runner. Omit it to inherit the OpenCode host default.
- `models`: optional delivery-team model routing object using the same shape as the plugin's `models` option (`default`, `tiers`, `roles`, and related fields).
- `description`: optional human-readable label.

Presets are configuration, not code: do not add credentials or secrets. The built-in `host-default` preset inherits the model configured by OpenCode and leaves delivery-team role routing unchanged.
