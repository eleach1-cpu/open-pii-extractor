// Runtime proof (safety handoff §10): boots the REAL Electron app with
// OPE_SMOKE=1 and asserts on facts the main process gathered through the
// live window: the renderer OS sandbox flag, the terms gate refusing a
// privileged call before acceptance, and redaction working after it.
// Grep-of-source can lie about runtime; this cannot.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('electron runtime: sandbox on, terms gate enforced in main, redaction live after acceptance', { timeout: 120000 }, () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ope-smoke-ud-'));
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ope-smoke-out-')), 'facts.json');
  // Under plain Node, require('electron') exports the path to the Electron
  // binary; spawning it directly (shell: false) avoids DEP0190.
  const electron = require('electron');
  const r = spawnSync(electron, ['.'], {
    cwd: ROOT,
    env: { ...process.env, OPE_SMOKE: '1', OPE_SMOKE_USERDATA: userData, OPE_SMOKE_OUT: outFile },
    timeout: 90000,
    shell: false,
  });
  assert.ok(fs.existsSync(outFile), `smoke run wrote no facts (status ${r.status}, stderr: ${String(r.stderr).slice(0, 400)})`);
  const facts = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.strictEqual(facts.rendererSandboxed, true, 'renderer is not OS-sandboxed at runtime');
  assert.strictEqual(facts.termsAcceptedFresh, false, 'fresh profile must start unaccepted');
  assert.ok(facts.redactBeforeTerms && /accept the terms/i.test(facts.redactBeforeTerms.error || ''),
    'privileged IPC before acceptance must be refused by the MAIN process: ' + JSON.stringify(facts.redactBeforeTerms));
  assert.ok(facts.redactAfterTerms && /\[SSN REDACTED\]/.test(facts.redactAfterTerms.redacted_text || ''),
    'redaction did not run after acceptance: ' + JSON.stringify(facts.redactAfterTerms));
});
