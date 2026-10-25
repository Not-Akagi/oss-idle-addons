// Character KPS v1.1.0 — oss!idle inline addon. SPDX-License-Identifier: MIT
// Paste this entire file into the add-on Code editor; save, then install/enable.
// Based on oss-idle/oss-idle ff99ec9 (game 1.1.0.0).
// Read-only, unofficial adapter: React fibers -> Gameplay's ManiaGame ref.
// Current: actual head presses in (songTime - 1000, songTime].
// Map peak: maximum head count in any such window across the whole chart.
// Chords count per key. Holds count only at the head, never at release.
// ManiaGame already divides note times by rate: DO NOT multiply KPS by rate.
// Alt+Shift+T: position sliders with a live preview and local persistence.
// No dependencies, network requests or gameplay writes.

const WINDOW_MS = 1000;
const UPDATE_MS = 50;
let cleanup = null;

function upperBound(times, time) {
	let lo = 0, hi = times.length;
	while (lo < hi) {
		const mid = lo + Math.floor((hi - lo) / 2);
		if (times[mid] <= time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function windowCount(times, now, cutoff = now) {
	if (cutoff <= now - WINDOW_MS) return 0;
	return Math.max(
		0,
		upperBound(times, Math.min(now, cutoff))
			- upperBound(times, now - WINDOW_MS)
	);
}

function mapPeak(notes) {
	const times = notes
		.map(n => n.time)
		.filter(Number.isFinite)
		.sort((a, b) => a - b);

	let left = 0, peak = 0;
	for (let right = 0; right < times.length; right++) {
		while (times[right] - times[left] >= WINDOW_MS) left++;
		peak = Math.max(peak, right - left + 1);
	}
	return peak;
}

function isGame(game) {
	return game
		&& typeof game.now === 'function'
		&& Array.isArray(game.notes)
		&& Array.isArray(game.hitTimes)
		&& Array.isArray(game.headHits)
		&& game.score
		&& Number.isFinite(game.songEndMs);
}

// No fixed hook indices or minified function names. Only inspect ancestor refs.
function locateGame(canvas) {
	const key = Object.keys(canvas).find(k => k.startsWith('__reactFiber$'));
	if (!key) return null;

	let fiber = canvas[key];
	for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
		for (const candidate of [fiber, fiber.alternate]) {
			let hook = candidate?.memoizedState;
			let gameRef = null, clockRef = null;

			for (let i = 0; hook && i < 200; i++, hook = hook.next) {
				const ref = hook.memoizedState;
				const value = ref?.current;

				if (isGame(value)) gameRef = ref;
				if (
					value
					&& typeof value.paused === 'boolean'
					&& Number.isFinite(value.leadStart)
					&& typeof value.audioStarted === 'boolean'
				) {
					clockRef = ref;
				}
			}

			if (gameRef) return { gameRef, clockRef };
		}
	}
	return null;
}

function pressCutoff(game, now) {
	// The engine retains scheduled future presses after a fail. Exclude those.
	// Multiplayer playOn deliberately keeps resolving after HP reaches zero.
	if (game.score.failed && game.finished && !game.playOn) {
		const index = game.schedPtr;
		const last = Array.isArray(game.schedule) && Number.isInteger(index)
			? game.schedule[index - 1]?.time
			: undefined;
		return Number.isFinite(last) ? last : -Infinity;
	}
	return now;
}

// Position is a percentage of the available space, keeping the whole HUD onscreen.
const POSITION_KEY = 'oss-idle:character-kps:position:v1';

function positionControls(host) {
	const panel = document.createElement('div');
	panel.setAttribute('data-character-kps-settings', '1.1.0');
	panel.style.cssText =
		'position:fixed;left:16px;bottom:16px;z-index:10001;max-width:calc(100vw - 32px);';
	panel.hidden = true;

	const shadow = panel.attachShadow({ mode: 'open' });
	shadow.innerHTML = `<style>
		:host{color:#fff;font:14px system-ui,sans-serif}
		*{box-sizing:border-box}
		section{width:320px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;padding:20px;border:1px solid #ffffff30;border-radius:12px;background:#211828;box-shadow:0 10px 40px #0008}
		h2{margin:0 0 7px;font-size:18px}
		p{color:#beafc6;font-size:12px;margin:0 0 18px}
		label{display:flex;justify-content:space-between;margin-top:16px}
		output{font-variant-numeric:tabular-nums;color:#ff8fbe}
		input{width:100%;margin:12px 0;accent-color:#ff66ab}
		footer{display:flex;gap:10px;margin-top:14px}
		button{font:inherit;color:#fff;border:1px solid #ffffff30;border-radius:6px;background:#49304f;padding:8px 12px;cursor:pointer}
		button:focus-visible,input:focus-visible{outline:2px solid #ff8fbe;outline-offset:3px}
		small{display:block;color:#beafc6;margin-top:14px;font-size:11px}
	</style>
	<section role="dialog" aria-label="KPS display position">
		<h2>KPS display position</h2>
		<p>Alt + Shift + T to toggle. Changes preview live.</p>
		<label for="x">Horizontal <output id="x-value"></output></label>
		<input id="x" type="range" min="0" max="100" step="0.1" aria-label="Horizontal position">
		<label for="y">Vertical <output id="y-value"></output></label>
		<input id="y" type="range" min="0" max="100" step="0.1" aria-label="Vertical position">
		<footer>
			<button id="reset" type="button">Reset position</button>
			<button id="close" type="button">Close</button>
		</footer>
		<small id="status">Position saves automatically on this device.</small>
	</section>`;

	document.body.appendChild(panel);

	const x = shadow.querySelector('#x');
	const y = shadow.querySelector('#y');
	const status = shadow.querySelector('#status');

	let position = null, open = false, previousFocus = null;

	try {
		const saved = JSON.parse(localStorage.getItem(POSITION_KEY));
		if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
			position = {
				x: Math.max(0, Math.min(100, saved.x)),
				y: Math.max(0, Math.min(100, saved.y))
			};
		}
	} catch {
		// Blocked storage or malformed settings: retain defaults.
	}

	const apply = () => {
		if (host.hidden) return;

		const roomX = Math.max(0, window.innerWidth - host.offsetWidth);
		const roomY = Math.max(0, window.innerHeight - host.offsetHeight);

		host.style.right = 'auto';
		host.style.left =
			`${position ? roomX * position.x / 100 : Math.max(0, roomX - 20)}px`;
		host.style.top =
			`${position ? roomY * position.y / 100 : Math.min(100, roomY)}px`;

		x.value = String(
			position?.x ?? (roomX ? Math.max(0, roomX - 20) / roomX * 100 : 0)
		);
		y.value = String(
			position?.y ?? (roomY ? Math.min(100, roomY) / roomY * 100 : 0)
		);

		shadow.querySelector('#x-value').textContent =
			`${Number(x.value).toFixed(1)}%`;
		shadow.querySelector('#y-value').textContent =
			`${Number(y.value).toFixed(1)}%`;
	};

	const save = () => {
		try {
			if (position) {
				localStorage.setItem(POSITION_KEY, JSON.stringify(position));
			} else {
				localStorage.removeItem(POSITION_KEY);
			}
			status.textContent = 'Position saves automatically on this device.';
		} catch {
			status.textContent =
				'Storage unavailable: position lasts until the addon reloads.';
		}
	};

	const change = () => {
		position = { x: Number(x.value), y: Number(y.value) };
		apply();
		save();
	};

	x.addEventListener('input', change);
	y.addEventListener('input', change);

	const toggle = next => {
		open = next;
		panel.hidden = !open;

		if (open) {
			previousFocus = document.activeElement;
			host.hidden = false;
			apply();
			x.focus();
		} else if (previousFocus?.isConnected) {
			previousFocus.focus();
		}
	};

	shadow.querySelector('#reset').addEventListener('click', () => {
		position = null;
		apply();
		save();
	});

	shadow.querySelector('#close').addEventListener('click', () => {
		toggle(false);
	});

	const hotkey = event => {
		const match = event.altKey
			&& event.shiftKey
			&& !event.ctrlKey
			&& !event.metaKey
			&& event.code === 'KeyT';

		if (!match && !(open && event.key === 'Escape')) return;

		event.preventDefault();
		event.stopImmediatePropagation();

		if (!event.repeat) toggle(match ? !open : false);
	};

	// Keep slider arrow keys and button presses out of the game's shortcut handler.
	panel.addEventListener('keydown', event => event.stopPropagation());
	panel.addEventListener('keyup', event => event.stopPropagation());

	window.addEventListener('keydown', hotkey, true);
	window.addEventListener('resize', apply);

	const observer = typeof ResizeObserver === 'function'
		? new ResizeObserver(apply)
		: null;

	observer?.observe(host);

	return {
		get open() {
			return open;
		},
		apply,
		destroy() {
			window.removeEventListener('keydown', hotkey, true);
			window.removeEventListener('resize', apply);
			observer?.disconnect();

			if (open && previousFocus?.isConnected) {
				previousFocus.focus();
			}
			panel.remove();
		}
	};
}

export function mount() {
	unmount();

	const host = document.createElement('div');
	host.setAttribute('data-character-kps', '1.1.0');
	host.style.cssText =
		'position:fixed;top:100px;right:20px;z-index:1000;pointer-events:none;';

	const root = host.attachShadow({ mode: 'open' });
	root.innerHTML = `<style>
		:host{font:14px system-ui,sans-serif;color:#fff}
		section{min-width:158px;padding:15px 19px;border:1px solid #ffffff26;border-top:3px solid #ff66ab;border-radius:12px;background:#17121eef;box-shadow:0 8px 28px #0004}
		label{display:block;color:#d9c6d8;font-size:10px;font-weight:700;letter-spacing:1.7px}
		strong{display:block;font-size:38px;font-weight:750;line-height:1.2;font-variant-numeric:tabular-nums}
		.row{display:flex;justify-content:space-between;gap:24px;border-top:1px solid #ffffff1c;margin-top:10px;padding-top:10px;font-size:12px}
		b{color:#ff8fbe;font-variant-numeric:tabular-nums}
		small{display:block;margin-top:7px;color:#af9fb5;font-size:10px;max-width:185px}
	</style>
	<section aria-label="Character keys per second">
		<label>CHARACTER KPS</label>
		<strong>—</strong>
		<div class="row"><span>Map peak</span><b>—</b></div>
		<small>Rolling 1 second · rate adjusted</small>
	</section>`;

	const current = root.querySelector('strong');
	const peakLabel = root.querySelector('b');
	const caption = root.querySelector('small');

	const write = (node, text) => {
		if (node.textContent !== text) node.textContent = text;
	};

	let canvas = null, binding = null, lastGame = null, lastScan = -Infinity;
	let warned = false;

	host.hidden = true;
	document.body.appendChild(host);

	const controls = positionControls(host);

	const tick = () => {
		try {
			const stamp = performance.now();

			if (!canvas?.isConnected || stamp - lastScan >= 500) {
				const next = document.querySelector('canvas.play__canvas');

				if (next !== canvas) {
					canvas = next;
					binding = null;
					lastGame = null;
				}

				binding = canvas ? locateGame(canvas) : null;
				lastScan = stamp;
			}

			const wasHidden = host.hidden;
			host.hidden = !canvas && !controls.open;

			if (wasHidden && !host.hidden) controls.apply();

			if (!canvas) {
				write(current, '—');
				write(peakLabel, '—');
				write(caption, 'Position preview · start a map for KPS');
				return;
			}

			const game = binding?.gameRef.current;

			if (!isGame(game)) {
				write(current, '—');
				write(peakLabel, '—');
				write(caption, 'Waiting for compatible gameplay data');
				return;
			}

			if (game !== lastGame) {
				write(peakLabel, String(mapPeak(game.notes)));
				lastGame = game;
			}

			const now = game.now();
			const waiting = binding.clockRef?.current?.paused;
			const count = waiting
				? 0
				: windowCount(game.hitTimes, now, pressCutoff(game, now));

			write(current, Number.isFinite(now) ? String(count) : '—');
			write(caption, 'Rolling 1 second · rate adjusted');
		} catch (error) {
			write(current, '—');
			write(peakLabel, '—');
			write(caption, 'Gameplay adapter needs an update');

			if (!warned) {
				console.warn('[Character KPS]', error);
				warned = true;
			}
		}
	};

	const timer = setInterval(tick, UPDATE_MS);

	cleanup = () => {
		clearInterval(timer);
		controls.destroy();
		host.remove();
	};

	tick();
}

export function unmount() {
	cleanup?.();
	cleanup = null;
}
