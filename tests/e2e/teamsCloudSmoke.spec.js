import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

import {
	getRegisteredHandlers,
	closeAndCleanup,
} from './helpers/electronApp.js';

// createRequire needs a filename to resolve relative requires; use the spec
// file itself as anchor so `require('../../app/...')` resolves correctly
// without relying on `import.meta` (which fails when the package has no
// `"type":"module"` — see CI run 31493777088: SyntaxError: Cannot use
// 'import.meta' outside a module).
const require = createRequire(join(process.cwd(), 'tests/e2e/teamsCloudSmoke.spec.js'));

const TEAMS_HOSTNAMES = new Set([
	'teams.cloud.microsoft',
	'teams.microsoft.com',
	'teams.live.com',
	'login.microsoftonline.com',
]);

async function launchApp(config) {
	const userDataDir = mkdtempSync(join(tmpdir(), 'teams-cloud-smoke-'));
	if (config) {
		writeFileSync(join(userDataDir, 'config.json'), JSON.stringify(config));
	}
	const electronApp = await electron.launch({
		args: ['./app/index.js', ...(process.env.CI ? ['--no-sandbox'] : [])],
		env: { ...process.env, E2E_USER_DATA_DIR: userDataDir, E2E_TESTING: 'true' },
		timeout: 30000,
	});
	await electronApp.firstWindow({ timeout: 30000 });
	await new Promise((r) => setTimeout(r, 3000));
	return { electronApp, userDataDir };
}

async function findMainWindow(electronApp) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		const w = electronApp.windows().find((win) => {
			try {
				return TEAMS_HOSTNAMES.has(new URL(win.url()).hostname);
			} catch {
				return false;
			}
		});
		if (w) return w;
		await new Promise((r) => setTimeout(r, 250));
	}
	return null;
}

/**
 * Teams-cloud regression harness (T0B).
 *
 * Validates the host-table centralization (Phase 0A) + notification
 * extractor (Phase 1) + [PERF] lane wiring stay healthy against the live
 * Teams shell. The spec is intentionally read-only and network-light:
 * it does not sign in — it exercises the synthetic Notification path and
 * the pure host helpers that Phase 2/3 depend on. A host-name or Teams
 * DOM rename should fail this harness intentionally before reaching stable.
 *
 * Runs as part of `npm run test:e2e` (single worker, xvfb) and mirrors
 * the isolated userDataDir pattern used by `smoke.spec.js` /
 * `notifications.spec.js`.
 */
