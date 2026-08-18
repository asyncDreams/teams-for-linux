/**
 * Unit tests for Teams host-table helpers (app/config/defaults.js)
 * Run with: node --test tests/unit/hosts.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  TEAMS_HOSTS,
  TEAMS_CANONICAL_HOST,
  MCAS_SUFFIX,
  stripMcasSuffix,
  isTeamsHost,
  isValidTeamsUrl,
  normalizeTeamsUrl,
  buildMeetupJoinRegEx,
  buildMsTeamsProtocolV2,
  AUTH_DOMAINS,
  AUTH_LOGIN_DOMAINS,
} = require('../../app/config/defaults');

describe('Teams host table', () => {
  it('canonical host is first in TEAMS_HOSTS', () => {
    assert.strictEqual(TEAMS_HOSTS[0], TEAMS_CANONICAL_HOST);
  });

  it('includes expected legacy hosts', () => {
    assert.ok(TEAMS_HOSTS.includes('teams.microsoft.com'));
    assert.ok(TEAMS_HOSTS.includes('teams.live.com'));
  });

  it('AUTH_DOMAINS includes all TEAMS_HOSTS', () => {
    for (const h of TEAMS_HOSTS) {
      assert.ok(AUTH_DOMAINS.includes(h), `AUTH_DOMAINS missing ${h}`);
    }
  });

  it('AUTH_LOGIN_DOMAINS is non-empty', () => {
    assert.ok(AUTH_LOGIN_DOMAINS.length > 0);
  });
});

describe('stripMcasSuffix', () => {
  it('strips .mcas.ms suffix', () => {
    assert.strictEqual(stripMcasSuffix('teams.microsoft.com.mcas.ms'), 'teams.microsoft.com');
  });

  it('leaves non-mcas host unchanged', () => {
    assert.strictEqual(stripMcasSuffix('teams.cloud.microsoft'), 'teams.cloud.microsoft');
  });

  it('handles empty / non-string gracefully', () => {
    assert.strictEqual(stripMcasSuffix(''), '');
    assert.strictEqual(stripMcasSuffix(null), null);
  });

  it('MCAS_SUFFIX constant is .mcas.ms', () => {
    assert.strictEqual(MCAS_SUFFIX, '.mcas.ms');
  });
});

describe('isTeamsHost', () => {
  it('accepts exact canonical host', () => {
    assert.strictEqual(isTeamsHost('teams.cloud.microsoft'), true);
  });

  it('accepts legacy hosts', () => {
    assert.strictEqual(isTeamsHost('teams.microsoft.com'), true);
    assert.strictEqual(isTeamsHost('teams.live.com'), true);
  });

  it('accepts mcas-wrapped legacy host', () => {
    assert.strictEqual(isTeamsHost('teams.microsoft.com.mcas.ms'), true);
  });

  it('accepts mcas-wrapped canonical host', () => {
    assert.strictEqual(isTeamsHost('teams.cloud.microsoft.mcas.ms'), true);
  });

  it('accepts subdomain of a known host', () => {
    assert.strictEqual(isTeamsHost('foo.teams.cloud.microsoft'), true);
    assert.strictEqual(isTeamsHost('deep.foo.teams.microsoft.com'), true);
  });

  it('accepts regional teams.<region>.cloud.microsoft', () => {
    assert.strictEqual(isTeamsHost('teams.eastus.cloud.microsoft'), true);
    assert.strictEqual(isTeamsHost('teams.westus2.cloud.microsoft'), true);
  });

  it('rejects bare cloud.microsoft without teams prefix', () => {
    assert.strictEqual(isTeamsHost('foo.cloud.microsoft'), false);
  });

  it('rejects non-teams hosts', () => {
    assert.strictEqual(isTeamsHost('example.com'), false);
    assert.strictEqual(isTeamsHost('teams.example.com'), false);
    assert.strictEqual(isTeamsHost('faketeams.cloud.microsoft'), false);
  });

  it('is case-insensitive', () => {
    assert.strictEqual(isTeamsHost('TEAMS.CLOUD.MICROSOFT'), true);
    assert.strictEqual(isTeamsHost('Teams.Microsoft.Com'), true);
  });

  it('rejects empty / null / non-string', () => {
    assert.strictEqual(isTeamsHost(''), false);
    assert.strictEqual(isTeamsHost(null), false);
    assert.strictEqual(isTeamsHost(undefined), false);
    assert.strictEqual(isTeamsHost(123), false);
  });

  it('does not treat mcas host without stripping as teams host by accident', () => {
    // ensure the suffix is stripped, not just substring-checked
    assert.strictEqual(isTeamsHost('evil.mcas.ms'), false);
  });
});

describe('isValidTeamsUrl', () => {
  it('accepts https Teams url', () => {
    assert.strictEqual(isValidTeamsUrl('https://teams.cloud.microsoft/l/meetup-join/abc'), true);
  });

  it('accepts legacy host https url', () => {
    assert.strictEqual(isValidTeamsUrl('https://teams.microsoft.com/l/meetup-join/abc'), true);
  });

  it('accepts mcas-wrapped https url', () => {
    assert.strictEqual(isValidTeamsUrl('https://teams.microsoft.com.mcas.ms/l/meetup-join/abc'), true);
  });

  it('rejects http scheme', () => {
    assert.strictEqual(isValidTeamsUrl('http://teams.cloud.microsoft/l/meetup-join/abc'), false);
  });

  it('rejects non-teams host', () => {
    assert.strictEqual(isValidTeamsUrl('https://example.com/'), false);
  });

  it('rejects non-string', () => {
    assert.strictEqual(isValidTeamsUrl(null), false);
    assert.strictEqual(isValidTeamsUrl(''), false);
  });

  it('rejects malformed url', () => {
    assert.strictEqual(isValidTeamsUrl('not a url'), false);
  });
});

describe('normalizeTeamsUrl', () => {
  it('normalizes legacy host to canonical', () => {
    const input = 'https://teams.microsoft.com/l/meetup-join/abc?x=1#frag';
    const out = normalizeTeamsUrl(input);
    const parsed = new URL(out);
    assert.strictEqual(parsed.hostname, TEAMS_CANONICAL_HOST);
    assert.strictEqual(parsed.pathname, '/l/meetup-join/abc');
    assert.strictEqual(parsed.search, '?x=1');
    assert.strictEqual(parsed.hash, '#frag');
  });

  it('normalizes teams.live.com to canonical', () => {
    const out = normalizeTeamsUrl('https://teams.live.com/meet/abc');
    assert.strictEqual(new URL(out).hostname, TEAMS_CANONICAL_HOST);
  });

  it('leaves canonical host unchanged', () => {
    const url = 'https://teams.cloud.microsoft/l/meetup-join/abc';
    assert.strictEqual(normalizeTeamsUrl(url), url);
  });

  it('leaves mcas-wrapped url unchanged', () => {
    const url = 'https://teams.microsoft.com.mcas.ms/l/meetup-join/abc';
    assert.strictEqual(normalizeTeamsUrl(url), url);
  });

  it('leaves non-teams url unchanged', () => {
    const url = 'https://example.com/foo';
    assert.strictEqual(normalizeTeamsUrl(url), url);
  });

  it('leaves non-string / malformed unchanged', () => {
    assert.strictEqual(normalizeTeamsUrl('not a url'), 'not a url');
    assert.strictEqual(normalizeTeamsUrl(''), '');
    assert.strictEqual(normalizeTeamsUrl(null), null);
  });

  it('normalizes subdomain of legacy host', () => {
    const out = normalizeTeamsUrl('https://foo.teams.microsoft.com/l/meetup-join/abc');
    assert.strictEqual(new URL(out).hostname, TEAMS_CANONICAL_HOST);
  });
});

describe('buildMeetupJoinRegEx / buildMsTeamsProtocolV2', () => {
  it('meetupJoinRegEx matches canonical and legacy hosts', () => {
    const re = new RegExp(buildMeetupJoinRegEx());
    assert.ok(re.test('https://teams.cloud.microsoft/l/meetup-join/abc'));
    assert.ok(re.test('https://teams.microsoft.com/l/meetup-join/abc'));
    assert.ok(re.test('https://teams.live.com/l/meetup-join/abc'));
  });

  it('meetupJoinRegEx rejects non-teams host', () => {
    const re = new RegExp(buildMeetupJoinRegEx());
    assert.strictEqual(re.test('https://teams.example.com/l/meetup-join/abc'), false);
  });

  it('msTeamsProtocolV2 matches canonical and legacy', () => {
    const re = new RegExp(buildMsTeamsProtocolV2());
    assert.ok(re.test('msteams://teams.cloud.microsoft/l/meetup-join/abc'));
    assert.ok(re.test('msteams://teams.microsoft.com/l/meetup-join/abc'));
  });

  it('msTeamsProtocolV2 rejects http', () => {
    const re = new RegExp(buildMsTeamsProtocolV2());
    assert.strictEqual(re.test('https://teams.cloud.microsoft/l/meetup-join/abc'), false);
  });

  it('both builders derive from TEAMS_HOSTS (no hard-coded literal check)', () => {
    const mj = buildMeetupJoinRegEx();
    const v2 = buildMsTeamsProtocolV2();
    for (const host of TEAMS_HOSTS) {
      const suffix = host.replace(/^teams\./, '').replace(/\./g, '\\.');
      assert.ok(mj.includes(suffix), `meetupJoinRegEx missing suffix for ${host}`);
      assert.ok(v2.includes(suffix), `msTeamsProtocolV2 missing suffix for ${host}`);
    }
  });
});
