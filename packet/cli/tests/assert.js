// assert.js — the world's smallest test harness. No dependencies.

export function createHarness(title) {
  const state = { pass: 0, fail: 0, failures: [] };

  const ok = (name, cond, detail) => {
    if (cond) { state.pass++; return; }
    state.fail++;
    state.failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
  };

  const eq = (name, actual, expected) =>
    ok(name, Object.is(actual, expected),
       `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

  const match = (name, actual, re) =>
    ok(name, re.test(String(actual)), `${JSON.stringify(String(actual))} does not match ${re}`);

  const section = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

  const report = () => {
    console.log('');
    if (state.fail) {
      console.log(`\x1b[31m${state.fail} failed\x1b[0m, ${state.pass} passed  \x1b[2m(${title})\x1b[0m\n`);
      state.failures.forEach(f => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
      console.log('');
      return false;
    }
    console.log(`\x1b[32m✓ all ${state.pass} checks passed\x1b[0m  \x1b[2m(${title})\x1b[0m\n`);
    return true;
  };

  return { ok, eq, match, section, report, state };
}