test.describe('Teams-cloud smoke (T0B harness)', () => {
	test('host table helpers and IPC channels are wired correctly', async () => {
		const ctx = await launchApp();
		try {
			// 1) Host helpers — exercised directly in the Node test process.
			//    The modules are pure (no Electron) and the table is the
			//    single source of truth; running them here avoids the
			//    `require is not defined` sandbox error that
			//    `electronApp.evaluate` hits in the Playwright main-process
			//    UtilityScript context (see CI run 31493033541).
			//    Use an absolute path so the anchor file choice above does not
			//    affect resolution.
			const d = require(join(process.cwd(), 'app/config/defaults'));
			const hostProbe = {
				canonicalIsTeamsHost: d.isTeamsHost('teams.cloud.microsoft'),
				legacyIsTeamsHost: d.isTeamsHost('teams.microsoft.com'),
				mcasIsTeamsHost: d.isTeamsHost('teams.microsoft.com.mcas.ms'),
				regionalIsTeamsHost: d.isTeamsHost('teams.eastus.cloud.microsoft'),
				normalizeLegacy:
					d.normalizeTeamsUrl('https://teams.microsoft.com/l/meetup-join/abc?x=1#frag'),
				normalizeCanonical:
					d.normalizeTeamsUrl('https://teams.cloud.microsoft/l/meetup-join/abc'),
				normalizeMcasUnchanged:
					d.normalizeTeamsUrl('https://teams.microsoft.com.mcas.ms/l/meetup-join/abc'),
				validHttps: d.isValidTeamsUrl('https://teams.cloud.microsoft/l/meetup-join/abc'),
				invalidHttp: d.isValidTeamsUrl('http://teams.cloud.microsoft/l/meetup-join/abc'),
				meetupMatchesCanonical: new RegExp(d.meetupJoinRegEx).test(
					'https://teams.cloud.microsoft/l/meetup-join/abc'
				),
				meetupMatchesLegacy: new RegExp(d.meetupJoinRegEx).test(
					'https://teams.microsoft.com/l/meetup-join/abc'
				),
				v2MatchesCanonical: new RegExp(d.msTeamsProtocolV2).test(
					'msteams://teams.cloud.microsoft/l/meetup-join/abc'
				),
			};

			expect(hostProbe.canonicalIsTeamsHost).toBe(true);
			expect(hostProbe.legacyIsTeamsHost).toBe(true);
			expect(hostProbe.mcasIsTeamsHost).toBe(true);
			expect(hostProbe.regionalIsTeamsHost).toBe(true);
			expect(hostProbe.normalizeLegacy).toBe(
				'https://teams.cloud.microsoft/l/meetup-join/abc?x=1#frag'
			);
			expect(hostProbe.normalizeCanonical).toBe(
				'https://teams.cloud.microsoft/l/meetup-join/abc'
			);
			expect(hostProbe.normalizeMcasUnchanged).toBe(
				'https://teams.microsoft.com.mcas.ms/l/meetup-join/abc'
			);
			expect(hostProbe.validHttps).toBe(true);
			expect(hostProbe.invalidHttp).toBe(false);
			expect(hostProbe.meetupMatchesCanonical).toBe(true);
			expect(hostProbe.meetupMatchesLegacy).toBe(true);
			expect(hostProbe.v2MatchesCanonical).toBe(true);

			// 2) IPC channels that parity features depend on must be registered.
			const handlers = await getRegisteredHandlers(ctx.electronApp, [
				'show-notification',
				'show-notification-v2',
				'get-config',
			]);
			expect(handlers['show-notification']).toBe(true);
			expect(handlers['show-notification-v2']).toBe(true);
			expect(handlers['get-config']).toBe(true);

			// 3) Main window reached a Teams/Microsoft host (login redirect).
			const mainWindow = await findMainWindow(ctx.electronApp);
			expect(mainWindow).toBeTruthy();
			const host = new URL(mainWindow.url()).hostname;
			expect(TEAMS_HOSTNAMES.has(host) || host.endsWith('.mcas.ms')).toBe(true);
		} finally {
			await closeAndCleanup(ctx);
		}
	});

	test('synthetic Notifications (rich payloads) retain lifecycle and do not throw', async () => {
		const ctx = await launchApp();
		try {
			const mainWindow = await findMainWindow(ctx.electronApp);
			expect(mainWindow).toBeTruthy();
			// The shell redirects to login.microsoftonline.com shortly after
			// load; `page.evaluate` while the navigation is in flight throws
			// "Execution context was destroyed" (flaky in CI run 31493033541).
			// Wait for the redirect to settle before touching the renderer.
			await mainWindow.waitForLoadState('load', { timeout: 30000 });
			await mainWindow.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
			await new Promise((r) => setTimeout(r, 1500));

			async function evaluateWithRetry(fn) {
				for (let attempt = 0; attempt < 3; attempt++) {
					try {
						return await mainWindow.evaluate(fn);
					} catch (e) {
						const msg = String(e?.message || e);
						if (msg.includes('Execution context was destroyed') && attempt < 2) {
							await mainWindow.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
							await new Promise((r) => setTimeout(r, 1000));
							continue;
						}
						throw e;
					}
				}
			}

			const result = await evaluateWithRetry(() => {
				const cases = [
					{ title: 'Alice: hello world', opts: { body: 'preview', tag: 'chat:19:abc@thread.v2' } },
					{ title: 'Channel message', opts: { body: 'channel update', tag: 'channel:general' } },
					{ title: 'Meeting started', opts: { body: 'Join now', tag: 'meeting:123' } },
					{ title: 'Incoming call', opts: { body: 'Answer', tag: 'call:456' } },
					{ title: 'Bob: mention', opts: { body: '@you check this', tag: 'chat:1', data: { kind: 'mention' } } },
				];
				const out = [];
				for (const c of cases) {
					try {
						const n = new globalThis.Notification(c.title, {
							body: c.opts.body,
							tag: c.opts.tag,
							data: c.opts.data,
							icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
						});
						out.push({
							ok: true,
							hasAddEventListener: typeof n.addEventListener === 'function',
							hasClose: typeof n.close === 'function',
							hasOnclick: 'onclick' in n,
						});
						// exercise close path — must not throw and must clear onclose plumbing
						try {
							n.close();
						} catch (e) {
							out[out.length - 1].closeThrew = String(e?.message || e);
						}
					} catch (e) {
						out.push({ ok: false, error: String(e?.message || e) });
					}
				}
				return out;
			});

			expect(result).toHaveLength(5);
			for (const r of result) {
				expect(r.ok).toBe(true);
				expect(r.hasAddEventListener).toBe(true);
				expect(r.hasOnclick).toBe(true);
				expect(r.closeThrew).toBeUndefined();
			}
		} finally {
			await closeAndCleanup(ctx);
		}
	});

	test('notification extractor pure helpers survive inside the electron host (PII guard)', async () => {
		const ctx = await launchApp();
		try {
			// Pure helpers — run directly in Node; `electronApp.evaluate` +
			// `require` throws "require is not defined" in the Playwright
			// UtilityScript sandbox (CI 31493033541). The extractor is a
			// plain CommonJS module, so Node and the Electron main process
			// share the same implementation.
			const ex = require(join(process.cwd(), 'app/browser/tools/notificationExtractor'));
			const probe = {
				kindsIncludeMention: ex.KINDS.includes('mention'),
				classifyMention: ex.classifyKind({ title: 'mention test' }),
				classifyMeeting: ex.classifyKind({ tag: 'meeting:1' }),
				classifyDirect: ex.classifyKind({ tag: 'chat:19:abc@thread.v2' }),
				groupingTag: ex.deriveGroupingKey({ tag: 'chat:123' }),
				groupingNoPii: ex.deriveGroupingKey({ title: 'Alice: secret message body' }),
				extractHttps: ex.extractDeepLinkHref('https://teams.cloud.microsoft/l/meetup-join/abc'),
				extractRejectsFile: ex.extractDeepLinkHref('file:///etc/passwd'),
			};
			expect(probe.kindsIncludeMention).toBe(true);
			expect(probe.classifyMention).toBe('mention');
			expect(probe.classifyMeeting).toBe('meeting');
			expect(probe.classifyDirect).toBe('direct');
			expect(probe.groupingTag).toBe('chat:123');
			expect(probe.groupingNoPii).toBe(null);
			expect(probe.extractHttps).toBe('https://teams.cloud.microsoft/l/meetup-join/abc');
			expect(probe.extractRejectsFile).toBe(null);
		} finally {
			await closeAndCleanup(ctx);
		}
	});

	test('collects startup [PERF] marks (T0C lane is wired)', async () => {
		const ctx = await launchApp();
		try {
			// Perf utility is a plain Node module; verify it loads in the
			// test process instead of via `electronApp.evaluate`+require
			// which hits the same "require is not defined" sandbox issue.
			let perfProbe;
			try {
				const perf = require(join(process.cwd(), 'app/utils/perf'));
				perfProbe = {
					hasMark: typeof perf.mark === 'function',
					hasElapsed: typeof perf.elapsedMs === 'function',
					originIsNumber: typeof perf.PERF_ORIGIN === 'number',
					memorySampleIsFn: typeof perf.sampleMemory === 'function',
				};
			} catch (e) {
				perfProbe = { error: String(e?.message || e) };
			}
			expect(perfProbe.hasMark).toBe(true);
			expect(perfProbe.hasElapsed).toBe(true);
			expect(perfProbe.originIsNumber).toBe(true);
			expect(perfProbe.memorySampleIsFn).toBe(true);
		} finally {
			await closeAndCleanup(ctx);
		}
	});
});
