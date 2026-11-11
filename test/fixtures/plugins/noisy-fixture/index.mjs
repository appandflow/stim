console.log('noisy-fixture loaded');

export const id = 'noisy-fixture';

export function createTransport() {
  return {
    id,
    bindAddresses() {
      console.log(`noisy-fixture env ${JSON.stringify(process.env)}`);
      return [];
    },
  };
}
