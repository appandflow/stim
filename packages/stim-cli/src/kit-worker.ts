import nodeModule, { register } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const stimImport = (specifier: string) =>
  `a plugin imports '${specifier}' at runtime; import types from 'stim/plugin' only`;

/** Node before 22.15 has no `module.registerHooks`; its asynchronous hooks see `import` and not `require`. */
const NO_STIM_IMPORT = `export async function resolve(specifier, context, next) {
  if (specifier === 'stim' || specifier.startsWith('stim/'))
    throw new Error("a plugin imports '" + specifier + "' at runtime; import types from 'stim/plugin' only");
  return next(specifier, context);
}`;

export type KitRequest =
  | { type: 'call'; seq: number; member: string; args: unknown[] }
  | { type: 'subscribe'; seq: number; member: string }
  | { type: 'unsubscribe'; seq: number; target: number };

export type KitReply =
  | { type: 'ready'; id: string; members: string[] }
  | { type: 'failed'; message: string }
  | { type: 'result'; seq: number; value: unknown }
  | { type: 'error'; seq: number; message: string }
  | { type: 'event'; seq: number; value: unknown };

type Member = (...args: unknown[]) => unknown;

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() || 'unknown error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function run(port: NonNullable<typeof parentPort>): Promise<void> {
  const { href, factory, input, capabilities } = workerData as {
    href: string;
    factory: string;
    input: unknown;
    capabilities: string[];
  };
  const post = (reply: KitReply) => port.postMessage(reply);
  let module: Record<string, unknown>;
  try {
    if (typeof nodeModule.registerHooks === 'function')
      nodeModule.registerHooks({
        resolve(specifier, context, next) {
          if (specifier === 'stim' || specifier.startsWith('stim/')) throw new Error(stimImport(specifier));
          return next(specifier, context);
        },
      });
    else register(`data:text/javascript,${encodeURIComponent(NO_STIM_IMPORT)}`);
    const namespace: unknown = await import(href);
    const found =
      isRecord(namespace) && !(factory in namespace) && 'default' in namespace ? namespace.default : namespace;
    if (!isRecord(found) || typeof found[factory] !== 'function')
      return post({ type: 'failed', message: `the module does not export ${factory}()` });
    module = found;
  } catch (error) {
    return post({ type: 'failed', message: `the module did not load: ${reason(error)}` });
  }
  let instance: Record<string, unknown>;
  try {
    const made: unknown = await (module[factory] as Member)(input);
    if (!isRecord(made) || typeof made.id !== 'string')
      return post({ type: 'failed', message: `${factory}() did not return an object with a string id` });
    instance = made;
  } catch (error) {
    return post({ type: 'failed', message: `${factory}() failed: ${reason(error)}` });
  }
  const malformed = capabilities.find((name) => instance[name] !== undefined && typeof instance[name] !== 'function');
  if (malformed)
    return post({ type: 'failed', message: `${factory}() returned a ${malformed} that is not a function` });
  post({
    type: 'ready',
    id: instance.id as string,
    members: capabilities.filter((name) => typeof instance[name] === 'function'),
  });

  const stops = new Map<number, () => void>();
  port.on('message', async (request: KitRequest) => {
    const { seq } = request;
    try {
      if (request.type === 'unsubscribe') {
        stops.get(request.target)?.();
        stops.delete(request.target);
        return post({ type: 'result', seq, value: null });
      }
      const member = instance[request.member];
      if (typeof member !== 'function') throw new Error(`the transport has no ${request.member}()`);
      if (request.type === 'subscribe') {
        const stop: unknown = member.call(instance, (value: unknown) => {
          try {
            post({ type: 'event', seq, value });
          } catch (error) {
            post({ type: 'error', seq, message: reason(error) });
          }
        });
        if (typeof stop !== 'function') throw new Error(`${request.member}() did not return a function that stops it`);
        stops.set(seq, stop as () => void);
        return post({ type: 'result', seq, value: null });
      }
      const value: unknown = await member.apply(instance, request.args);
      post({ type: 'result', seq, value: value === undefined ? null : value });
    } catch (error) {
      post({ type: 'error', seq, message: reason(error) });
    }
  });
}

if (parentPort && workerData?.stimKit === true) void run(parentPort);
