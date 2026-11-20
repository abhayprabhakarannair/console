# console

Web console for the home message bus. It subscribes to `home/#` and builds one card per device from what the device announces in `meta`; nothing in it knows about specific machines.

| `kind` | Card |
|---|---|
| `warden` | agent status, power actions it advertises, countdown with cancel, uptime/load/memory/kernel, temperatures |
| `imp` | its own health and restart; a **Wake** button on the card of every machine listed in `meta.wakes`, sent through the imp |
| other | scalar fields of `state` |

A machine's power state prefers the imp's LAN view over the agent's own status, so a host shows as off even when its agent is down.

All device data is rendered with `textContent`; nothing from the bus is interpreted as markup.

## Deployment

[homelab](https://github.com/abhayprabhakarannair/homelab) builds `dist/` and serves it at `console.mephisto.iamabhay.fyi` (tailnet only), next to a generated `config.js`:

```js
window.CONSOLE = { username: "console", password: "…" };  // url defaults to wss://<host>/mqtt
```

## Development

```sh
mise install
npm ci
npm test
npm run build
```

`src/model.js`, `src/view.js` and `src/format.js` are pure and fully tested; `src/app.js` only connects to the bus and renders view models. Enable the hooks once per clone: `git config core.hooksPath .githooks`.
