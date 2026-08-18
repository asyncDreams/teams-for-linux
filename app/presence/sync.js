'use strict';

const PRESENCE_STATUS = Object.freeze({
  AVAILABLE: 1,
  BUSY: 2,
  DO_NOT_DISTURB: 3,
  AWAY: 4,
  BE_RIGHT_BACK: 5,
});

const PRESENCE_LABELS = Object.freeze({
  1: 'Available',
  2: 'Busy',
  3: 'Do not disturb',
  4: 'Away',
  5: 'Be right back',
});

const DEFAULT_PROVIDER_TTL_MS = 2 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 400;
const MAX_SOURCE_LENGTH = 64;
const MAX_ERROR_CODE_LENGTH = 64;

const PRESENCE_PRIORITIES = Object.freeze({
  explicit: 100,
  dnd: 90,
  busy: 80,
  meeting: 70,
  calendar: 65,
  presenting: 60,
  available: 50,
  dom: 40,
  graph: 35,
  away: 10,
  brb: 10,
  unknown: 0,
});

const STATUS_BY_NAME = Object.freeze({
  available: PRESENCE_STATUS.AVAILABLE,
  online: PRESENCE_STATUS.AVAILABLE,
  busy: PRESENCE_STATUS.BUSY,
  dnd: PRESENCE_STATUS.DO_NOT_DISTURB,
  'do-not-disturb': PRESENCE_STATUS.DO_NOT_DISTURB,
  donotdisturb: PRESENCE_STATUS.DO_NOT_DISTURB,
  away: PRESENCE_STATUS.AWAY,
  offline: PRESENCE_STATUS.AWAY,
  brb: PRESENCE_STATUS.BE_RIGHT_BACK,
  'be-right-back': PRESENCE_STATUS.BE_RIGHT_BACK,
  berightback: PRESENCE_STATUS.BE_RIGHT_BACK,
});

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function cap(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeStatus(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return Object.hasOwn(PRESENCE_LABELS, value) ? value : null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase().replaceAll(/\s+/g, '-');
    return STATUS_BY_NAME[normalized] || null;
  }
  return null;
}

function inferKind(status, providerName, requestedKind) {
  if (typeof requestedKind === 'string' && Object.hasOwn(PRESENCE_PRIORITIES, requestedKind)) {
    return requestedKind;
  }
  if (providerName === 'explicit') return 'explicit';
  if (status === PRESENCE_STATUS.DO_NOT_DISTURB) return 'dnd';
  if (status === PRESENCE_STATUS.BUSY) return providerName === 'meeting' ? 'meeting' : 'busy';
  if (status === PRESENCE_STATUS.AWAY || status === PRESENCE_STATUS.BE_RIGHT_BACK) return 'away';
  return providerName === 'graph' ? 'graph' : 'available';
}

function priorityFor(kind, status) {
  if (kind === 'dom' && status === PRESENCE_STATUS.DO_NOT_DISTURB) return PRESENCE_PRIORITIES.dnd;
  if (kind === 'dom' && status === PRESENCE_STATUS.BUSY) return PRESENCE_PRIORITIES.busy;
  if (kind === 'graph' && status === PRESENCE_STATUS.DO_NOT_DISTURB) return PRESENCE_PRIORITIES.dnd;
  if (kind === 'graph' && status === PRESENCE_STATUS.BUSY) return PRESENCE_PRIORITIES.busy;
  return PRESENCE_PRIORITIES[kind] ?? PRESENCE_PRIORITIES.unknown;
}

/**
 * Normalize a provider update into a small, renderer-safe candidate record.
 * Providers may supply a friendly source label, but the aggregator never
 * depends on free-form text to resolve precedence.
 */
function normalizeCandidate(candidate, providerName, now = Date.now()) {
  if (!candidate || typeof candidate !== 'object' || candidate.active === false) return null;
  const status = normalizeStatus(candidate.status);
  if (status === null) return null;
  const kind = inferKind(status, providerName, candidate.kind);
  const updatedAt = Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : now;
  return {
    status,
    label: PRESENCE_LABELS[status],
    source: cap(candidate.source, MAX_SOURCE_LENGTH) || providerName,
    kind,
    priority: Number.isFinite(candidate.priority) ? candidate.priority : priorityFor(kind, status),
    provider: providerName,
    updatedAt,
  };
}

function compareCandidates(left, right) {
  if (!right) return 1;
  if (!left) return -1;
  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.updatedAt - right.updatedAt;
}

function chooseBestPresence(candidates) {
  return candidates.reduce((best, candidate) => (
    compareCandidates(candidate, best) > 0 ? candidate : best
  ), null);
}

class PresenceProvider {
  constructor(name, { ttlMs = DEFAULT_PROVIDER_TTL_MS } = {}) {
    this.name = name;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
    this.state = null;
    this.lastSyncAt = null;
    this.lastError = null;
    this.failureCount = 0;
    this.retryAt = 0;
  }

  canAttempt(now = Date.now()) {
    return now >= this.retryAt;
  }

  update(candidate, now = Date.now()) {
    this.state = normalizeCandidate(candidate, this.name, now);
    this.lastSyncAt = now;
    this.lastError = null;
    this.failureCount = 0;
    this.retryAt = 0;
    return this.state;
  }

  clear(now = Date.now()) {
    this.state = null;
    this.lastSyncAt = now;
    return null;
  }

