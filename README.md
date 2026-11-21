# console

Web console for the home message bus. It subscribes to `home/#` and builds one card per device from what the device announces in `meta`; nothing in it knows about specific machines.

| `kind` | Card |
|---|---|
| `warden` | agent status, power actions it advertises, countdown with cancel, uptime/load/memory/kernel, temperatures; internet links in failover order with the active one and usage this cycle against any cap (`wan` module); online devices with their link (wired, or Wi-Fi band and signal) and the ISP their traffic uses (`clients` module), and, for devices with a DHCP reservation (`reserved`), an Auto/ISP choice sent as `isp <ip> <isp|auto>` when the agent advertises `isp` |
| other | scalar fields of `state` |

Any device that lists machines in `meta.wakes` (a warden with the `wake` module) puts a **Wake** button on each of those machines' cards. With several, the button goes through an online one, the first by id.

A machine's power state prefers that waker's LAN view over the agent's own status, so a host shows as off even when its agent is down.

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
