# Power Analyzer — DeviceDock plugin

Captures current and power from a USB power analyzer (4-byte sample stream, up to 100 kHz) and
plots it in DeviceDock. The analyzer is claimed **exclusively** through the host's `serial.claim`
API, so it never touches `navigator.serial` and never borrows the debug app's S/A/B lanes.

## Install

1. Open the plugin panel in the DeviceDock desktop client.
2. Paste this repository URL: `https://github.com/Roomen/devicedock-plugin-power`
   (optionally `@v1.0.0` to pin a release).
3. Review the requested capabilities and confirm.

The client downloads `devicedock-plugin.zip` plus its `.sha256` from the GitHub release,
verifies both, and loads the plugin inside a sandboxed, opaque-origin iframe.

## What it does

- **Exclusive port claim.** `device.listPorts` lists the ports; `claim.acquire({mode: 'exclusive'})`
  → `claim.open` → `claim.write`; every byte arrives as a batched `claim.rx` event. Closing goes
  through `claim.close` / `claim.release`.
- **Byte-stream parsing.** One `claim.rx` event may contain many frames or half a frame, so the
  decoder keeps its own remainder, learns the constant bits at the start of the stream, and
  re-synchronises the 4-byte phase after lost bytes.
- **Honest gaps.** `claim.rx` carries `gen`, `seq` and `offset`; a `gen` change is a new stream,
  while `offset ≠ previous offset + previous length` (or a `claim.gap` event, or the device's own
  sample counter jumping) means bytes were lost. Gaps are drawn as vertical markers on the
  waveform and statistics **never integrate time or energy across a gap**.
- **Waveform + long-run statistics.** Hot samples stay in a ring of chunks; older chunks are
  deflate-compressed into an in-memory cold store. Both budgets are configurable, and the cold
  cap drops the oldest blocks (reported as gaps) instead of failing.
- **Source voltage and DUT power.** `REGULATOR_SET` / `DEVICE_RUNNING_SET` with the vendor's
  safety rules: a failed voltage write never powers the DUT on, and a failed write marks the
  power state `unknown` (the protocol has no read-back command).
- **Export.** CSV for the visible window or the whole session, JSON summary otherwise, through
  `app.saveFile`.
- **Update barrier.** While a capture is running the plugin holds `app.busyAcquire({label: 'Power capture'})`,
  which keeps DeviceDock from installing an application update mid-capture.
- **Theme.** Light and dark both follow the host `tokens` pushed by `ready` / `theme-change`;
  the canvas reads its colours from CSS variables and repaints on theme change.

## Capabilities

| Capability | Why |
| --- | --- |
| `device.read` | List serial ports (name, VID/PID, serial number, current owner). |
| `serial.claim` | Declare the analyzer port, open it, write commands, receive `claim.rx` / `claim.gap`. |
| `app` | Theme tokens, busy source (update barrier), settings in plugin storage, `app.saveFile` for exports. |
| `log` | Write `[Power Analyzer]` lines into the host log. |

## Known limitations

- **No MCP.** This plugin exposes no MCP tools and has no `mcp-bridge` dependency; it is a UI
  plugin only.
- **Memory-only cold storage.** The plugin sandbox has no OPFS, IndexedDB or `localStorage`, so
  compressed cold blocks live in memory (default cap 512 MiB of raw samples, adjustable between
  16 MiB and 4 GiB). Everything is lost when the plugin is unloaded or the window is closed.
  Hitting the cap drops the oldest blocks and marks them as gaps.
- **8 MiB export limit.** `app.saveFile` accepts at most 8 MiB. Larger selections are refused
  with the exact estimated size and the maximum number of samples that would fit — the export is
  never truncated silently. Use a shorter window or the JSON summary instead.
- **Batched data can outrun the plugin.** The host holds at most 8 MiB per claim and reports
  drops as `claim.gap`; the plugin also caps its own pending queue (about 4 s at 100 kHz) and
  reports that as a gap. Both cases show up in the gap counter, never as smooth fake data.
- **No calibration UI, no MCP, no BLE / classic-Bluetooth transports**, no multi-device
  simultaneous capture (one claim at a time).

## Development

```bash
npm test                 # protocol, lane, wave store, claim, control, export, UI smoke
node tools/build.mjs     # refresh manifest integrity, write dist/devicedock-plugin.zip(+.sha256)
```

Source layout:

| File | Role |
| --- | --- |
| `js/power-protocol.js` | Sample-stream decoder, range/ADC conversion, resampling, folding overview. |
| `js/power-claim.js` | Claim lifecycle and the `claim.rx` / `claim.gap` byte-stream bookkeeping (gap marking, bounded ingest queue). |
| `js/power-control.js` | Power / voltage / capture state machine on a single serial queue, and summaries. |
| `js/power-wave.js` | Chunked waveform store: hot ring, cold archive queue, envelopes, buckets, gaps. |
| `js/power-store.js` | In-memory deflate-compressed cold storage with a raw-equivalent cap. |
| `js/power-lane.js` | Pure helpers for aligning non-sample events to sample indices. |
| `js/power-analysis.js` | Pure statistics: levels, spikes, FFT, battery estimate, cycle overlay. |
| `js/power-export.js` | Export planning and CSV/JSON building with the 8 MiB guard. |
| `js/app.js` | UI wiring and the canvas renderer. |

Releases are cut by pushing a `v*` tag: CI runs the tests, builds the archive and publishes it.

## License

MIT — see [LICENSE](LICENSE).
