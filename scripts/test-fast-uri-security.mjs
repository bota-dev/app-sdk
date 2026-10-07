import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const uri = require('fast-uri');
const Ajv = require('ajv');
test('URI serialization rejects authority injection through port', () => {
  assert.throws(() => uri.serialize({scheme:'http',host:'trusted.example',port:'@127.0.0.1:8124',path:'/app'}), /port.*malformed/);
  assert.equal(uri.serialize({scheme:'https',host:'trusted.example',port:8443,path:'/app'}), 'https://trusted.example:8443/app');
});
test('malformed bracket authority cannot hide the actual loopback host', () => {
  const parsed = uri.parse('http://[@127.0.0.1/app');
  assert.ok(parsed.error || parsed.host === new URL('http://[@127.0.0.1/app').hostname);
  assert.equal(uri.parse('http://[::1]/app').error, undefined);
});
test('Ajv resolves a relative schema reference and validates both outcomes', () => {
  const ajv = new Ajv();
  ajv.addSchema({$id:'https://schemas.example.test/base/value.json',type:'integer'}, 'value');
  const validate = ajv.compile({$id:'https://schemas.example.test/base/entry.json',type:'object',properties:{value:{$ref:'value.json'}},required:['value']});
  assert.equal(validate({value:42}), true);
  assert.equal(validate({value:'42'}), false);
});
