/**
 * Minimum-cost assignment: result[row] is its distinct, zero-based column.
 * Supports finite costs (including negatives), rows <= columns, and [] -> [].
 * Ties use ascending row/column traversal and retain the first equal candidate;
 * the result is deterministic, but not promised to be lexicographically smallest.
 * Time O(rows^2 * columns), auxiliary space O(rows + columns).
 * Does not mutate cost. Arithmetic uses JavaScript double precision.
 */
export function hungarian(cost: number[][]): number[] {
  if (!Array.isArray(cost)) throw new TypeError('Cost matrix must be an array');
  const rows = cost.length;
  if (rows === 0) return [];
  if (!Array.isArray(cost[0])) throw new TypeError('Each cost row must be an array');
  const columns = cost[0].length;
  if (rows > columns) throw new RangeError('Rows must not exceed columns');
  // Index loops also reject sparse arrays, unlike Array.every().
  for (let i = 0; i < rows; i++) {
    if (!Array.isArray(cost[i]) || cost[i].length !== columns) {
      throw new TypeError('Cost matrix must be rectangular');
    }
    for (let j = 0; j < columns; j++) {
      if (typeof cost[i][j] !== 'number' || !Number.isFinite(cost[i][j])) {
        throw new TypeError('Every cost must be a finite number');
      }
    }
  }

  // One-based indices; column 0 is a dummy root for each augmenting search.
  const u = Array<number>(rows + 1).fill(0); // row potentials
  const v = Array<number>(columns + 1).fill(0); // column potentials
  const p = Array<number>(columns + 1).fill(0); // matched row for each column, 0 = free
  const way = Array<number>(columns + 1).fill(0); // predecessor column

  for (let row = 1; row <= rows; row++) {
    p[0] = row;
    let column = 0;
    const minSlack = Array<number>(columns + 1).fill(Infinity);
    const used = Array<boolean>(columns + 1).fill(false);
    do {
      used[column] = true;
      const currentRow = p[column];
      let delta = Infinity;
      let nextColumn = 0;
      for (let j = 1; j <= columns; j++) {
        if (used[j]) continue;
        const reduced = cost[currentRow - 1][j - 1] - u[currentRow] - v[j];
        if (!Number.isFinite(reduced)) throw new RangeError('Cost arithmetic exceeds finite number range');
        if (reduced < minSlack[j]) {
          minSlack[j] = reduced;
          way[j] = column;
        }
        if (minSlack[j] < delta) {
          delta = minSlack[j];
          nextColumn = j;
        }
      }
      for (let j = 0; j <= columns; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          // The dummy potential is unused; skipping it avoids total-cost overflow.
          if (j !== 0) v[j] -= delta;
          if (!Number.isFinite(u[p[j]]) || !Number.isFinite(v[j])) {
            throw new RangeError('Cost arithmetic exceeds finite number range');
          }
        } else {
          minSlack[j] -= delta;
        }
      }
      column = nextColumn;
    } while (p[column] !== 0);

    // Flip the alternating path to assign one additional row.
    do {
      const previous = way[column];
      p[column] = p[previous];
      column = previous;
    } while (column !== 0);
  }

  const assignment = Array<number>(rows).fill(-1);
  for (let j = 1; j <= columns; j++) {
    if (p[j] !== 0) assignment[p[j] - 1] = j - 1;
  }
  return assignment;
}
