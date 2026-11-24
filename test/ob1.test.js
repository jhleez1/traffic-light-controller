// Run with: node --test
// These tests run the real step7/OB1.awl through the STL interpreter.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCPU, parseTime } = require("../stl.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "step7", "OB1.awl"), "utf8");
const SCAN = 10;

function lights(cpu) {
  const on = (a) => cpu.bit(a);
  const main = on("Q 0.2") ? "G" : on("Q 0.1") ? "A" : on("Q 0.0") ? "R" : "-";
  const side = on("Q 0.5") ? "G" : on("Q 0.4") ? "A" : on("Q 0.3") ? "R" : "-";
  const ped = on("Q 1.0") ? "walk" : on("Q 1.1") ? "wait" : "-";
  return `${main}${side} ${ped}`;
}

/** Runs for `ms` and returns each distinct light state with how long it lasted. */
function record(cpu, ms) {
  const out = [];
  for (let t = 0; t < ms; t += SCAN) {
    cpu.scan(SCAN);
    const s = lights(cpu);
    if (out.length && out[out.length - 1].s === s) out[out.length - 1].ms += SCAN;
    else out.push({ s, ms: SCAN });
  }
  return out;
}

test("S5T# time constants", () => {
  assert.equal(parseTime("S5T#6S"), 6000);
  assert.equal(parseTime("S5T#500MS"), 500);
  assert.equal(parseTime("S5T#1S500MS"), 1500);
  assert.equal(parseTime("S5T#1M30S"), 90000);
});

test("STL logic: AND before OR, brackets and NOT", () => {
  const prog = (body) => `BEGIN\n${body}\nEND_ORGANIZATION_BLOCK`;
  const cpu = createCPU(prog(`
      A     I 0.0
      A     I 0.1
      O
      A     I 0.2
      =     Q 0.0
      A(
      O     I 0.0
      O     I 0.1
      )
      AN    I 0.2
      =     Q 0.1
      A     I 0.0
      NOT
      =     Q 0.2`));
  const check = (i0, i1, i2) => {
    cpu.setInput("0.0", i0); cpu.setInput("0.1", i1); cpu.setInput("0.2", i2); cpu.scan(10);
    assert.equal(cpu.bit("Q 0.0"), (i0 && i1) || i2, `Q0.0 for ${i0},${i1},${i2}`);
    assert.equal(cpu.bit("Q 0.1"), (i0 || i1) && !i2, `Q0.1 for ${i0},${i1},${i2}`);
    assert.equal(cpu.bit("Q 0.2"), !i0);
  };
  for (const a of [false, true]) for (const b of [false, true]) for (const c of [false, true]) check(a, b, c);
});

test("normal cycle without a pedestrian: walk step is skipped", () => {
  const cpu = createCPU(SRC);
  const seq = record(cpu, 17000).slice(0, 6);
  assert.deepEqual(seq.map((x) => x.s), ["GR wait", "AR wait", "RR wait", "RG wait", "RA wait", "RR wait"]);
  // durations are within two scans of the programmed times (the step change costs a scan)
  const want = [6000, 2000, 1000, 4000, 2000, 1000];
  seq.forEach((x, i) => assert.ok(Math.abs(x.ms - want[i]) <= 2 * SCAN, `${x.s} lasted ${x.ms} ms, want ${want[i]}`));
});

test("pressing the button inserts the walk step after the all-red", () => {
  const cpu = createCPU(SRC);
  cpu.setInput("0.0", true); cpu.scan(SCAN); cpu.setInput("0.0", false);
  assert.equal(cpu.bit("M 20.0"), true, "request is latched");
  const seq = record(cpu, 15000).map((x) => x.s);
  assert.deepEqual(seq.slice(0, 5), ["GR wait", "AR wait", "RR wait", "RR walk", "RG wait"]);
  assert.equal(cpu.bit("M 20.0"), false, "request cleared once the walk step started");
});

test("the request is only served once", () => {
  const cpu = createCPU(SRC);
  cpu.setInput("0.0", true); cpu.scan(SCAN); cpu.setInput("0.0", false);
  const seq = record(cpu, 40000).map((x) => x.s);
  assert.equal(seq.filter((s) => s === "RR walk").length, 1);
});

test("night mode flashes both ambers at 1 Hz and turns everything else off", () => {
  const cpu = createCPU(SRC);
  record(cpu, 7000);                     // somewhere in the cycle
  cpu.setInput("0.1", true);
  const seq = record(cpu, 4000);
  assert.ok(seq.every((x) => x.s === "AA -" || x.s === "-- -"), JSON.stringify(seq));
  const flashes = seq.filter((x) => x.s === "AA -");
  assert.ok(flashes.length >= 3, "it flashes");
  flashes.slice(1, -1).forEach((x) => assert.equal(x.ms, 500));
  assert.equal(cpu.word("MW 10"), 0, "sequence held at step 0");
});

test("leaving night mode starts again at main green", () => {
  const cpu = createCPU(SRC);
  cpu.setInput("0.1", true); record(cpu, 3000);
  cpu.setInput("0.1", false);
  const seq = record(cpu, 6500);
  assert.equal(seq[0].s, "GR wait");
  assert.ok(Math.abs(seq[0].ms - 6000) <= 2 * SCAN);
});

test("an out-of-range step number recovers to step 0", () => {
  const src = SRC.replace("NETWORK\nTITLE = Latch", "NETWORK\nTITLE = Fault injection\n      A     I 0.7\n      JCN   NOF\n      L     42\n      T     MW 10\nNOF:  NOP   0\nNETWORK\nTITLE = Latch");
  const cpu = createCPU(src);
  cpu.setInput("0.7", true); cpu.scan(SCAN); cpu.setInput("0.7", false); cpu.scan(SCAN);
  assert.equal(cpu.word("MW 10"), 0);
});

test("unknown instructions and labels are reported with a line number", () => {
  assert.throws(() => createCPU("BEGIN\n JU NOPE\nEND_ORGANIZATION_BLOCK"), /line 2: unknown label NOPE/i);
  const cpu = createCPU("BEGIN\n XYZ\nEND_ORGANIZATION_BLOCK");
  assert.throws(() => cpu.scan(10), /Line 2: instruction XYZ/);
});

test("step7/ob1.js is up to date with OB1.awl (run node tools/embed.js)", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "step7", "ob1.js"), "utf8");
  const embedded = JSON.parse(js.slice(js.indexOf("=") + 1).trim().replace(/;$/, ""));
  assert.equal(embedded, SRC.replace(/\r\n/g, "\n"));
});
