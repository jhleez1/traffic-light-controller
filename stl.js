/*
 * A tiny Siemens S7 CPU for the browser.
 *
 * Runs a STEP 7 STL (AWL) source file directly, scan by scan, with the
 * subset of instructions this project uses:
 *
 *   bit logic   A AN O ON  A( AN( O( ON( )  O (on its own)  NOT SET CLR
 *   assign      =  S  R
 *   load/store  L  T        constants, S5T#..., MW n
 *   maths       +I -I  ==I <>I >I <I >=I <=I
 *   timers      SD (on-delay)  R T n   A T n
 *   jumps       JU JC JCN JL, labels
 *   other       NOP  BE  BEU
 *
 * Memory areas I, Q and M are 256 bytes each. MB 0 behaves as the CPU's
 * clock memory byte (M 0.5 = 1 Hz), like the hardware setting in STEP 7.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.STL = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------- parsing
  function parseTime(s) {
    // S5T#6S, S5T#500MS, S5T#1S500MS, S5T#1M30S
    const m = /^S5T#(?:(\d+)H)?(?:(\d+)M(?!S))?(?:(\d+)S)?(?:(\d+)MS)?$/i.exec(s);
    if (!m) throw new Error("Bad time constant " + s);
    return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 + (+m[4] || 0);
  }

  function parseOperand(text) {
    if (!text) return null;
    const t = text.replace(/\s+/g, " ").trim();
    let m;
    if ((m = /^([IQM])\s?(\d+)\.([0-7])$/i.exec(t))) return { kind: "bit", area: m[1].toUpperCase(), byte: +m[2], bit: +m[3] };
    if ((m = /^([IQM])W\s?(\d+)$/i.exec(t))) return { kind: "word", area: m[1].toUpperCase(), byte: +m[2] };
    if ((m = /^T\s?(\d+)$/i.exec(t))) return { kind: "timer", n: +m[1] };
    if (/^S5T#/i.test(t)) return { kind: "const", value: parseTime(t) };
    if (/^[-+]?\d+$/.test(t)) return { kind: "const", value: +t };
    if (/^[A-Z_][A-Z0-9_]{0,3}$/i.test(t)) return { kind: "label", name: t.toUpperCase() };
    throw new Error("Unknown operand " + t);
  }

  function parse(source) {
    const lines = source.split(/\r?\n/);
    const program = [];
    const labels = {};
    let inBody = false;
    lines.forEach((raw, i) => {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!inBody) { if (/^BEGIN\b/i.test(line)) inBody = true; return; }
      if (!line || /^(NETWORK|TITLE\s*=)/i.test(line)) return;
      if (/^END_(ORGANIZATION_BLOCK|FUNCTION_BLOCK|FUNCTION)\b/i.test(line)) { inBody = false; return; }
      let rest = line, label = null;
      const lm = /^([A-Z_][A-Z0-9_]{0,3}):\s*(.*)$/i.exec(rest);
      if (lm) { label = lm[1].toUpperCase(); rest = lm[2]; }
      const mm = /^(\S+)\s*(.*)$/.exec(rest);
      const op = mm[1].toUpperCase();
      let arg;
      try { arg = parseOperand(mm[2]); } catch (e) { throw new Error(`Line ${i + 1}: ${e.message}`); }
      const ins = { op, arg, line: i + 1, text: raw };
      if (label) labels[label] = program.length;
      program.push(ins);
    });
    for (const ins of program) if (ins.arg && ins.arg.kind === "label" && !(ins.arg.name in labels)) throw new Error(`Line ${ins.line}: unknown label ${ins.arg.name}`);
    return { program, labels };
  }

  // ------------------------------------------------------------------- CPU
  const CLOCK_HZ = [10, 5, 2.5, 2, 1.25, 1, 0.625, 0.5]; // M0.0 .. M0.7

  function createCPU(source) {
    const { program, labels } = parse(source);
    const mem = { I: new Uint8Array(256), Q: new Uint8Array(256), M: new Uint8Array(256) };
    const timers = {};
    let time = 0;
    let executed = new Set();

    const getBit = (a) => (mem[a.area][a.byte] >> a.bit) & 1 ? true : false;
    const setBit = (a, v) => { if (v) mem[a.area][a.byte] |= 1 << a.bit; else mem[a.area][a.byte] &= ~(1 << a.bit); };
    const getWord = (a) => { const v = (mem[a.area][a.byte] << 8) | mem[a.area][a.byte + 1]; return v & 0x8000 ? v - 0x10000 : v; };
    const setWord = (a, v) => { v &= 0xffff; mem[a.area][a.byte] = v >> 8; mem[a.area][a.byte + 1] = v & 0xff; };
    const timer = (n) => (timers[n] ||= { done: false, running: false, remaining: 0, prevRlo: false });

    function read(arg) {
      switch (arg.kind) {
        case "bit": return getBit(arg);
        case "timer": return timer(arg.n).done;
        case "word": return getWord(arg);
        case "const": return arg.value;
      }
      throw new Error("Cannot read " + JSON.stringify(arg));
    }

    function scan(dtMs) {
      time += dtMs;
      // clock memory byte MB 0
      let clock = 0;
      CLOCK_HZ.forEach((hz, bit) => { const period = 1000 / hz; if (time % period < period / 2) clock |= 1 << bit; });
      mem.M[0] = clock;
      // running timers count down between scans
      for (const t of Object.values(timers)) if (t.running) { t.remaining -= dtMs; if (t.remaining <= 0) { t.running = false; t.done = true; t.remaining = 0; } }

      // status word, simplified: RLO = orAcc OR term
      let fc = false, orAcc = false, term = true, accu1 = 0, accu2 = 0;
      const stack = [];
      const rlo = () => orAcc || term;
      const logic = (op, v) => {
        if (op === "AN" || op === "ON") v = !v;
        if (!fc) { orAcc = false; term = v; fc = true; return; }
        if (op[0] === "A") term = term === null ? v : term && v;
        else { orAcc = orAcc || !!term; term = v; }
      };
      const endString = () => { fc = false; };
      executed = new Set();

      let pc = 0, guard = 0;
      while (pc < program.length) {
        if (++guard > 100000) throw new Error("Endless loop in program");
        const ins = program[pc++];
        executed.add(ins.line);
        const { op, arg } = ins;
        switch (op) {
          case "A": case "AN": case "O": case "ON":
            if (op === "O" && !arg) { orAcc = orAcc || !!term; term = null; break; }
            logic(op, read(arg)); break;
          case "A(": case "AN(": case "O(": case "ON(":
            stack.push({ fc, orAcc, term, op: op.slice(0, -1) }); fc = false; break;
          case ")": {
            const r = rlo(), s = stack.pop();
            ({ fc, orAcc, term } = s);
            logic(s.op, r); break;
          }
          case "NOT": { const r = rlo(); orAcc = false; term = !r; fc = true; break; }
          case "SET": orAcc = false; term = true; endString(); break;
          case "CLR": orAcc = false; term = false; endString(); break;
          case "=": setBit(arg, rlo()); endString(); break;
          case "S":
            if (rlo()) { if (arg.kind === "timer") throw new Error("S T not supported"); setBit(arg, true); }
            endString(); break;
          case "R":
            if (rlo()) { if (arg.kind === "timer") Object.assign(timer(arg.n), { done: false, running: false, remaining: 0 }); else setBit(arg, false); }
            endString(); break;
          case "L": accu2 = accu1; accu1 = read(arg); break;
          case "T": setWord(arg, accu1); break;
          case "+I": accu1 = ((accu2 + accu1) << 16) >> 16; break;
          case "-I": accu1 = ((accu2 - accu1) << 16) >> 16; break;
          case "==I": logic("A", accu2 === accu1); break;
          case "<>I": logic("A", accu2 !== accu1); break;
          case ">I": logic("A", accu2 > accu1); break;
          case "<I": logic("A", accu2 < accu1); break;
          case ">=I": logic("A", accu2 >= accu1); break;
          case "<=I": logic("A", accu2 <= accu1); break;
          case "SD": {
            const t = timer(arg.n), r = rlo();
            if (r && !t.prevRlo) { t.running = true; t.done = false; t.remaining = accu1; }
            if (!r) { t.running = false; t.done = false; }
            t.prevRlo = r; endString(); break;
          }
          case "JU": pc = labels[arg.name]; break;
          case "JC": case "JCN": {
            const jump = op === "JC" ? rlo() : !rlo();
            orAcc = false; term = true; endString();
            if (jump) pc = labels[arg.name];
            break;
          }
          case "JL": {
            const end = labels[arg.name], n = accu1 & 0xff, count = end - pc;
            pc = n < count ? labels[program[pc + n].arg.name] : end;
            break;
          }
          case "NOP": break;
          case "BE": case "BEU": pc = program.length; break;
          default: throw new Error(`Line ${ins.line}: instruction ${op} is not supported`);
        }
      }
    }

    function addr(text) { const a = parseOperand(text); if (!a || a.kind === "const" || a.kind === "label") throw new Error("Bad address " + text); return a; }

    return {
      scan,
      program,
      get time() { return time; },
      get executedLines() { return executed; },
      setInput(text, v) { setBit(addr("I " + text.replace(/^I\s*/i, "")), v); },
      bit(text) { return getBit(addr(text)); },
      word(text) { return getWord(addr(text)); },
      timer(n) { return { ...timer(n) }; }
    };
  }

  return { createCPU, parse, parseTime };
});
