'use strict';

const { performance } = require('node:perf_hooks');

// Origin captured at first require — as early as possible in the main process.
// Every mark is reported as `+Nms` since process start so `main.log` has a
// comparable timeline even when logger init shifts console.* binding.
const PERF_ORIGIN = performance.now();

function elapsedMs() {
	return Math.round(performance.now() - PERF_ORIGIN);
}

function mark(name) {
	try {
		console.info(`[PERF] ${name} +${elapsedMs()}ms`);
	} catch {
		// logger not yet bound — swallow; mark is best-effort
	}
}

function toMB(bytes) {
	return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function sampleMemory(context = '') {
	try {
		const mem = process.memoryUsage();
		const suffix = context ? ` ${context}` : '';
		console.info(`[PERF] memory${suffix}`, {
			rss_MB: toMB(mem.rss),
			heapUsed_MB: toMB(mem.heapUsed),
			heapTotal_MB: toMB(mem.heapTotal),
			external_MB: toMB(mem.external),
			arrayBuffers_MB: mem.arrayBuffers ? toMB(mem.arrayBuffers) : undefined,
			elapsed_ms: elapsedMs(),
		});
	} catch (error) {
		try {
			console.debug('[PERF] memory sample failed', { message: error.message });
		} catch {
			// ignore
		}
	}
}

let samplingTimer = null;

function startMemorySampling(intervalMs = 5 * 60 * 1000) {
	if (samplingTimer) return samplingTimer;
	try {
		console.info(`[PERF] memory sampling started interval=${intervalMs}ms`);
		sampleMemory('initial');
		samplingTimer = setInterval(() => sampleMemory('interval'), intervalMs);
		// Do not keep the process alive solely for sampling.
		if (samplingTimer.unref) samplingTimer.unref();
		return samplingTimer;
	} catch (error) {
		try {
			console.debug('[PERF] failed to start memory sampling', { message: error.message });
		} catch {
			// ignore
		}
		return null;
	}
}

function stopMemorySampling() {
	if (samplingTimer) {
		clearInterval(samplingTimer);
		samplingTimer = null;
		try {
			console.info(`[PERF] memory sampling stopped +${elapsedMs()}ms`);
		} catch {
			// ignore
		}
	}
}

module.exports = {
	PERF_ORIGIN,
	elapsedMs,
	mark,
	sampleMemory,
	startMemorySampling,
	stopMemorySampling,
	toMB,
};
