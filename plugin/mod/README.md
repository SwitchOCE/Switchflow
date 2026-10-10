# Switchflow mod

The native UI for the Claude Code Desktop app's Code tab: a status entry, an approval band above the prompt, a
Switchflow pane and toasts, drawn from the machine-wide control service. It draws on the `desktop` surface only;
elsewhere it hands every site back to the engine.

- `hooks.json` names the hooks module, `register.tsx`.
- `register.tsx` holds every hook and every function that touches `$` (the engine follows `$` within one file only).
- `client.ts` is every call to the service: finding it through `control-service/service-info.json` under the state
  folder, matching the session's folder to a registered project, polling and posting actions. Moving the poll to
  `GET /api/projects/<id>/summary?since=` changes `loadSnapshot` in this file only.
- `model.ts` is pure: the snapshot, the status text, the owner's buttons per gate and the toasts per transition.
- `types/index.d.ts` is the `$.state` contract under the plugin name `switchflow`.

Approvals are the owner's presses in the band. Nothing here registers a tool the model can call.

## Wiring

The plugin manifest (`plugin/.claude-plugin/plugin.json`) needs:

```json
"hooks": "./mod/hooks.json",
"types": "./mod/types/index.d.ts"
```

and the plugin's `name` must be `switchflow`, the key the state contract and the tests use.

## Checking it

`claude plugin validate` and `claude plugin test` take a plugin folder. Until the manifest above lands, wrap this
folder in a throwaway one:

```sh
mkdir -p /tmp/sf-mod/.claude-plugin && cp -r plugin/mod /tmp/sf-mod/mod
echo '{ "name": "switchflow", "version": "0.1.0", "hooks": "./mod/hooks.json", "types": "./mod/types/index.d.ts" }' \
  > /tmp/sf-mod/.claude-plugin/plugin.json
claude plugin validate /tmp/sf-mod
claude plugin test /tmp/sf-mod
```
