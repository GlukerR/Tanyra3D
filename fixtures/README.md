# Golden corpus — `fixtures/`

A set of real models used as the regression backbone for the core. The reasoning is that "an
optimizer that corrupts one asset loses trust permanently" (`docs/ARCHITECTURE.md` §8): any
change in the output on these models is a reviewed diff, not a silent drift.

---

## License policy (IMPORTANT)

Many downloaded models carry a license inside the file (author, source, license type). For
EVERY model in the corpus:

1. Check the embedded license:

   ```bash
   node fixtures/check-licenses.mjs
   ```

2. The script writes a sidecar file `<name>.license.md` next to the model with whatever it
   found (`asset.copyright`, `asset.generator`,
   `asset.extras.{author,license,source,title}`). If no license is found automatically, the
   file is created with empty TODO fields to be filled in by hand (author / source / whether
   it may be redistributed).
3. Do this for **ALL** future corpus models. The repetitive part lives in the script so that
   nobody has to do it manually each time.

---

## Models are not versioned and are not shipped

- **Not in git:** model binaries (`*.glb / *.gltf / *.bin / textures`) are excluded by this
  folder's `.gitignore`. The reason: the repository is public (Apache-2.0) and third-party
  models carry their own licenses, so committing them would be a violation. Only the sidecar
  licenses (`*.license.md`), this README, the script and the snapshots are versioned.
- **A redistributable model** (CC0 or explicitly cleared for redistribution) may be added to
  git explicitly, AFTER its license has been recorded in the sidecar:

  ```bash
  git add -f fixtures/models/<name>.glb
  ```

  The `-f` is required because the `.gitignore` above covers the whole folder. Use it only
  when the sidecar states the model may be redistributed — that check is the whole point of
  the policy.
- **Not in the program:** `fixtures/` is for development and tests only. `server.mjs` does not
  serve it and `package.json` is private (`"private": true`), so the models cannot reach a
  downloadable build. If packaging is ever added, put `fixtures/` in the exclusions
  (`.npmignore` or the `files` field).

---

## Layout

```
fixtures/
├─ README.md            — this file
├─ .gitignore           — model binaries are not committed
├─ check-licenses.mjs   — checks embedded licenses (writes the sidecar)
└─ models/              — corpus models
   ├─ <name>.glb        — the model (gitignored unless redistributable)
   └─ <name>.license.md — its license / attribution (in git)
```

The models the corpus is exercised against, and which test uses which, are described in
[`tests/TEST-MAP.md`](../tests/TEST-MAP.md) — layer 2.
