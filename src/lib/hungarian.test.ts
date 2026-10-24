import { describe, expect, it } from 'vitest';
import { hungarian } from './hungarian';

const total = (cost: number[][], assignment: number[]) => assignment.reduce((sum, col, row) => sum + cost[row][col], 0);

// Independent exhaustive oracle for small matrices, not an implementation of Hungarian.
function exhaustiveMinimum(cost: number[][], row = 0, used = new Set<number>()): number {
  if (row === cost.length) return 0;
  let best = Infinity;
  for (let col = 0; col < cost[0].length; col++) {
    if (used.has(col)) continue;
    used.add(col);
    best = Math.min(best, cost[row][col] + exhaustiveMinimum(cost, row + 1, used));
    used.delete(col);
  }
  return best;
}

describe('hungarian', () => {
  it('solves the required square example', () => {
    expect(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]])).toEqual([1, 0, 2]);
  });
  it('solves the required rectangular example', () => {
    expect(hungarian([[5, 1, 9], [1, 9, 9]])).toEqual([1, 0]);
  });
  it('handles single rows and a single cell', () => {
    expect(hungarian([[7]])).toEqual([0]);
    expect(hungarian([[5, -2, 4]])).toEqual([1]);
    expect(hungarian([[3, 1, 1]])).toEqual([1]);
  });
  it('returns an empty assignment for no rows', () => {
    expect(hungarian([])).toEqual([]);
  });
  it('reassigns an earlier row instead of making greedy choices', () => {
    expect(hungarian([[1, 2, 100], [1, 100, 100]])).toEqual([1, 0]);
  });
  it('handles negative and fractional costs', () => {
    const costs = [[-2.5, -1, 0], [-2, 0.25, 1]];
    expect(hungarian(costs)).toEqual([1, 0]);
    expect(total(costs, hungarian(costs))).toBe(-3);
  });
  it('breaks equal-cost ties deterministically', () => {
    for (let repeat = 0; repeat < 10; repeat++) {
      expect(hungarian([[0, 0, 0], [0, 0, 0]])).toEqual([0, 1]);
      expect(hungarian([[5, 5, 5], [5, 5, 5], [5, 5, 5]])).toEqual([0, 1, 2]);
      expect(hungarian([[0, 0, 2], [0, 0, 2], [2, 2, 0]])).toEqual([0, 1, 2]);
    }
  });
  it('does not mutate the input', () => {
    const costs = [[4, 1, 3], [2, 0, 5], [3, 2, 2]];
    const before = structuredClone(costs);
    costs.forEach(Object.freeze); Object.freeze(costs);
    expect(hungarian(costs)).toEqual([1, 0, 2]);
    expect(costs).toEqual(before);
  });
  it('matches exhaustive optimum on deterministic square and rectangular matrices', () => {
    for (let rows = 1; rows <= 4; rows++) for (let cols = rows; cols <= 5; cols++) {
      for (let seed = 0; seed < 8; seed++) {
        const costs = Array.from({ length: rows }, (_, i) =>
          Array.from({ length: cols }, (_, j) => ((i * 13 + j * 7 + seed * (i + 1) * (j + 3)) % 19) - 9));
        const result = hungarian(costs);
        expect(result).toHaveLength(rows);
        expect(new Set(result).size).toBe(rows);
        expect(result.every(col => Number.isInteger(col) && col >= 0 && col < cols)).toBe(true);
        expect(total(costs, result)).toBe(exhaustiveMinimum(costs));
      }
    }
  });
  it.each([
    null, undefined, 5, {}, [null], [[1], [2]], [[]],
    [[1, 2], [3]], [[1, NaN]], [[Infinity]], [[-Infinity]], [['1']],
    [Array(2)], Array(1), [[1, 2], undefined],
  ])('rejects malformed or non-finite input %#', input => {
    expect(() => hungarian(input as number[][])).toThrow();
  });
  it('reports arithmetic overflow instead of hanging or returning a partial assignment', () => {
    expect(() => hungarian([[Number.MAX_VALUE, -Number.MAX_VALUE], [Number.MAX_VALUE, -Number.MAX_VALUE]])).toThrow(RangeError);
  });
});
