/**
 * Python's text forms of a value, for the places where this SDK must produce
 * the same text as the Python SDK: hashes that have to match byte for byte,
 * and judge prompts and messages that should read the same in both.
 *
 * JavaScript has one number type, so a number cannot say whether it was an
 * int or a float in Python. Every function here reads it the same way, as
 * `json.loads` reads the JSON a structured output usually comes from: a safe
 * integer is an int, anything else a float. A whole-number float such as
 * `1.0` is the one case no reading recovers.
 */

/**
 * Format a number as Python's `json.dumps` writes a float: the shortest
 * round-trip digits, as `repr(float)` gives them. Whole numbers keep `.0`,
 * scientific notation is used below 1e-4 and from 1e16 with an exponent of at
 * least two digits, `-0.0` keeps its sign, and non-finite values are written
 * `NaN`, `Infinity` and `-Infinity`.
 *
 * Every number this formats is written as a float.
 */
export function pythonFloat(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  // toExponential() with no argument gives the shortest round-trip digits.
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : '';
    const magnitude = String(Math.abs(exponent)).padStart(2, '0');
    return `${sign}${digits[0]}${fraction}e${exponent < 0 ? '-' : '+'}${magnitude}`;
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
  const fraction = digits.slice(exponent + 1) || '0';
  return `${sign}${whole}.${fraction}`;
}

/** A safe integer, which Python holds as an int. `-0` is the int `0`, as `json.loads` reads `-0`. */
const intText = (value: number): string | undefined =>
  Number.isSafeInteger(value) ? String(value === 0 ? 0 : value) : undefined;

/** Python's `json.dumps` text for a number: an int for a safe integer, else {@link pythonFloat}. */
export function pythonJsonNumber(value: number): string {
  return intText(value) ?? pythonFloat(value);
}

/** Python's `repr(number)`, with the same int reading as {@link pythonJsonNumber}. */
function numberRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Number.POSITIVE_INFINITY) return 'inf';
  if (value === Number.NEGATIVE_INFINITY) return '-inf';
  return intText(value) ?? pythonFloat(value);
}

/** Characters `str.isprintable()` rejects: control, format, surrogate, private-use, unassigned, and separators other than the space. */
const NON_PRINTABLE = /[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

function escapeCodePoint(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x100) return `\\x${code.toString(16).padStart(2, '0')}`;
  if (code < 0x10000) return `\\u${code.toString(16).padStart(4, '0')}`;
  return `\\U${code.toString(16).padStart(8, '0')}`;
}

/** Python's `repr(str)`: single quotes unless the text holds a single quote and no double quote. */
function stringRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    if (char === '\\') out += '\\\\';
    else if (char === quote) out += `\\${quote}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (NON_PRINTABLE.test(char)) out += escapeCodePoint(char);
    else out += char;
  }
  return out + quote;
}

/**
 * Python's `repr()` of a JSON-like value: `None`, `True` / `False`, numbers as
 * {@link numberRepr} reads them, quoted strings, `[a, b]` and `{'k': v}`. A
 * value that has no Python counterpart, such as a function, falls back to
 * `String()`.
 */
export function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return numberRepr(value);
  if (typeof value === 'string') return stringRepr(value);
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${stringRepr(key)}: ${pythonRepr(item)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return String(value);
}

/** Python's `str()`: a string as it is, anything else as {@link pythonRepr}. */
export function pythonStr(value: unknown): string {
  return typeof value === 'string' ? value : pythonRepr(value);
}

/** Python truthiness: `None`, `False`, `0`, `''`, `[]` and `{}` are false. */
export function pythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Number.isNaN(value)) return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}
