import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const roots = ['../tests/consumers/web-vite'];
for (const root of roots) {
  const owner = createRequire(new URL(root + '/package.json', import.meta.url));
  const {SourceMapConsumer, SourceMapGenerator} = owner('source-map-js');
  test(`${root}: indexed maps preserve offsets and reject excessive line offset`, () => {
    const generator = new SourceMapGenerator({file:'out.js'});
    generator.addMapping({generated:{line:1,column:0},original:{line:1,column:0},source:'in.js'});
    const leaf = generator.toJSON();
    const valid = new SourceMapConsumer({version:3,sections:[{offset:{line:1,column:0},map:leaf}]});
    const mappings=[];valid.eachMapping(mapping=>mappings.push(mapping));
    assert.equal(mappings.length,1);assert.equal(mappings[0].source,'in.js');assert.equal(mappings[0].generatedLine,2);
    assert.throws(()=>new SourceMapConsumer({version:3,sections:[{offset:{line:10000001,column:0},map:leaf}]}), /must not exceed 10000000/);
  });
}
for (const root of ['../frameworks/react-native']) {
  const owner=createRequire(new URL(root+'/package.json',import.meta.url));
  const shell=owner('shell-quote');
  test(`${root}: comment-following line terminators cannot become shell input`,()=>{
    for(const newline of ['\n','\r','\u2028','\u2029']) assert.throws(()=>shell.quote(['echo','ok',{comment:'x'},'a'+newline+'id;#']), TypeError);
    assert.deepEqual(shell.parse(shell.quote(['echo','a b'])), ['echo','a b']);
  });
}


