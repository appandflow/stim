import type { StimContext } from '@stim-cli/core';

const scopes = new WeakMap<StimContext, Map<string, Promise<unknown>>>();

/**
 * Opens a scope in which reads under `operation` with the same key share one answer, so one daemon pass or one `gc`
 * run asks git each question once. The returned function closes the scope; opening one already open returns a no-op.
 * A scope holds answers only while nothing acts: `forgetGitReads` runs before and after every action and whenever a
 * workspace process lock is taken, so every check made under a claim asks git again.
 */
export function openGitReads(operation: StimContext | undefined): () => void {
  if (!operation || scopes.has(operation)) return () => {};
  scopes.set(operation, new Map());
  return () => {
    scopes.delete(operation);
  };
}

export function gitReadsOpen(operation: StimContext | undefined): boolean {
  return Boolean(operation && scopes.has(operation));
}

/** Drops every answer of the open scope, so later reads ask git again; a read already running stores into the old one. */
export function forgetGitReads(operation: StimContext | undefined): void {
  if (operation && scopes.has(operation)) scopes.set(operation, new Map());
}

/**
 * The scope's answer for `key`, or `read()` stored as it when a scope is open; a failed read is not kept. `share`
 * stores another key's answer in the same scope the read started in.
 */
export function sharedRead<T>(
  operation: StimContext | undefined,
  key: string,
  read: (share: (key: string, answer: Promise<unknown>) => void) => Promise<T>,
): Promise<T> {
  const scope = operation && scopes.get(operation);
  if (!scope) return read(() => {});
  const known = scope.get(key) as Promise<T> | undefined;
  if (known) return known;
  const pending = read((other, answer) => {
    if (!scope.has(other)) scope.set(other, answer);
  });
  scope.set(key, pending);
  pending.catch(() => {
    if (scope.get(key) === pending) scope.delete(key);
  });
  return pending;
}
