// The dev view's charts: Chart.js (vendored, scripts/dev-view-vendor) drawing the specs scripts/status-render.mjs puts in
// <script id="chart-data">. Inlined into the page; no module system, no network. Each spec is one chart: {title, label, unit, target,
// series: [{env, points: [{t, v, sha}]}]}. The x axis is time or commits (the toggle in each drill-down); the target is a dashed line;
// hovering a point shows its value, commit and time.
/*FMT*/
(function () {
	var specs = JSON.parse(document.getElementById("chart-data").textContent);
	var charts = {};
	var mode = "time";
	try { mode = localStorage.getItem("folder-sync-dev-axis") === "commit" ? "commit" : "time"; } catch (e) { /* private window: the default */ }
	window.__devCharts = charts;

	function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
	function pad(n) { return (n < 10 ? "0" : "") + n; }
	var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	function stamp(ms) { var d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC"; }
	function dateTick(ms, spanMs) {
		var d = new Date(ms);
		return spanMs < 2 * 864e5 ? pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) : MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
	}
	function shortSha(sha) { return sha ? sha.replace(/\+dirty$/, "+").slice(0, 7) : "unknown"; }

	// Where each point sits. Time: its epoch ms. Commits: the commits in the order they were first measured, one slot each, with
	// the points of one commit spread across its slot.
	function layout(spec) {
		var order = [];
		var first = {};
		spec.series.forEach(function (s) {
			s.points.forEach(function (p) {
				var key = p.sha || "?" + p.t.slice(0, 10);
				var t = Date.parse(p.t);
				if (!(key in first) || t < first[key]) first[key] = t;
			});
		});
		order = Object.keys(first).sort(function (a, b) { return first[a] - first[b]; });
		var slot = {};
		order.forEach(function (k, i) { slot[k] = i; });
		var minT = Infinity, maxT = -Infinity;
		var perSeries = spec.series.map(function (s) {
			var counts = {}, seen = {};
			s.points.forEach(function (p) { var k = p.sha || "?" + p.t.slice(0, 10); counts[k] = (counts[k] || 0) + 1; });
			var data = s.points.map(function (p) {
				var key = p.sha || "?" + p.t.slice(0, 10);
				var t = Date.parse(p.t);
				minT = Math.min(minT, t); maxT = Math.max(maxT, t);
				var j = seen[key] = (seen[key] === undefined ? 0 : seen[key] + 1);
				var n = counts[key];
				var x = mode === "commit" ? slot[key] + (n === 1 ? 0 : (j / (n - 1) - 0.5) * 0.7) : t;
				return { x: x, y: p.v, sha: p.sha, t: t };
			});
			return { env: s.env, data: data };
		});
		return { order: order, series: perSeries, minT: minT, maxT: maxT };
	}

	function datasets(spec, lay) {
		var many = lay.series.reduce(function (n, s) { return Math.max(n, s.data.length); }, 0);
		var list = lay.series.map(function (s) {
			var color = css(s.env === "prod" ? "--prod" : "--test");
			return {
				label: s.env, data: s.data, borderColor: color, backgroundColor: color, borderWidth: 2, tension: 0, spanGaps: false,
				pointRadius: many <= 40 ? 3 : 0, pointHoverRadius: 5, pointHitRadius: 10, pointBorderColor: css("--surface"), pointBorderWidth: 1,
			};
		});
		if (spec.target !== null && spec.target !== undefined) {
			var lo = mode === "commit" ? -0.5 : lay.minT, hi = mode === "commit" ? lay.order.length - 0.5 : lay.maxT;
			if (hi <= lo) hi = lo + 1;
			list.push({ label: "target", data: [{ x: lo, y: spec.target }, { x: hi, y: spec.target }], borderColor: css("--ink-3"), borderWidth: 1, borderDash: [4, 3], pointRadius: 0, pointHitRadius: 0, pointHoverRadius: 0, isTarget: true });
		}
		return list;
	}

	function options(spec, lay) {
		var span = Math.max(lay.maxT - lay.minT, 1);
		var ink = css("--ink-3");
		var allNonNegative = lay.series.every(function (s) { return s.data.every(function (p) { return p.y >= 0; }); });
		return {
			responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
			interaction: { mode: "nearest", intersect: false, axis: "x" },
			scales: {
				x: mode === "commit"
					? { type: "linear", min: -0.5, max: Math.max(lay.order.length - 0.5, 0.5), grid: { color: css("--grid") }, ticks: { color: ink, font: { size: 10, family: "ui-monospace, monospace" }, stepSize: 1, maxRotation: 60, autoSkip: true, callback: function (v) { return Number.isInteger(v) && lay.order[v] !== undefined ? shortSha(lay.order[v].charAt(0) === "?" ? "" : lay.order[v]) : ""; } } }
					: { type: "linear", grid: { color: css("--grid") }, ticks: { color: ink, font: { size: 10 }, maxTicksLimit: 6, maxRotation: 0, callback: function (v) { return dateTick(v, span); } } },
				y: { beginAtZero: allNonNegative, grid: { color: css("--grid") }, border: { display: false }, ticks: { color: ink, font: { size: 10 }, maxTicksLimit: 5, callback: function (v) { return fmt(spec.unit, v); } } },
			},
			plugins: {
				legend: { display: spec.series.length > 1 || spec.target !== null, labels: { color: css("--ink-2"), boxWidth: 14, boxHeight: 2, font: { size: 11 } } },
				tooltip: {
					backgroundColor: css("--ink"), titleColor: css("--page"), bodyColor: css("--page"), displayColors: false, padding: 8, filter: function (item) { return !item.dataset.isTarget; },
					callbacks: {
						title: function (items) { var p = items[0].raw; return (p.sha ? shortSha(p.sha) : "unknown commit") + " · " + stamp(p.t); },
						label: function (item) { return item.dataset.label + ": " + fmt(spec.unit, item.raw.y); },
					},
				},
			},
		};
	}

	function build(canvas) {
		var index = canvas.getAttribute("data-chart");
		if (charts[index]) return;
		var spec = specs[index];
		var lay = layout(spec);
		charts[index] = new Chart(canvas, { type: "line", data: { datasets: datasets(spec, lay) }, options: options(spec, lay) });
	}

	function rebuild() {
		Object.keys(charts).forEach(function (i) {
			var canvas = charts[i].canvas;
			charts[i].destroy();
			delete charts[i];
			if (canvas.offsetParent !== null) build(canvas);
		});
	}

	// Charts are drawn when their drill-down is open (a hidden section has no size to draw into).
	function ensure() {
		document.querySelectorAll("canvas[data-chart]").forEach(function (canvas) { if (canvas.offsetParent !== null) build(canvas); });
	}

	function setMode(next, remember) {
		mode = next;
		document.querySelectorAll(".seg button").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-axis") === mode ? "true" : "false"); });
		if (remember) { try { localStorage.setItem("folder-sync-dev-axis", mode); } catch (e) { /* not remembered */ } }
		rebuild();
	}

	document.addEventListener("click", function (e) {
		var b = e.target.closest && e.target.closest(".seg button");
		if (b) setMode(b.getAttribute("data-axis"), true);
	});
	window.addEventListener("hashchange", ensure);
	// the URL's #fragment is not the :target yet while the page is still being parsed, so a page opened on #o1 draws on load
	window.addEventListener("load", ensure);
	// the page repaints for light and dark: the canvases read their colours from the CSS variables, so they are redrawn
	if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rebuild);
	new MutationObserver(rebuild).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	setMode(mode, false);
	ensure();
})();
