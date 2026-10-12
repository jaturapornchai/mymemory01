import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from '../src/claude.ts';

const base = { sessionId: 's1', timestamp: '2026-09-10T10:00:00Z', cwd: 'D:\\demo' };
const user = (uuid: string, content: unknown) => JSON.stringify({ ...base, type: 'user', uuid, parentUuid: null, message: { role: 'user', content } });
const queued = (uuid: string, prompt: unknown, origin: object, commandMode = 'prompt') =>
  JSON.stringify({ ...base, type: 'attachment', uuid, parentUuid: 'u1', attachment: { type: 'queued_command', prompt, commandMode, origin } });
const users = (raw: string[]) => parseClaude(raw.join('\n')).filter((m) => m.role === 'user').map((m) => [m.uuid, m.text]);

test('a human prompt queued while Claude was busy is a user turn; other origins and repeats are not', () => {
  assert.deepEqual(users([
    user('u1', 'first question about the demo widget'),
    JSON.stringify({ ...base, type: 'queue-operation', operation: 'enqueue', content: 'also rename the widget' }),
    queued('q1', 'also rename the widget', { kind: 'human' }),
    queued('q2', [{ type: 'image', source: {} }, { type: 'text', text: 'see this screenshot of the widget' }], { kind: 'human' }),
    queued('q3', 'first question about the demo widget', { kind: 'human' }), // already sent as a user line
    queued('q4', 'message from a peer session', { kind: 'peer' }),
    queued('q5', 'task finished notice', { kind: 'task-notification' }, 'task-notification'),
    queued('q6', 'prompt from older Claude Code without origin', {}),
  ]), [
    ['u1', 'first question about the demo widget'],
    ['q1', 'also rename the widget'],
    ['q2', 'see this screenshot of the widget'],
    ['q6', 'prompt from older Claude Code without origin'],
  ]);
});

test('interrupt markers are not user turns', () => {
  assert.deepEqual(users([
    user('u1', '[Request interrupted by user]'),
    user('u2', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    user('u3', 'next real question about the widget'),
  ]), [['u3', 'next real question about the widget']]);
});
