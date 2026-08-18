/**
 * MQTT Status Monitor — hybrid DOM + opt-in Graph poll
 *
 * Monitors Teams user status and sends updates to the main process via IPC
 * for MQTT publishing and the tray/dock presence dot. Two complementary layers:
 *
 * DOM (always on, real-time) — primary source, same strategy as before:
 * 1. CSS selectors targeting known Teams presence elements
 * 2. Me-control avatar button with presence badge
 * 3. Page title (unlikely fallback)
 * Uses MutationObserver (debounced) + periodic poll as fallback.
 *
 * Graph (opt-in correction, behind presence.graphPoll.enabled + graphApi.enabled)
 * — when the tenant has granted Presence.Read and the wrapper can acquire a
 * Graph token, /me/presence is polled at the configured interval and fed
 * through the same forwarding path. A 403/empty/unknown payload is silently
 * ignored so DOM stays authoritative when Graph isn't consented.
 *
 * IMPORTANT: DOM detection is inherently fragile — see graph-api-integration-research.md.
 * Graph off-state is byte-identical to pre-hybrid (no network traffic).
 *
 * Status Codes:
 * 1 = Available, 2 = Busy, 3 = Do Not Disturb, 4 = Away, 5 = Be Right Back
 */

const { PresenceAggregator } = require('../../presence/sync');

class MQTTStatusMonitor {
	init(config, ipcRenderer) {
		this.config = config;
		this.ipcRenderer = ipcRenderer;
		this.lastStatus = null;
		this.observer = null;
		this.pollInterval = null;
		this.debounceTimer = null;
		this._loggedDetection = false;
		this._graphPollInterval = null;
		this._graphBackoffUntil = 0;
		this._calendarPollInterval = null;
		this._calendarStartTimeout = null;
		this._presenceActivityHandles = [];
		this._presenceDomHandlers = [];
		this.presenceAggregator = null;
		this.lastSource = null;

		// Status keyword mapping for efficient lookup
		this.statusKeywords = [
			{ keywords: ['do not disturb', 'dnd', 'do-not-disturb', 'focus', 'presence-dnd', 'status-dnd'], code: 3 },
			{ keywords: ['be right back', 'brb', 'berightback', 'presence-berightback', 'status-brb'], code: 5 },
			{ keywords: ['busy', 'in a call', 'in a meeting', 'red', 'presence-busy', 'status-busy'], code: 2 },
			{ keywords: ['away', 'inactive', 'yellow', 'presence-away', 'status-away'], code: 4 },
			{ keywords: ['available', 'online', 'green', 'presence-available', 'status-available'], code: 1 }
		];

		// Start when any surface needs presence: MQTT, dock overlay, or tray dot.
		const dockWants = config.media?.showStatusOnDockIcon && process.platform === 'darwin';
		const trayWants = config.media?.showStatusOnTrayIcon && process.platform !== 'darwin';
		const syncWants = config.presence?.sync?.enabled === true;
		if (!config.mqtt?.enabled && !dockWants && !trayWants && !syncWants) {
			console.debug('Status monitoring disabled');
			return;
		}

		console.debug('Initializing MQTT status monitor');
		if (syncWants) this.initializePresenceSync();
		this.start();
	}