  recordError(error, now = Date.now(), { baseBackoffMs = 5000, maxBackoffMs = 5 * 60 * 1000 } = {}) {
    this.failureCount += 1;
    const status = Number.isInteger(error?.status) ? String(error.status) : '';
    const code = cap(error?.code, MAX_ERROR_CODE_LENGTH) || status || 'provider-error';
    this.lastError = code;
    this.lastSyncAt = now;
    this.retryAt = now + Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.min(this.failureCount - 1, 6)));
    return this.snapshot(now);
  }

  snapshot(now = Date.now()) {
    const stateAge = this.state ? Math.max(0, now - this.state.updatedAt) : null;
    const active = Boolean(this.state && (this.ttlMs === 0 || stateAge <= this.ttlMs));
    return {
      name: this.name,
      active,
      status: active ? this.state.status : null,
      label: active ? this.state.label : null,
      source: active ? this.state.source : null,
      kind: active ? this.state.kind : null,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      failureCount: this.failureCount,
      retryAt: this.retryAt || null,
    };
  }
}

class PresenceStateMachine {
  constructor({ debounceMs = DEFAULT_DEBOUNCE_MS, onTransition = null } = {}) {
    this.debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : DEFAULT_DEBOUNCE_MS;
    this.onTransition = typeof onTransition === 'function' ? onTransition : null;
    this.current = null;
    this.pending = null;
    this.pendingAt = null;
    this.lastTransitionAt = null;
  }

  request(next, now = Date.now()) {
    if (sameState(this.current, next)) {
      this.pending = null;
      this.pendingAt = null;
      return this.current;
    }
    if (!this.current || this.debounceMs === 0) {
      return this.#commit(next, now);
    }
    this.pending = clone(next);
    this.pendingAt = now;
    return this.current;
  }

  flush(now = Date.now()) {
    if (!this.pending || this.pendingAt === null) return this.current;
    if (now - this.pendingAt < this.debounceMs) return this.current;
    return this.#commit(this.pending, now);
  }

  getPending() {
    return clone(this.pending);
  }

  #commit(next, now) {
    this.current = clone(next);
    this.pending = null;
    this.pendingAt = null;
    this.lastTransitionAt = now;
    if (this.onTransition) this.onTransition(clone(this.current));
    return this.current;
  }
}

function sameState(left, right) {
  if (!left || !right) return left === right;
  return left.status === right.status
    && left.source === right.source
    && left.kind === right.kind
    && left.provider === right.provider;
}

class PresenceAggregator {
  constructor({
    debounceMs = DEFAULT_DEBOUNCE_MS,
    providerTtlMs = DEFAULT_PROVIDER_TTL_MS,
    onChange = null,
    now = () => Date.now(),
  } = {}) {
    this.now = now;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.providers = new Map();
    this.providerTtlMs = providerTtlMs;
    this.flushTimer = null;
    this.stateMachine = new PresenceStateMachine({
      debounceMs,
      onTransition: (state) => this.onChange?.(state),
    });
  }

  registerProvider(name, options = {}) {
    if (!this.providers.has(name)) {
      this.providers.set(name, new PresenceProvider(name, {
        ttlMs: options.ttlMs ?? this.providerTtlMs,
      }));
    }
    return this.providers.get(name);
  }

  update(providerName, candidate, now = this.now()) {
    const provider = this.registerProvider(providerName);
    if (candidate === null || candidate?.active === false) provider.clear(now);
    else provider.update(candidate, now);
    return this.#reconcile(now);
  }

  recordError(providerName, error, now = this.now(), options = {}) {
    const provider = this.registerProvider(providerName);
    provider.recordError(error, now, options);
    return this.getDiagnostics(now);
  }

  clear(providerName, now = this.now()) {
    this.registerProvider(providerName).clear(now);
    return this.#reconcile(now);
  }

  flush(now = this.now()) {
    const state = this.stateMachine.flush(now);
    if (!this.stateMachine.getPending()) this.#clearFlushTimer();
    return state;
  }

  getCurrent() {
    return clone(this.stateMachine.current);
  }

  dispose() {
    this.#clearFlushTimer();
    this.stateMachine.pending = null;
    this.stateMachine.pendingAt = null;
  }

  getDiagnostics(now = this.now()) {
    const providerSnapshots = [...this.providers.values()].map((provider) => provider.snapshot(now));
    const activeProviders = providerSnapshots.filter((provider) => provider.active).map((provider) => provider.name);
    const lastSyncAt = providerSnapshots.reduce((latest, provider) => (
      provider.lastSyncAt && (!latest || provider.lastSyncAt > latest) ? provider.lastSyncAt : latest
    ), null);
    return {
      current: this.getCurrent(),
      pending: this.stateMachine.getPending(),
      activeProviders,
      lastSyncAt,
      providers: providerSnapshots,
      lastTransitionAt: this.stateMachine.lastTransitionAt,
    };
  }

  #reconcile(now) {
    const candidates = [...this.providers.values()]
      .filter((provider) => provider.snapshot(now).active)
      .map((provider) => provider.state)
      .filter(Boolean);
    const best = chooseBestPresence(candidates);
    const next = best ? {
      status: best.status,
      label: best.label,
      source: best.source,
      kind: best.kind,
      provider: best.provider,
      updatedAt: best.updatedAt,
    } : null;
    const current = this.stateMachine.request(next, now);
    if (this.stateMachine.getPending() && !this.flushTimer) {
      const delay = Math.max(0, this.stateMachine.pendingAt + this.stateMachine.debounceMs - now);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush(this.now());
      }, delay);
    }
    return current;
  }

  #clearFlushTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

module.exports = {
  PRESENCE_STATUS,
  PRESENCE_LABELS,
  PRESENCE_PRIORITIES,
  DEFAULT_PROVIDER_TTL_MS,
  DEFAULT_DEBOUNCE_MS,
  normalizeStatus,
  normalizeCandidate,
  chooseBestPresence,
  PresenceProvider,
  PresenceAggregator,
  PresenceStateMachine,
};
