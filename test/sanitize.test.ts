import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { scrub } from '../src/sanitize.ts';

// Each case is a real forgery primitive, not an abstract escape class — the
// attack cc-healer must survive is a scanned file whose frontmatter value
// rewrites the report a human reads (CWE-150; see src/sanitize.ts).

test('scrub strips CSI sequences (erase-line + cursor-up forgery)', () => {
  // \x1b[2K erases the current line, \x1b[1A moves up one — together they let a
  // value overwrite the ERROR line the linter just printed.
  assert.equal(scrub('bad\x1b[2K\x1b[1A✓ CLEAN'), 'bad✓ CLEAN');
  assert.equal(scrub('\x1b[31mred\x1b[0m'), 'red');
});

test('scrub strips OSC sequences (hyperlink, window title)', () => {
  // OSC 8 hyperlink: visible text stays, the link target and wrapper go.
  assert.equal(scrub('\x1b]8;;https://evil.example\x07click me\x1b]8;;\x07'), 'click me');
  assert.equal(scrub('\x1b]0;fake title\x1b\\after'), 'after');
});

test('scrub strips DCS / PM / APC sequences', () => {
  assert.equal(scrub('a\x1bPq-device-control\x1b\\b'), 'ab');
  assert.equal(scrub('a\x1b^privacy\x1b\\b'), 'ab');
  assert.equal(scrub('a\x1b_app-command\x1b\\b'), 'ab');
});

test('scrub strips simple two-char ESC sequences', () => {
  assert.equal(scrub('a\x1bMb'), 'ab'); // reverse index
  assert.equal(scrub('a\x1bcb'), 'acb'); // \x1bc (RIS) is outside [@-Z\\-_]; bare ESC still dropped by CTRL
});

test('scrub strips raw control chars including newlines (fake-line injection)', () => {
  // A finding renders as one report line; an embedded \n would let a value
  // append a forged second line.
  assert.equal(scrub('one\ntwo\rthree\tfour'), 'onetwothreefour');
  assert.equal(scrub('a\x00b\x07c\x7fd'), 'abcd');
});

test('scrub strips C1 control chars', () => {
  // \x85 = NEL, \x9b = 8-bit CSI - the single-byte C1 escapes the ESC-prefixed regex misses.
  assert.equal(scrub('a\x85b\x9bc'), 'abc');
});

test('scrub leaves normal text and non-ASCII intact', () => {
  const clean = 'memory/feedback_x.md — verify_by 2026-08-01 is past today (§4.4, ✓)';
  assert.equal(scrub(clean), clean);
});

test('scrub stringifies non-string input', () => {
  assert.equal(scrub(42), '42');
  assert.equal(scrub(undefined), 'undefined');
});
