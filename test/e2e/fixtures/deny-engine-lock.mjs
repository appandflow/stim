import { Server } from 'node:net';

const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (args[0] === process.env.STIM_TEST_ENGINE_LOCK) {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('denied engine lock'), { code: 'EPERM' })));
    return this;
  }
  return Reflect.apply(listen, this, args);
};
