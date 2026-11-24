/*
 * UK junction: traffic drives on the left.
 * Traffic light page: runs step7/OB1.awl on the STL CPU in stl.js and draws
 * the junction from the CPU's outputs. Nothing here decides what the lights
 * do: change the STL and the junction follows.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SCAN_MS = 10;
  const ORIGINAL = window.OB1_SOURCE;

  let source = ORIGINAL;
  let cpu = null;
  let running = false;
  let scans = 0;
  let pedHold = 0;

  // ------------------------------------------------------------ CPU control
  function load(text) {
    const next = STL.createCPU(text);   // throws on syntax errors
    next.scan(SCAN_MS);                 // and catches runtime errors early
    cpu = next; source = text; scans = 1; running = true;
    $("err").hidden = true;
    renderListing();
  }

  function fail(e) {
    running = false;
    $("err").textContent = e.message;
    $("err").hidden = false;
    $("mode").textContent = "STOP"; $("mode").className = "stop";
  }

  function tick(simMs) {
    if (!running) return;
    try {
      cpu.setInput("0.0", pedHold > 0);
      cpu.setInput("0.1", $("night").checked);
      cpu.scan(SCAN_MS);
      scans++;
      pedHold = Math.max(0, pedHold - SCAN_MS);
    } catch (e) { fail(e); }
  }

  // --------------------------------------------------------------- listing
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  function hl(line) {
    const i = line.indexOf("//");
    const code = i < 0 ? line : line.slice(0, i), cm = i < 0 ? "" : line.slice(i);
    const html = esc(code)
      .replace(/^(\s*)([A-Z_][A-Z0-9_]{0,3}:)/i, '$1<span class="l">$2</span>')
      .replace(/\b(A|AN|O|ON|NOT|SET|CLR|S|R|L|T|SD|JU|JC|JCN|JL|NOP|BE|BEU|NETWORK|TITLE|BEGIN|END_ORGANIZATION_BLOCK)\b(?=\s|$|\()/g, '<span class="k">$1</span>')
      .replace(/(S5T#\w+)/g, '<span class="t">$1</span>');
    return html + (cm ? `<span class="c">${esc(cm)}</span>` : "");
  }
  let rows = [];
  function renderListing() {
    const lines = source.split(/\r?\n/);
    $("view").innerHTML = lines.map((l, i) => `<div data-line="${i + 1}"><span class="n">${i + 1}</span><span>${hl(l) || " "}</span></div>`).join("");
    rows = [...$("view").children];
    $("lines").textContent = `· ${lines.length} lines · ${cpu.program.length} instructions`;
  }
  function stepLines(step) {
    // the "STn:" label and its time load, if the program uses that layout
    const i = rows.findIndex((r) => new RegExp(`^\\s*ST${step}:`).test(r.textContent.replace(/^\d+/, "")));
    return i < 0 ? [] : [i, i + 1];
  }
  let lastListing = 0;
  function updateListing(now) {
    if (now - lastListing < 120 || !cpu) return;
    lastListing = now;
    const ex = cpu.executedLines;
    const active = new Set(stepLines(cpu.word("MW 10")));
    rows.forEach((r, i) => { r.classList.toggle("x", ex.has(i + 1)); r.classList.toggle("step", active.has(i)); });
  }

  // --------------------------------------------------------------- outputs
  const OUTS = [
    ["Main red", "Q 0.0", "--red"], ["Side red", "Q 0.3", "--red"],
    ["Main amber", "Q 0.1", "--amber"], ["Side amber", "Q 0.4", "--amber"],
    ["Main green", "Q 0.2", "--green"], ["Side green", "Q 0.5", "--green"],
    ["Walk", "Q 1.0", "--green"], ["Don't walk", "Q 1.1", "--red"]
  ];
  $("outs").innerHTML = OUTS.map(([n, a, c]) => `<div class="out" style="--c:var(${c})"><i></i>${n}<code>${a}</code></div>`).join("");
  const outEls = [...$("outs").children];

  let wasWalk = false;
  function updateStatus() {
    if (!cpu) return;
    const q = (a) => cpu.bit(a);
    OUTS.forEach(([, a], i) => outEls[i].classList.toggle("on", q(a)));
    if (running) { $("mode").textContent = "RUN"; $("mode").className = "run"; }
    $("step").textContent = cpu.word("MW 10");
    const t = cpu.timer(1);
    $("timer").textContent = t.running ? (t.remaining / 1000).toFixed(1) + " s" : t.done ? "done" : "-";
    $("req").textContent = q("M 20.0") ? 1 : 0;
    $("clk").textContent = q("M 0.5") ? 1 : 0;
    $("scans").textContent = scans.toLocaleString();
    const walk = q("Q 1.0");
    if (walk && !wasWalk) $("msg").textContent = "Walk! The request was cleared when the walk step started.";
    if (!walk && wasWalk) $("msg").textContent = "Press the pedestrian button to request a crossing.";
    wasWalk = walk;
  }

  // --------------------------------------------------------------- drawing
  const W = 520, H = 380;
  const cv = $("road"), g = cv.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * dpr; cv.height = H * dpr; g.scale(dpr, dpr);

  const ROAD = { y0: 160, y1: 230, x0: 225, x1: 295 };          // main road band, side road band
  const STOP = { main: ROAD.x0 - 6, side: ROAD.y0 - 6 };         // stop lines (car front)
  const CROSS = { x0: 380, x1: 420 };                            // zebra crossing on the main road
  let cars = [], walkers = [];

  function lightState(prefix) {
    const r = cpu.bit(prefix[0]), a = cpu.bit(prefix[1]), gr = cpu.bit(prefix[2]);
    return gr ? "G" : a ? "A" : r ? "R" : "-";
  }

  function moveTraffic(s) {
    const night = $("night").checked;
    const main = lightState(["Q 0.0", "Q 0.1", "Q 0.2"]), side = lightState(["Q 0.3", "Q 0.4", "Q 0.5"]);
    const walk = cpu.bit("Q 1.0");
    if (Math.random() < s * 0.8) cars.push({ dir: "h", p: -30, v: 0 });
    if (Math.random() < s * 0.45) cars.push({ dir: "v", p: -30, v: 0 });
    for (const c of cars) {
      const light = c.dir === "h" ? main : side, stop = c.dir === "h" ? STOP.main : STOP.side;
      const past = c.p > stop - 1;
      const mayGo = past || light === "G" || (light === "A" && night) || (light === "A" && c.p > stop - 22) || light === "-";
      let target = 140;
      if (!mayGo && c.p < stop) target = Math.min(target, Math.max(0, (stop - c.p) * 4));
      // the zebra: main-road cars wait while people are on it
      if (c.dir === "h" && c.p < CROSS.x0 - 2 && c.p > CROSS.x0 - 60 && walkers.length) target = Math.min(target, Math.max(0, (CROSS.x0 - 4 - c.p) * 4));
      const ahead = cars.filter((o) => o !== c && o.dir === c.dir && o.p > c.p).reduce((m, o) => Math.min(m, o.p), Infinity);
      if (ahead - c.p < 60) target = Math.min(target, Math.max(0, (ahead - c.p - 36) * 4));
      c.v += Math.max(-400 * s, Math.min(200 * s, target - c.v));
      c.p += c.v * s;
    }
    cars = cars.filter((c) => c.p < (c.dir === "h" ? W + 40 : H + 40));
    // people cross while Walk is lit, and finish crossing after it goes out
    if (walk && Math.random() < s * 1.2 && walkers.length < 6) walkers.push({ y: ROAD.y0 - 18, x: CROSS.x0 + 8 + Math.random() * 24 });
    walkers.forEach((w) => (w.y += 34 * s));
    walkers = walkers.filter((w) => w.y < ROAD.y1 + 16);
  }

  function signal(x, y, state, night) {
    g.fillStyle = "#0b0d0f"; g.beginPath(); g.roundRect(x - 12, y - 34, 24, 68, 7); g.fill();
    [["R", "#ef4444"], ["A", "#f59e0b"], ["G", "#22c55e"]].forEach(([k, col], i) => {
      const on = state === k;
      g.fillStyle = on ? col : "#2a3036";
      if (on) { g.shadowColor = col; g.shadowBlur = 14; }
      g.beginPath(); g.arc(x, y - 20 + i * 20, 7, 0, 7); g.fill(); g.shadowBlur = 0;
    });
  }

  function draw() {
    g.fillStyle = "#1d2a22"; g.fillRect(0, 0, W, H);                       // grass
    g.fillStyle = "#3a4046"; g.fillRect(0, ROAD.y0, W, ROAD.y1 - ROAD.y0); g.fillRect(ROAD.x0, 0, ROAD.x1 - ROAD.x0, H);
    g.strokeStyle = "#e8ecef88"; g.lineWidth = 2; g.setLineDash([14, 12]); g.beginPath();
    const my = (ROAD.y0 + ROAD.y1) / 2, mx = (ROAD.x0 + ROAD.x1) / 2;
    g.moveTo(0, my); g.lineTo(ROAD.x0, my); g.moveTo(ROAD.x1, my); g.lineTo(W, my);
    g.moveTo(mx, 0); g.lineTo(mx, ROAD.y0); g.moveTo(mx, ROAD.y1); g.lineTo(mx, H); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#e8ecef"; g.fillRect(STOP.main + 2, ROAD.y0, 3, my - ROAD.y0); g.fillRect(mx, STOP.side + 2, ROAD.x1 - mx, 3);
    for (let y = ROAD.y0 + 4; y < ROAD.y1 - 4; y += 11) g.fillRect(CROSS.x0, y, CROSS.x1 - CROSS.x0, 6); // zebra
    // cars
    for (const c of cars) {
      g.fillStyle = c.dir === "h" ? "#60a5fa" : "#fbbf24";
      g.beginPath();
      if (c.dir === "h") g.roundRect(c.p - 32, ROAD.y0 + 9, 32, 18, 5); else g.roundRect(mx + 9, c.p - 32, 18, 32, 5);
      g.fill();
      g.fillStyle = "#0008";
      if (c.dir === "h") g.fillRect(c.p - 12, ROAD.y0 + 11, 6, 14); else g.fillRect(mx + 11, c.p - 12, 14, 6);
    }
    // people
    g.fillStyle = "#f472b6";
    for (const w of walkers) { g.beginPath(); g.arc(w.x, w.y, 5, 0, 7); g.fill(); }
    // signals
    const night = $("night").checked;
    signal(ROAD.x0 - 28, ROAD.y0 - 46, lightState(["Q 0.0", "Q 0.1", "Q 0.2"]), night);
    signal(ROAD.x1 + 28, ROAD.y0 - 46, lightState(["Q 0.3", "Q 0.4", "Q 0.5"]), night);
    // pedestrian signal
    const walk = cpu.bit("Q 1.0"), wait = cpu.bit("Q 1.1");
    g.fillStyle = "#0b0d0f"; g.beginPath(); g.roundRect(CROSS.x1 + 14, ROAD.y0 - 58, 22, 40, 6); g.fill();
    g.fillStyle = wait ? "#ef4444" : "#2a3036"; g.beginPath(); g.arc(CROSS.x1 + 25, ROAD.y0 - 47, 6, 0, 7); g.fill();
    g.fillStyle = walk ? "#22c55e" : "#2a3036"; g.beginPath(); g.arc(CROSS.x1 + 25, ROAD.y0 - 29, 6, 0, 7); g.fill();
    g.fillStyle = "#e8ecefaa"; g.font = "600 11px ui-monospace, Consolas, monospace";
    g.fillText("MAIN", ROAD.x0 - 76, ROAD.y0 - 42); g.fillText("SIDE", ROAD.x1 + 46, ROAD.y0 - 42); g.fillText("WALK", CROSS.x1 + 42, ROAD.y0 - 34);
  }

  // ------------------------------------------------------------------ loop
  let acc = 0, prev = performance.now();
  function frame(now) {
    const speed = $("fast").checked ? 4 : 1;
    const dt = Math.min(100, now - prev) * speed; prev = now;
    acc += dt;
    while (acc >= SCAN_MS) { tick(); if (cpu) moveTraffic(SCAN_MS / 1000); acc -= SCAN_MS; }
    if (cpu) { draw(); updateStatus(); updateListing(now); }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ input
  $("ped").addEventListener("click", () => { pedHold = 200; $("msg").textContent = "Request latched in M 20.0. Walk comes after the next all-red."; });
  $("night").addEventListener("change", (e) => { $("msg").textContent = e.target.checked ? "Night mode: both roads flash amber, the sequence waits at step 0." : "Back to the normal sequence, starting with main green."; });
  $("edit").addEventListener("click", () => {
    $("editor").value = source; $("editor").hidden = false; $("view").hidden = true;
    $("edit").hidden = true; $("load").hidden = false; $("restore").hidden = false; $("editor").focus();
  });
  $("load").addEventListener("click", () => {
    try { load($("editor").value); $("editor").hidden = true; $("view").hidden = false; $("edit").hidden = false; $("load").hidden = true; $("restore").hidden = true; }
    catch (e) { fail(e); }
  });
  $("restore").addEventListener("click", () => { $("editor").value = ORIGINAL; });

  try { load(source); } catch (e) { fail(e); }
  requestAnimationFrame(frame);
})();
