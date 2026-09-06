# Test layout

Run `npm test` for all classified tests, or `npm run test:unit`, `test:fs`,
`test:command`, `test:engine`, `test:robustness`, or `test:acceptance` for a tier.
`unit` is pure and has no filesystem, process, environment, or engine dependency.
`fs` owns local filesystem/Git integration; `command` is headless component
integration with engine calls stubbed; `engine` uses the real CLI; `robustness`
covers explicit failure/concurrency behavior; `acceptance` composes headless journeys.

Every `*.test.ts` below this directory must be classified in `manifest.ts`. Selectors
that match nothing fail deliberately. Stateful tiers run serially. Fixtures must own
and remove their temporary roots, restore environment/cwd/global state, use fake HOME
and XDG roots, resolve workers from `import.meta.url`, and never read user settings or
credentials.
