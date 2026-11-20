export * as Teardown from "./teardown.js"

// Work that shutdown may be waiting on: layers releasing their resources and child processes that have not
// closed. Read when a shutdown deadline expires, to name what kept the process alive.
const entries = new Set<{ readonly label: string; readonly since: number }>()

/** Record pending work; call the returned function once it settles. */
export function track(label: string) {
  const entry = { label, since: Date.now() }
  entries.add(entry)
  return () => {
    entries.delete(entry)
  }
}

let marked = false

/**
 * Marks that a signal began a shutdown that ends in the process's exit, which drops what the kernel holds for it (file
 * watches, descriptors): a release may skip such work rather than wait on it. Returns the undo, for tests.
 */
export function exit() {
  marked = true
  return () => {
    marked = false
  }
}

/** Whether a signal began the shutdown (`exit`). */
export const exiting = () => marked

/** Pending work, oldest first, with how long each has been pending. */
export function pending(now = Date.now()) {
  return Array.from(entries, (entry) => ({ label: entry.label, ms: now - entry.since }))
}
