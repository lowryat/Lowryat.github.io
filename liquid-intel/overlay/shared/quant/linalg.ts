/** Minimal dense linear algebra for correlation modelling. */

export type Matrix = number[][];

/** Lower-triangular Cholesky factor, or null if the matrix is not positive definite. */
export function cholesky(matrix: Matrix): Matrix | null {
  const n = matrix.length;
  const lower: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k += 1) sum -= lower[i][k] * lower[j][k];
      if (i === j) {
        if (!(sum > 1e-12)) return null;
        lower[i][i] = Math.sqrt(sum);
      } else {
        lower[i][j] = sum / lower[j][j];
      }
    }
  }
  return lower;
}

/**
 * Cholesky with increasing diagonal regularization. Sample correlation
 * matrices from short or overlapping histories are often not quite positive
 * definite; nudging the diagonal and rescaling keeps unit variances.
 */
export function robustCholesky(matrix: Matrix): { factor: Matrix; jitter: number } {
  const n = matrix.length;
  for (const jitter of [0, 1e-8, 1e-6, 1e-4, 1e-3, 1e-2, 5e-2, 0.1, 0.25]) {
    const adjusted = matrix.map((row, i) => row.map((value, j) => (i === j ? value + jitter : value) / (1 + jitter)));
    const factor = cholesky(adjusted);
    if (factor) return { factor, jitter };
  }
  return { factor: identity(n), jitter: 1 };
}

export function identity(n: number): Matrix {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

/** Pairwise-complete sample correlation of columns (each series already aligned). */
export function correlationMatrix(series: number[][]): Matrix {
  const n = series.length;
  const result = identity(n);
  const means = series.map((values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
  const scales = series.map((values, index) => Math.sqrt(values.reduce((sum, value) => sum + (value - means[index]) ** 2, 0)));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const length = Math.min(series[i].length, series[j].length);
      let sum = 0;
      for (let t = 0; t < length; t += 1) sum += (series[i][t] - means[i]) * (series[j][t] - means[j]);
      const denominator = scales[i] * scales[j];
      const value = denominator > 0 ? Math.max(-0.999, Math.min(0.999, sum / denominator)) : 0;
      result[i][j] = value;
      result[j][i] = value;
    }
  }
  return result;
}

/** Average off-diagonal element. */
export function averageCorrelation(matrix: Matrix): number {
  const n = matrix.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) sum += matrix[i][j];
  return sum / ((n * (n - 1)) / 2);
}

/**
 * Shrink toward a constant-correlation target (Ledoit-Wolf style, fixed
 * intensity). Stabilizes noisy pairs without destroying the structure.
 */
export function shrinkCorrelation(matrix: Matrix, intensity = 0.15): Matrix {
  const target = averageCorrelation(matrix);
  return matrix.map((row, i) => row.map((value, j) => (i === j ? 1 : (1 - intensity) * value + intensity * target)));
}

/** Blend toward a crisis matrix where every pair has correlation `stressed`. */
export function stressCorrelation(matrix: Matrix, weight: number, stressed = 0.9): Matrix {
  if (!(weight > 0)) return matrix;
  return matrix.map((row, i) => row.map((value, j) => (i === j ? 1 : (1 - weight) * value + weight * stressed)));
}
