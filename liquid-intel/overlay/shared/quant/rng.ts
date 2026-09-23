/**
 * Seeded random numbers for reproducible Monte Carlo. The same seed gives the
 * same draws on the server and in the browser, which is also what makes
 * sensitivity runs use common random numbers (only the inputs change).
 */

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spare: number | null = null;

  constructor(seed: number) {
    const init = splitmix32(Math.floor(seed) || 1);
    this.a = init();
    this.b = init();
    this.c = init();
    this.d = init();
    for (let index = 0; index < 12; index += 1) this.nextUint();
  }

  /** sfc32: fast, well-distributed 32-bit generator. */
  private nextUint(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in (0, 1), never exactly 0. */
  next(): number {
    return (this.nextUint() + 0.5) / 4294967296;
  }

  /** Standard normal via the Marsaglia polar method. */
  normal(): number {
    if (this.spare != null) {
      const value = this.spare;
      this.spare = null;
      return value;
    }
    for (;;) {
      const u = 2 * this.next() - 1;
      const v = 2 * this.next() - 1;
      const s = u * u + v * v;
      if (s > 0 && s < 1) {
        const factor = Math.sqrt((-2 * Math.log(s)) / s);
        this.spare = v * factor;
        return u * factor;
      }
    }
  }

  /** Gamma(shape, 1) via Marsaglia-Tsang. */
  gamma(shape: number): number {
    if (shape < 1) {
      const u = this.next();
      return this.gamma(shape + 1) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  chiSquare(degreesOfFreedom: number): number {
    return 2 * this.gamma(degreesOfFreedom / 2);
  }
}
