// RVLT unit-test runner (zero deps). Usage: npm test  (sets RTV_SKILL_V4=on RTV_DETERMINISTIC=on).
// Each *.test.cjs registers cases via global.T(name, fn); a throw = fail.
const fs = require('fs'), path = require('path');
const cases = [];
global.T = (name, fn) => cases.push([name, fn]);
const dir = __dirname;
fs.readdirSync(dir).filter(f => f.endsWith('.test.cjs')).sort().forEach(f => require(path.join(dir, f)));
let pass = 0, fail = 0; const fails = [];
for (const [name, fn] of cases) {
  try { fn(); pass++; }
  catch (e) { fail++; fails.push(name + '  ::  ' + (e && e.message || e)); }
}
console.log('RVLT tests: ' + pass + ' passed, ' + fail + ' failed  (' + cases.length + ' total)');
if (fails.length) { console.log('\nFAILURES:'); fails.forEach(f => console.log('  ✗ ' + f)); }
process.exit(fail ? 1 : 0);