	start() {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => this.startMonitoring());
		} else {
			// Give Teams time to fully load
			setTimeout(() => this.startMonitoring(), 3000);
		}
	}

	startMonitoring() {
		console.debug('Starting Teams status monitoring for MQTT');

		this.setupMutationObserver();
		this.startPolling();
		this.startGraphPolling();
		this.startCalendarPolling();
		this.checkStatusChange();
	}

	/**
	 * Set up MutationObserver to watch for DOM changes
	 * Uses debouncing to avoid excessive checks on rapid DOM changes
	 */
	setupMutationObserver() {
		this.observer = new MutationObserver(() => {
			// Debounce: only check status after DOM settles (300ms of no changes)
			if (this.debounceTimer) {
				clearTimeout(this.debounceTimer);
			}
			this.debounceTimer = setTimeout(() => {
				this.checkStatusChange();
			}, 300);
		});

		// Observe the entire body for changes to status-related attributes
		this.observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['class', 'aria-label', 'title', 'data-testid']
		});

		console.debug('Mutation observer set up for status monitoring (with 300ms debounce)');
	}

	startPolling() {
		const interval = this.config.mqtt?.statusCheckInterval || 10000;

		this.pollInterval = setInterval(() => {
			this.checkStatusChange();
		}, interval);

		console.debug(`Status polling started with ${interval}ms interval`);
	}

	/**
	 * Forward a resolved status through both the main-process MQTT publish
	 * and the local DOM event that dock/tray renderers listen to. Dedup is
		 * caller-owned (checkStatusChange keeps #lastStatus; Graph poll
		 * delegates to the same guard by feeding through the same path).
		 */
	forwardStatus(status, source = 'dom', kind = null) {
		if (status === null || (status === this.lastStatus && source === this.lastSource)) return;
		const statusChanged = status !== this.lastStatus;
		console.debug(`Teams status changed (${source}): ${this.lastStatus} -> ${status}`);
		this.lastStatus = status;
		this.lastSource = source;
		if (statusChanged && this.config.mqtt?.enabled) {
			this.ipcRenderer.invoke('user-status-changed', {
				data: { status: status }
			});
		}
		globalThis.dispatchEvent(new CustomEvent('user-status-changed-local', {
			detail: { status: status, source: source, kind: kind || source }
		}));
	}

	checkStatusChange() {
		try {
			const status = this.detectCurrentStatus();
			if (status !== null) {
				this.updatePresence('dom', { status, source: 'Teams DOM', kind: 'dom' });
			}
		} catch (error) {
			console.debug('Status check error:', error.message);
		}
	}

	// ── Graph hybrid ────────────────────────────────────────────────────
	static #GRAPH_STATUS_MAP = {
		dnd: 3,
		presenting: 3,
		urgentinterruptionsonly: 3,
		busy: 2,
		inacall: 2,
		inameeting: 2,
		beRightBack: 5,
		berightback: 5,
		away: 4,
		offline: 4,
		available: 1,
	};

	mapGraphPresenceToStatus(data) {
		if (!data || typeof data !== 'object') return null;
		const avail = (data.availability || '').toLowerCase().replaceAll(/[^a-z]/g, '');
		const act = (data.activity || '').toLowerCase().replaceAll(/[^a-z]/g, '');
		// activity is more specific (e.g. "InACall" vs availability "Busy") so prefer it
		for (const key of [act, avail]) {
			if (!key) continue;
			const mapped = MQTTStatusMonitor.#GRAPH_STATUS_MAP[key];
			if (mapped) return mapped;
		}
		return null;
	}

	startGraphPolling() {
		const enabled = this.config.presence?.graphPoll?.enabled && this.config.graphApi?.enabled;
		if (!enabled) return;
		const intervalMs = Number(this.config.presence.graphPoll.intervalMs) || 60000;
		const clamped = Math.max(15000, Math.min(intervalMs, 10 * 60 * 1000));
		// Delay first poll so DOM has a chance to establish presence before Graph corrects it
		setTimeout(() => this.pollGraphPresence(), 8000);
		this._graphPollInterval = setInterval(() => this.pollGraphPresence(), clamped);
		console.debug('[Presence] Graph hybrid poll enabled', { intervalMs: clamped });
	}

	async pollGraphPresence() {
		if (Date.now() < this._graphBackoffUntil) return;
		try {
			const res = await this.ipcRenderer.invoke('graph-api-get-presence');
			if (!res) return;
			if (res.success === false) {
				if (res.status === 403) {
					this._graphBackoffUntil = Date.now() + 5 * 60 * 1000;
					console.debug('[Presence] Graph presence 403 — backing off 5m (DOM remains primary)');
				}
				this.presenceAggregator?.recordError('graph', { status: res.status });
				this.sendPresenceDiagnostics();
				return;
			}
			const status = this.mapGraphPresenceToStatus(res.data);
			if (status !== null) {
				this.updatePresence('graph', { status, source: 'Microsoft Graph', kind: 'graph' });
			}
		} catch (error) {
			this.presenceAggregator?.recordError('graph', { code: 'request-failed' });
			this.sendPresenceDiagnostics();
			console.debug('[Presence] Graph poll failed', { message: error.message });
		}
	}

	initializePresenceSync() {
		if (this.presenceAggregator) return;
		const syncConfig = this.config.presence?.sync || {};
		this.presenceAggregator = new PresenceAggregator({
			debounceMs: Math.max(0, Math.min(Number(syncConfig.debounceMs) || 400, 10000)),
			providerTtlMs: Math.max(15000, Math.min(Number(syncConfig.providerTtlMs) || 120000, 10 * 60 * 1000)),
			onChange: (state) => {
				if (state) this.forwardStatus(state.status, state.source, state.kind);
				this.sendPresenceDiagnostics();
			},
		});
		for (const provider of ['explicit', 'dom', 'graph', 'calendar', 'meeting', 'presenting']) {
			this.presenceAggregator.registerProvider(provider);
		}

		try {
			const activityHub = require('./activityHub');
			const register = (event, handler) => {
				const handle = activityHub.on(event, handler);
				if (handle) this._presenceActivityHandles.push({ event, handle });
			};
			register('meeting-started', () => this.updatePresence('meeting', {
				status: 2,
				source: 'Meeting',
				kind: 'meeting',
			}));
			register('call-connected', () => this.updatePresence('meeting', {
				status: 2,
				source: 'Meeting',
				kind: 'meeting',
			}));
			register('call-disconnected', () => this.clearPresence('meeting'));
		} catch {
			// ActivityHub is optional during early page boot; DOM/Graph still work.
		}

		if (typeof globalThis.addEventListener === 'function') {
			const screenSharingStarted = () => this.updatePresence('presenting', {
				status: 2,
				source: 'Presenting',
				kind: 'presenting',
			});
			const screenSharingStopped = () => this.clearPresence('presenting');
			const explicitStatusChanged = (event) => {
				const status = event?.detail?.status;
				if (status === null || status === undefined) return;
				this.updatePresence('explicit', {
					status,
					source: 'Explicit user status',
					kind: 'explicit',
				});
			};
			globalThis.addEventListener('tfl-screen-sharing-started', screenSharingStarted);
			globalThis.addEventListener('tfl-screen-sharing-stopped', screenSharingStopped);
			globalThis.addEventListener('teams-explicit-status-changed', explicitStatusChanged);
			this._presenceDomHandlers = [
				['tfl-screen-sharing-started', screenSharingStarted],
				['tfl-screen-sharing-stopped', screenSharingStopped],
				['teams-explicit-status-changed', explicitStatusChanged],
			];
		}
		this.sendPresenceDiagnostics();
	}

	updatePresence(provider, candidate) {
		if (!this.presenceAggregator) {
			if (candidate?.status !== undefined) {
				this.forwardStatus(candidate.status, candidate.source || provider, candidate.kind || provider);
			}
			return;
		}
		this.presenceAggregator.update(provider, candidate);
		this.sendPresenceDiagnostics();
	}

	clearPresence(provider) {
		if (this.presenceAggregator) {
			this.presenceAggregator.clear(provider);
			this.sendPresenceDiagnostics();
		}
	}

	sendPresenceDiagnostics() {
		if (!this.presenceAggregator || !this.ipcRenderer) return;
		try {
			this.ipcRenderer.send('presence-sync-update', {
				enabled: true,
				...this.presenceAggregator.getDiagnostics(),
			});
		} catch {
			// Diagnostics must never interfere with status monitoring.
		}
	}

	startCalendarPolling() {
		const calendar = this.config.presence?.sync?.calendar;
		if (!this.presenceAggregator || !calendar?.enabled || !this.config.graphApi?.enabled) return;
		if (this._calendarPollInterval || this._calendarStartTimeout) return;
		const intervalMs = Math.max(15000, Math.min(Number(calendar.pollIntervalMs) || 60000, 10 * 60 * 1000));
		this._calendarStartTimeout = setTimeout(() => {
			this._calendarStartTimeout = null;
			this.pollCalendarPresence();
		}, 8000);
		this._calendarPollInterval = setInterval(() => this.pollCalendarPresence(), intervalMs);
	}

	async pollCalendarPresence() {
		if (!this.presenceAggregator || !this.config.presence?.sync?.calendar?.enabled) return;
		const now = Date.now();
		const reminderMinutes = Math.max(0, Math.min(Number(this.config.presence.sync.calendar.reminderMinutes) || 5, 60));
		try {
			const start = new Date(now - 60 * 1000).toISOString();
			const end = new Date(now + Math.max(reminderMinutes, 1) * 60 * 1000).toISOString();
			const result = await this.ipcRenderer.invoke('graph-api-get-calendar-view', start, end, {
				top: 20,
				select: 'start,end,isCancelled,showAs',
			});
			if (!result?.success) {
				this.presenceAggregator.recordError('calendar', { status: result?.status, code: 'calendar-unavailable' });
				this.sendPresenceDiagnostics();
				return;
			}
			const events = Array.isArray(result.data?.value) ? result.data.value : [];
			let activeEvent = false;
			let upcomingEvent = false;
			for (const event of events) {
				if (event?.isCancelled || String(event?.showAs || '').toLowerCase() === 'free') continue;
				const eventStart = Date.parse(event?.start?.dateTime || '');
				const eventEnd = Date.parse(event?.end?.dateTime || '');
				if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd)) continue;
				if (eventStart <= now && now < eventEnd) {
					activeEvent = true;
					break;
				}
				if (this.config.presence.sync.calendar.preBusy && eventStart > now && eventStart - now <= reminderMinutes * 60 * 1000) {
					upcomingEvent = true;
				}
			}
			if (activeEvent || upcomingEvent) {
				this.updatePresence('calendar', { status: 2, source: 'Calendar', kind: 'calendar' });
			} else {
				this.clearPresence('calendar');
			}
		} catch {
			this.presenceAggregator.recordError('calendar', { code: 'request-failed' });
			this.sendPresenceDiagnostics();
		}
	}

	updateConfig(config) {
		const wasEnabled = Boolean(this.presenceAggregator);
		const isEnabled = config?.presence?.sync?.enabled === true;
		this.config = config;
		if (isEnabled && !wasEnabled) {
			this.initializePresenceSync();
			if (!this.observer && !this.pollInterval) this.start();
		} else if (!isEnabled && wasEnabled) {
			this.destroyPresenceSync();
		}
		if (isEnabled && this.observer) this.startCalendarPolling();
	}

	destroyPresenceSync() {
		try {
			const activityHub = require('./activityHub');
			for (const { event, handle } of this._presenceActivityHandles) activityHub.off(event, handle);
		} catch {
			// ActivityHub may not have loaded yet.
		}
		this._presenceActivityHandles = [];
		if (typeof globalThis.removeEventListener === 'function') {
			for (const [event, handler] of this._presenceDomHandlers) globalThis.removeEventListener(event, handler);
		}
		this._presenceDomHandlers = [];
		if (this._calendarStartTimeout) clearTimeout(this._calendarStartTimeout);
		if (this._calendarPollInterval) clearInterval(this._calendarPollInterval);
		this._calendarStartTimeout = null;
		this._calendarPollInterval = null;
		this.presenceAggregator?.dispose();
		this.presenceAggregator = null;
	}

	/**
	 * Detect current Teams status from UI
	 * Uses multiple DOM strategies — all inherently fragile (see file header)
	 *
	 * @returns {number|null} Status code (1-5) or null if not detected
	 */
	detectCurrentStatus() {
		// Strategy 1: Try CSS selectors for direct presence indicators
		let status = this.detectStatusFromSelectors();
		if (status !== null) {
			if (!this._loggedDetection) console.info('[MQTT Status] Detected via CSS selectors:', status);
			this._loggedDetection = true;
			return status;
		}

		// Strategy 2: Check me-control avatar button for presence indicator
		status = this.detectStatusFromMeControl();
		if (status !== null) {
			if (!this._loggedDetection) console.info('[MQTT Status] Detected via me-control:', status);
			this._loggedDetection = true;
			return status;
		}

		// Strategy 3: Check page title (unlikely but kept for compatibility)
		status = this.extractStatusFromPageTitle();
		if (status !== null) {
			if (!this._loggedDetection) console.info('[MQTT Status] Detected via page title:', status);
			this._loggedDetection = true;
			return status;
		}

		return null;
	}

	/**
	 * Detect status from CSS selectors
	 * Note: CSS attribute selectors are case-sensitive by default, so we use
	 * the 'i' flag for aria-label/title/class matching to handle different
	 * locales and varying capitalisation in Teams' DOM.
	 * @returns {number|null} Status code or null if not detected
	 */
	detectStatusFromSelectors() {
		const selectors = [
			// Current primary selector for the Teams presence badge
			'[data-tid="me-control-avatar-presence"]',
			// Older Teams v2 selectors (kept for compatibility)
			'[data-tid="me-control-presence-icon"]',
			'[data-tid="presence-indicator"]',
			'[data-testid="presence-status"]',
			'[data-tid="my-status-button"]',
			// Class-based selectors (case-insensitive to match e.g. fui-PresenceBadge)
			'button[class*="presence" i]',
			'div[class*="presence" i]',
			'.fui-PresenceBadge',
			// Broad wildcard selectors (case-insensitive for locale support)
			'[aria-label*="status" i]',
			'[title*="status" i]'
		];

		return this._findStatusFromElements(selectors);
	}

	_findStatusFromElements(selectors) {
		for (const selector of selectors) {
			const element = document.querySelector(selector);
			if (element) {
				const status = this.extractStatusFromElement(element);
				if (status !== null) {
					return status;
				}
			}
		}
		return null;
	}

	detectStatusFromMeControl() {
		// Try both current and older data-tid values
		const meControl = document.querySelector('[data-tid="me-control-avatar-trigger"]') ||
						  document.querySelector('[data-tid="me-control-button"]');
		if (!meControl) {
			return null;
		}

		// Look for presence indicator within the me-control (case-insensitive)
		const presenceIndicator = meControl.querySelector('[class*="presence" i]') ||
								  meControl.querySelector('[data-tid*="presence"]');
		if (presenceIndicator) {
			const status = this.extractStatusFromElement(presenceIndicator);
			if (status !== null) {
				return status;
			}
		}

		// Check the me-control button itself for aria-label with status
		const meControlAriaLabel = meControl.getAttribute('aria-label') || '';
		if (meControlAriaLabel) {
			const status = this.mapTextToStatusCode(meControlAriaLabel);
			if (status !== null) {
				return status;
			}
		}

		return null;
	}

	extractStatusFromElement(element) {
		const classList = element.classList.toString();
		const ariaLabel = element.getAttribute('aria-label') || '';
		const title = element.getAttribute('title') || '';
		const textContent = element.textContent || '';
		const dataTestId = element.dataset?.testid || '';
		const dataTid = element.dataset?.tid || '';
		
		// Also check for SVG fill colors or specific presence class patterns
		const style = element.getAttribute('style') || '';
		const fill = element.getAttribute('fill') || '';
		
		// Check child elements for presence indicators (often nested SVGs or spans)
		let childPresenceInfo = '';
		const presenceChild = element.querySelector('[class*="presence"], [data-tid*="presence"]');
		if (presenceChild) {
			childPresenceInfo = presenceChild.classList.toString() + ' ' + 
							   (presenceChild.getAttribute('aria-label') || '');
		}

		return this.mapTextToStatusCode(classList, ariaLabel, title, textContent, dataTestId, dataTid, style, fill, childPresenceInfo);
	}

	extractStatusFromPageTitle() {
		return this.mapTextToStatusCode(document.title);
	}

	/**
	 * Map UI text/attributes to status code using keyword lookup
	 * Checks keywords in priority order (most specific first)
	 */
	mapTextToStatusCode(...textSources) {
		const combinedText = textSources.join(' ').toLowerCase();

		for (const statusGroup of this.statusKeywords) {
			for (const keyword of statusGroup.keywords) {
				if (combinedText.includes(keyword)) {
					return statusGroup.code;
				}
			}
		}

		return null;
	}

	stop() {
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}

		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}

		if (this._graphPollInterval) {
			clearInterval(this._graphPollInterval);
			this._graphPollInterval = null;
		}

		this.destroyPresenceSync();

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		console.debug('MQTT status monitoring stopped');
	}
}

module.exports = new MQTTStatusMonitor();
