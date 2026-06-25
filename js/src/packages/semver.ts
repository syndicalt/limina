// limina — minimal but REAL semver for package-level versioning + engine-compat
// bounds (Phase 4b / M9). No external dependency: the package registry resolves
// `name@version`, picks the highest installed version satisfying a range, and the
// loader checks a manifest's `engineCompat` range against the engine version.
//
// Supported range grammar (a practical, correct subset of node-semver):
//   - `*` / `x` / `X` / "" / "latest"        -> any version
//   - exact `1.2.3`                           -> = 1.2.3
//   - comparators `>=1.2.3` `>1.2.3` `<=1.2.3` `<1.2.3` `=1.2.3`
//   - caret `^1.2.3`  (compatible-with: keeps the left-most non-zero element)
//   - tilde `~1.2.3`  (>=1.2.3 <1.3.0)
//   - AND: space-separated comparators in one set (`>=1.0.0 <2.0.0`)
//   - OR : `||`-separated sets (`^1.0.0 || ^2.0.0`)
// Precedence follows semver: prerelease < its release; numeric prerelease ids
// compare numerically, alphanumeric lexically, numeric < alphanumeric, and a
// longer prerelease tuple outranks a shorter common prefix. An unparseable
// comparator FAILS its set (fail-closed) so a malformed range never silently
// admits an out-of-bounds version.

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** dot-separated prerelease identifiers ([] = a release). */
  prerelease: string[];
}

const CORE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a strict `x.y.z[-prerelease][+build]` version; `null` if malformed. */
export function parseSemver(v: string): Semver | null {
  const m = CORE.exec(v.trim());
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split("."),
  };
}

/** Whether `v` is a well-formed semver version. */
export function isSemver(v: string): boolean {
  return parseSemver(v) !== null;
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  // A release (no prerelease) has HIGHER precedence than any prerelease.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an && !bn) {
      return -1; // numeric identifiers always have lower precedence
    } else if (!an && bn) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** Total order on versions: -1 if a<b, 0 if equal, 1 if a>b. */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const p = comparePrerelease(a.prerelease, b.prerelease);
  return p < 0 ? -1 : p > 0 ? 1 : 0;
}

/** Compare two version STRINGS; unparseable strings sort as -Infinity (lowest). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  return compareSemver(pa, pb);
}

type Comparator = (v: Semver) => boolean;

function caretRange(s: string): Comparator[] | null {
  const t = parseSemver(s);
  if (t === null) return null;
  let upper: Semver;
  if (t.major > 0) upper = { major: t.major + 1, minor: 0, patch: 0, prerelease: [] };
  else if (t.minor > 0) upper = { major: 0, minor: t.minor + 1, patch: 0, prerelease: [] };
  else upper = { major: 0, minor: 0, patch: t.patch + 1, prerelease: [] };
  return [(v) => compareSemver(v, t) >= 0, (v) => compareSemver(v, upper) < 0];
}

function tildeRange(s: string): Comparator[] | null {
  const t = parseSemver(s);
  if (t === null) return null;
  const upper: Semver = { major: t.major, minor: t.minor + 1, patch: 0, prerelease: [] };
  return [(v) => compareSemver(v, t) >= 0, (v) => compareSemver(v, upper) < 0];
}

function parseComparator(tok: string): Comparator[] | null {
  if (tok === "" || tok === "*" || tok === "x" || tok === "X" || tok === "latest") return [() => true];
  if (tok.startsWith("^")) return caretRange(tok.slice(1));
  if (tok.startsWith("~")) return tildeRange(tok.slice(1));
  const m = /^(>=|<=|>|<|=)?(.+)$/.exec(tok);
  if (m === null) return null;
  const op = m[1] ?? "=";
  const target = parseSemver(m[2]);
  if (target === null) return null;
  switch (op) {
    case ">=": return [(v) => compareSemver(v, target) >= 0];
    case "<=": return [(v) => compareSemver(v, target) <= 0];
    case ">": return [(v) => compareSemver(v, target) > 0];
    case "<": return [(v) => compareSemver(v, target) < 0];
    default: return [(v) => compareSemver(v, target) === 0];
  }
}

function satisfiesSet(v: Semver, set: string): boolean {
  const tokens = set.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  const comparators: Comparator[] = [];
  for (const tok of tokens) {
    const cs = parseComparator(tok);
    if (cs === null) return false; // fail-closed on a malformed comparator
    comparators.push(...cs);
  }
  return comparators.every((c) => c(v));
}

/** Whether `version` satisfies the `range`. A malformed version never satisfies;
 *  an empty/`*` range matches anything. */
export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (v === null) return false;
  const orSets = range.split("||").map((s) => s.trim());
  if (orSets.every((s) => s.length === 0)) return true;
  return orSets.some((set) => satisfiesSet(v, set));
}
