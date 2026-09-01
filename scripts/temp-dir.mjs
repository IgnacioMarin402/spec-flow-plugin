#!/usr/bin/env node
/**
 * Removing a fixture's scratch directory, when something else may still be
 * writing into it.
 *
 * Several fixtures here `git init` a temp repo. Git can leave background
 * maintenance running after a command returns, so the tree gains files while
 * `rmSync` is walking it, and the walk's `rmdir` fails with `ENOTEMPTY`
 * against a directory that was empty when it was listed.
 *
 * **`maxRetries` does not fix this, and looks like it does.** Measured on a
 * tree of 40 directories with a writer active inside it: the bare call threw
 * `ENOTEMPTY` in 24ms, and `{ maxRetries: 10, retryDelay: 50 }` threw the
 * same error after 2775ms — with the writer already finished. The retry is
 * spent on `rmdir` for a path whose new children were never listed, so it
 * cannot succeed however long it waits. A FRESH `rmSync` per attempt removed
 * the same tree in 311ms, because re-walking is what sees the new files.
 *
 * **Cleanup may never decide a run.** The assertions have already passed by
 * the time this is called; a scratch directory that will not go is a fact
 * about the filesystem, not about the engine, and a fixture that goes red for
 * it reports the wrong thing — which is how this was found, as a red CI job
 * whose every assertion had passed. So the budget is finite and running out
 * is quiet: the directory is under the OS's temp root, which reclaims it.
 */
import { rmSync } from 'node:fs';

/** Attempts before giving up, and the pause between them. */
const ATTEMPTS = 12;
const PAUSE_MS = 50;

/**
 * Remove `dir` and everything under it. Returns whether it went.
 *
 * The pause is a synchronous spin rather than a timer on purpose: every
 * caller is a fixture's `finally`, which cannot await, and the alternative is
 * to leave the retry to `rmSync`, which is the thing that does not work.
 */
export function removeTemp(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt >= ATTEMPTS) return false;
      const until = Date.now() + PAUSE_MS;
      while (Date.now() < until) { /* the writer needs wall-clock time, and this frame cannot yield */ }
    }
  }
}
