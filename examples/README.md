# Worked contracts

Copy one to `.spec-flow/config.json` in your repo and adjust it. Verify with:

```bash
node node_modules/spec-flow-plugin/scripts/spec-flow-config.mjs
```

| file | stack |
|---|---|
| `vitest-typescript.json` | TypeScript + Vitest, tests under `test/`, npm |
| `nestjs-jest.json` | NestJS + Jest, hexagonal layout, pnpm, one `extra_check` |

`_comment` is ignored by the reader — every other key is documented in the
root README's contract table.

These files are the one place in this repository allowed to name a specific
stack, and `scripts/no-repo-refs.mjs` skips this directory for that reason. A
contract's whole job is to hold the values the engine refuses to know, so a
useful example is stack-specific by definition. Nothing here is read at
runtime; the engine only ever reads the consuming repo's own
`.spec-flow/config.json`.
