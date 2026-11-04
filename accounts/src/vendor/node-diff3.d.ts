/** The part of node-diff3 (vendored, node-diff3.js) the shared tree uses: diff3Merge over arrays of lines. */
export type Diff3Region<T> = { ok: T[]; conflict?: undefined } | { ok?: undefined; conflict: { a: T[]; aIndex: number; o: T[]; oIndex: number; b: T[]; bIndex: number } };

export declare function diff3Merge<T>(a: T[], o: T[], b: T[], options?: { excludeFalseConflicts?: boolean; stringSeparator?: string | RegExp }): Diff3Region<T>[];
