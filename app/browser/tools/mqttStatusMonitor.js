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
		if (!config.mqtt?.enabled && !dockWants && !trayWants) {
			console.debug('Status monitoring disabled');
			return;
		}

		console.debug('Initializing MQTT status monitor');
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
	forwardStatus(status, source = 'dom') {
		if (status === null || status === this.lastStatus) return;
		console.debug(`Teams status changed (${source}): ${this.lastStatus} -> ${status}`);
		this.lastStatus = status;
		if (this.config.mqtt?.enabled) {
			this.ipcRenderer.invoke('user-status-changed', {
				data: { status: status }
			});
		}
		globalThis.dispatchEvent(new CustomEvent('user-status-changed-local', {
			detail: { status: status }
		}));
	}

	checkStatusChange() {
		try {
			const status = this.detectCurrentStatus();
			if (status !== null) {
				this.forwardStatus(status, 'dom');
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
				return;
			}
			const status = this.mapGraphPresenceToStatus(res.data);
			if (status !== null) {
				this.forwardStatus(status, 'graph');
			}
		} catch (error) {
			console.debug('[Presence] Graph poll failed', { message: error.message });
		}
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

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		console.debug('MQTT status monitoring stopped');
	}
}

module.exports = new MQTTStatusMonitor();
