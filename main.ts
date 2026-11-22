// VM kecil untuk ISA stack 32-bit make.fun, ditulis orisinal dari ISA.md.
// Node 22, tanpa dependensi. Membaca /input, menulis /output. Deterministik.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const MAX_STEPS = 1000000;
const MAX_OUT = 65536;

// Panjang immediate per opcode; 255 = opcode tak dikenal.
const IMM = new Uint8Array(256).fill(255);
for (const o of [0, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33, 34, 52, 64, 65, 80, 81, 82, 83]) IMM[o] = 0;
IMM[1] = 1; IMM[2] = 4; IMM[48] = 2; IMM[49] = 2; IMM[50] = 2; IMM[51] = 2;

// [pop, push] per opcode, untuk pemeriksaan trap 2/3 sebelum trap instruksi.
function need(op) {
  switch (op) {
    case 1: case 2: case 82: return [0, 1];
    case 3: case 49: case 50: case 80: case 81: case 83: return [1, 0];
    case 4: return [1, 2];
    case 5: return [2, 2];
    case 6: return [2, 3];
    case 7: return [3, 3];
    case 23: case 27: return [1, 1];
    case 64: return [1, 1];
    case 65: return [2, 0];
    case 0: case 48: case 51: case 52: return [0, 0];
    default: return [2, 1];
  }
}

function run(prog, input) {
  const st = [];
  const cs = [];
  const mem = new Int32Array(256);
  const out = [];
  let outLen = 0, pc = 0, ip = 0, steps = 0;
  const n = prog.length;
  let code = 0;

  while (true) {
    if (steps >= MAX_STEPS) { code = 10; break; } // batas langkah, sebelum eksekusi
    if (pc < 0 || pc >= n) { code = 9; break; } // pc di luar program
    const op = prog[pc];
    const il = IMM[op];
    if (il === 255) { code = 5; break; } // opcode tak dikenal
    if (pc + 1 + il > n) { code = 9; break; } // immediate terpotong
    // Kebutuhan stack diperiksa SEBELUM trap instruksi itu sendiri.
    const [np, nq] = need(op);
    if (st.length < np) { code = 2; break; }
    if (st.length - np + nq > 256) { code = 3; break; }
    steps++;
    const next = pc + 1 + il;

    switch (op) {
      case 0: return { out: Buffer.concat(out), code: 0 }; // HALT
      case 1: { const b = prog[pc + 1]; st.push(b >= 128 ? b - 256 : b); break; } // PUSH8 sign-extend
      case 2: st.push(prog.readInt32LE(pc + 1)); break; // PUSH32
      case 3: st.pop(); break;
      case 4: st.push(st[st.length - 1]); break; // DUP
      case 5: { const l = st.length; const t = st[l - 1]; st[l - 1] = st[l - 2]; st[l - 2] = t; break; }
      case 6: st.push(st[st.length - 2]); break; // OVER
      case 7: { const l = st.length; const a = st[l - 3], b = st[l - 2], c = st[l - 1]; st[l - 3] = b; st[l - 2] = c; st[l - 1] = a; break; } // ROT
      case 16: case 17: case 18: case 19: case 20: case 21: case 22:
      case 24: case 25: case 26: case 28: case 29: case 30:
      case 32: case 33: case 34: {
        const b = st.pop(), a = st.pop();
        let r;
        if (op === 16) r = (a + b) | 0; // ADD wrap
        else if (op === 17) r = (a - b) | 0; // SUB wrap
        else if (op === 18) r = Math.imul(a, b); // MUL 32 bit bawah
        else if (op === 19) { if (b === 0) { code = 4; break; } r = Math.trunc(a / b) | 0; } // DIV
        else if (op === 20) { if (b === 0) { code = 4; break; } r = (a % b) | 0; } // MOD tanda a
        else if (op === 21) { if (b === 0) { code = 4; break; } r = Math.floor((a >>> 0) / (b >>> 0)) | 0; } // DIVU
        else if (op === 22) { if (b === 0) { code = 4; break; } r = ((a >>> 0) % (b >>> 0)) | 0; } // MODU
        else if (op === 24) r = a & b;
        else if (op === 25) r = a | b;
        else if (op === 26) r = a ^ b;
        else if (op === 28) r = (a << (b & 31)) | 0; // SHL
        else if (op === 29) r = a >> (b & 31); // SHR aritmetik
        else if (op === 30) r = (a >>> (b & 31)) | 0; // SHRU logis
        else if (op === 32) r = a === b ? 1 : 0;
        else if (op === 33) r = a < b ? 1 : 0; // LT signed
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU unsigned
        st.push(r);
        break;
      }
      case 23: st.push((-st.pop()) | 0); break; // NEG wrap
      case 27: st.push(~st.pop()); break;
      case 48: pc = next + prog.readInt16LE(pc + 1); continue; // JMP offset signed
      case 49: { const v = st.pop(); pc = v === 0 ? next + prog.readInt16LE(pc + 1) : next; continue; }
      case 50: { const v = st.pop(); pc = v !== 0 ? next + prog.readInt16LE(pc + 1) : next; continue; }
      case 51: {
        if (cs.length >= 64) { code = 7; break; }
        cs.push(next);
        pc = prog.readUInt16LE(pc + 1);
        continue;
      }
      case 52: {
        if (cs.length === 0) { code = 8; break; }
        pc = cs.pop();
        continue;
      }
      case 64: {
        const addr = st.pop();
        if (addr < 0 || addr > 255) { code = 6; break; }
        st.push(mem[addr]);
        break;
      }
      case 65: {
        const addr = st.pop(), v = st.pop();
        if (addr < 0 || addr > 255) { code = 6; break; }
        mem[addr] = v;
        break;
      }
      case 80: {
        const s = String(st.pop());
        if (outLen + s.length > MAX_OUT) { code = 11; break; } // PRINT tak menulis apa pun
        out.push(Buffer.from(s));
        outLen += s.length;
        break;
      }
      case 81: {
        if (outLen + 1 > MAX_OUT) { code = 11; break; }
        out.push(Buffer.from([st.pop() & 255]));
        outLen += 1;
        break;
      }
      case 82: st.push(ip < input.length ? input[ip++] : -1); break; // IN, -1 bila habis
      case 83: return { out: Buffer.concat(out), code: st.pop() & 255 }; // EXIT low byte
    }
    if (code !== 0) break; // trap dari dalam switch
    pc = next;
  }
  return { out: Buffer.concat(out), code };
}

for (const id of readdirSync(IN_DIR).sort()) {
  let prog, input;
  try { prog = readFileSync(join(IN_DIR, id, 'program.bin')); } catch { continue; }
  try { input = readFileSync(join(IN_DIR, id, 'input.bin')); } catch { input = Buffer.alloc(0); }
  const { out, code } = run(prog, input);
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'stdout.bin'), out);
  writeFileSync(join(OUT_DIR, id, 'exit.txt'), String(code) + '\n');
}
