import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { preserveJsFunctionBoundaries } from './preserve-js-function-boundaries.mjs';

test('compiled boundaries preserve hoisting, captures, recursion, tables and isolated instances', () => {
  const source = `function asmFunc(imports) {
    'use strict';
    var counter = imports.initial;
    var before = $1(3);
    function helper() { return 17; }
    function $1(value) { if (value <= 0) return counter; counter++; return $1(value - 1); }
    function $2(value) { var nested = $1(value); return nested + counter; }
    function $3($1) { $1 = ($1 | 0) + counter; return $1; }
    return { before: before, call: $2, table: [$1, $2, $3], equal: $1 === $1, helperName: helper.name };
  }`;
  const transformed = preserveJsFunctionBoundaries(source);
  const execute = code => {
    const context = vm.createContext({});
    vm.runInContext(code, context);
    return JSON.parse(vm.runInContext(`JSON.stringify((function(){
      var first = asmFunc({initial: 1}), second = asmFunc({initial: 100});
      return [first.before, second.before, first.call(5), second.table[1](1), first.table[0](2), first.call(0),
        first.table[2](), first.table[2](4, 99), first.equal, first.helperName];
    })())`, context));
  };
  assert.deepEqual(execute(transformed), execute(source));
  assert.match(transformed, /function asmFunc\(imports\)\s*{\s*'use strict';/);
  assert.ok(transformed.includes('function helper() { return 17; }'));
});

test('unsafe call semantics and unexpected factory shapes stop generation', () => {
  for (const body of ['return this;', 'return arguments[0];', 'return new.target;']) {
    assert.throws(() => preserveJsFunctionBoundaries(`function asmFunc(){function $1(){${body}}return $1;}`),
      /unsupported call semantics/);
  }
  assert.throws(() => preserveJsFunctionBoundaries('function asmFunc(){function $1(){}return new $1();}'),
    /unsupported call semantics/);
  assert.throws(() => preserveJsFunctionBoundaries('function other(){}'), /Unexpected wasm2js factory/);
  assert.throws(() => preserveJsFunctionBoundaries('function asmFunc(){}'), /Unexpected compiled function/);
  assert.throws(() => preserveJsFunctionBoundaries('function asmFunc(){'), /Invalid lowered JavaScript/);
  for (const expression of ['$1.name', '$1 = 3', 'eval("$1")']) {
    assert.throws(() => preserveJsFunctionBoundaries(`function asmFunc(){function $1(){}return (${expression});}`),
      /binding cannot be observed or mutated/);
  }
});
