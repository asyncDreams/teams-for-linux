'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PRESENCE_STATUS,
  chooseBestPresence,
  PresenceProvider,
  PresenceAggregator,
  PresenceStateMachine,
} = require('../../app/presence/sync');

describe('presence candidate precedence', () => {
  it('prefers explicit status, DND, busy, meeting, presenting, available, then away', () => {
    const candidates = [
      { status: PRESENCE_STATUS.AWAY, source: 'Teams DOM', kind: 'away', updatedAt: 1 },
      { status: PRESENCE_STATUS.AVAILABLE, source: 'Microsoft Graph', kind: 'available', updatedAt: 2 },
      { status: PRESENCE_STATUS.BUSY, source: 'Meeting', kind: 'meeting', updatedAt: 3 },
      { status: PRESENCE_STATUS.BUSY, source: 'Teams DOM', kind: 'busy', updatedAt: 4 },
      { status: PRESENCE_STATUS.DO_NOT_DISTURB, source: 'Microsoft Graph', kind: 'dnd', updatedAt: 5 },
      { status: PRESENCE_STATUS.BUSY, source: 'User status', kind: 'explicit', updatedAt: 6 },
    ];

    assert.equal(chooseBestPresence(candidates).source, 'User status');
  });

  it('lets a meeting outrank a passive DOM Available signal', () => {
    const aggregator = new PresenceAggregator({ debounceMs: 0, providerTtlMs: 60_000 });
    aggregator.update('dom', { status: 1, source: 'Teams DOM', kind: 'available' }, 100);
    aggregator.update('meeting', { status: 2, source: 'Meeting', kind: 'meeting' }, 200);

    assert.deepEqual(aggregator.getCurrent(), {
      status: 2,
      label: 'Busy',
      source: 'Meeting',
      kind: 'meeting',
      provider: 'meeting',
      updatedAt: 200,
    });
  });

  it('keeps explicit Busy above an active meeting and explicit DND above Busy', () => {
    const aggregator = new PresenceAggregator({ debounceMs: 0 });
    aggregator.update('meeting', { status: 2, source: 'Meeting', kind: 'meeting' }, 100);
    aggregator.update('explicit', { status: 2, source: 'Explicit user status', kind: 'explicit' }, 200);
    assert.equal(aggregator.getCurrent().source, 'Explicit user status');

    aggregator.update('explicit', { status: 3, source: 'Explicit user status', kind: 'explicit' }, 300);
    assert.equal(aggregator.getCurrent().status, 3);
  });
});

describe('presence state machine', () => {
  it('debounces changes and commits the latest candidate on flush', () => {
    const transitions = [];
    const machine = new PresenceStateMachine({
      debounceMs: 500,
      onTransition: (state) => transitions.push(state),
    });
    const available = { status: 1, source: 'DOM', kind: 'available' };
    const busy = { status: 2, source: 'Meeting', kind: 'meeting' };

    machine.request(available, 0);
    machine.request(busy, 100);
    assert.equal(machine.current.status, 1);
    assert.equal(machine.flush(599).status, 1);
    assert.equal(machine.flush(600).status, 2);
    assert.equal(transitions.length, 2);
  });
});

describe('provider health and Graph fallback', () => {
  it('backs off after errors and exposes only a bounded diagnostic code', () => {
    const provider = new PresenceProvider('graph');
    provider.recordError({ status: 403, message: 'token and account details must not escape' }, 1000);
    const snapshot = provider.snapshot(1001);

    assert.equal(provider.canAttempt(1001), false);
    assert.equal(snapshot.lastError, '403');
    assert.equal(snapshot.failureCount, 1);
    assert.equal(snapshot.retryAt, 6000);
  });

  it('falls back to DOM when Graph fails, then adopts Graph after recovery', () => {
    const aggregator = new PresenceAggregator({ debounceMs: 0, providerTtlMs: 60_000 });
    aggregator.update('dom', { status: 1, source: 'Teams DOM', kind: 'available' }, 100);
    aggregator.recordError('graph', { status: 403 }, 200);
    assert.equal(aggregator.getCurrent().source, 'Teams DOM');

    aggregator.update('graph', { status: 2, source: 'Microsoft Graph', kind: 'graph' }, 6000);
    assert.equal(aggregator.getCurrent().source, 'Microsoft Graph');
    assert.equal(aggregator.getDiagnostics().providers.find((p) => p.name === 'graph').lastError, null);
  });

  it('expires stale providers without throwing', () => {
    const aggregator = new PresenceAggregator({ debounceMs: 0, providerTtlMs: 100 });
    aggregator.update('dom', { status: 1, source: 'Teams DOM' }, 100);
    assert.equal(aggregator.getDiagnostics(199).activeProviders.length, 1);
    assert.equal(aggregator.getDiagnostics(201).activeProviders.length, 0);
  });
});
