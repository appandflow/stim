import type { StimContext } from '@stim-cli/core';

const scopes = new WeakMap<StimContext, Map<string, Promise<unknown>>>();

/**
 * Opens a scope in which reads under `operation` with the same key share one answer, so one daemon pass or one `gc`
 * run asks git each question once. The returned function closes the scope; opening one already open returns a no-op.
 * A scope holds answers only while nothing acts: call `forgetGitReads` after every action.
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

/** Drops every answer of the open scope, so reads after an action ask git again. */
export function forgetGitReads(operation: StimContext | undefined): void {
  if (operation) scopes.get(operation)?.clear();
}

/** The scope's answer for `key`, or `read()` stored as it when a scope is open; a failed read is not kept. */
export function sharedRead<T>(operation: StimContext | undefined, key: string, read: () => Promise<T>): Promise<T> {
  const scope = operation && scopes.get(operation);
  if (!scope) return read();
  const known = scope.get(key) as Promise<T> | undefined;
  if (known) return known;
  const pending = read();
  scope.set(key, pending);
  pending.catch(() => {
    if (scope.get(key) === pending) scope.delete(key);
  });
  return pending;
}

/** Stores `answer` under `key` for later reads in the open scope, unless one is already there. */
export function shareAnswer(operation: StimContext | undefined, key: string, answer: Promise<unknown>): void {
  const scope = operation && scopes.get(operation);
  if (scope && !scope.has(key)) scope.set(key, answer);
}
