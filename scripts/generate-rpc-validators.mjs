import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createGenerator } from 'ts-json-schema-generator';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const generator = createGenerator({
  path: resolve(root, 'packages/core/phone-protocol.ts'),
  tsconfig: resolve(root, 'scripts/rpc-tsconfig.json'),
  additionalProperties: true,
  jsDoc: 'none',
  expose: 'export',
});
const methods = generator.createSchema('PhoneMethods');
const events = generator.createSchema('PhoneServerEvent');
const error = generator.createSchema('PhoneProtocolError');
const ajv = new Ajv({ code: { source: true, esm: true }, strict: false, inlineRefs: false });
const validators = {};
const names = [];
const methodDefinition = methods.definitions[decodeURIComponent(methods.$ref.slice('#/definitions/'.length))];
const results = Object.fromEntries(
  Object.entries(methodDefinition.properties).map(([method, schema]) => [method, schema.properties.result]),
);
ajv.addSchema({
  $id: 'stim:receive',
  definitions: {
    ...methods.definitions,
    ...events.definitions,
    ...error.definitions,
    MethodResults: { type: 'object', properties: results },
  },
});
for (const method of Object.keys(results)) {
  const key = `response${names.length}`;
  validators[key] = `stim:receive#/definitions/MethodResults/properties/${method}`;
  names.push([method, key]);
}
validators.event = `stim:receive${events.$ref}`;
validators.error = `stim:receive${error.$ref}`;
let code = standaloneCode(ajv, validators);
const eventNames = events.definitions.PhoneServerEvent.anyOf.map(
  ({ $ref }) => events.definitions[decodeURIComponent($ref.slice('#/definitions/'.length))].properties.event.const,
);
code += `\nexport const eventNames = ${JSON.stringify(eventNames)};\n`;
code += `\nexport const responses = {${names.map(([method, key]) => `${JSON.stringify(method)}:${key}`).join(',')}};\n`;
const target = resolve(root, 'packages/core/receive-validators.mjs');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== code)
    throw new Error('RPC validators changed. Run node scripts/generate-rpc-validators.mjs.');
} else {
  writeFileSync(target, code);
}
console.log(`RPC validators: ${names.length} methods; ${Buffer.byteLength(code)} bytes.`);
