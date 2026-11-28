/** Characters a backslash escapes inside double quotes; before any other it stays a backslash. */
const DOUBLE_QUOTE_ESCAPES = '$`"\\';

/** Characters that end a heredoc delimiter word when unquoted. */
const DELIMITER_END = ' \t\n;|&()<>';

/** The text of a backtick substitution starting just past its opening backtick, and where it ends. */
function readBacktick(src: string, start: number): { inner: string; end: number } {
  let inner = '';
  let i = start;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '`') return { inner, end: i + 1 };
    if (c === '\\' && next !== undefined && '`\\$'.includes(next)) {
      inner += next;
      i += 2;
    } else {
      inner += c;
      i += 1;
    }
  }
  return { inner, end: i };
}

/**
 * Where a heredoc body that starts at `from` ends: just past the line that holds `delim` alone
 * (with leading tabs ignored for `<<-`). -1 when no such line follows.
 */
function heredocEnd(src: string, from: number, delim: string, stripTabs: boolean): number {
  let pos = from;
  while (pos < src.length) {
    const newline = src.indexOf('\n', pos);
    const stop = newline < 0 ? src.length : newline;
    let line = src.slice(pos, stop).replace(/\r$/, '');
    if (stripTabs) line = line.replace(/^\t+/, '');
    if (line === delim) return newline < 0 ? src.length : newline + 1;
    if (newline < 0) return -1;
    pos = newline + 1;
  }
  return -1;
}

/**
 * Reads shell text from `start`, appending one word list per simple command to `out` in the order
 * the commands begin (so a command comes before the substitutions inside it; some lists stay
 * empty). Substitutions (`$( )`, backticks, `<( )`, `>( )`) are scanned recursively into `out`
 * too; a nested read ends at the `)` that closes it. Returns the index just past what it read.
 *
 * Heredoc bodies are data: `<<[-] DELIM` (quoted or not) queues a body, and the lines after the
 * next newline up to the delimiter line are skipped, so an apostrophe or a command-like line in a
 * commit message cannot hide or fake a command. A heredoc with no delimiter line (which is also
 * what `((1<<2))` looks like) skips nothing: the shell would take the rest as the body, but
 * reading it as commands is the safe side.
 *
 * A quote that is never closed is read as a literal character, since the shell would refuse that
 * command anyway; this keeps a stray `'` or `"` from hiding what follows.
 */
function scan(src: string, start: number, out: string[][], nested: boolean): number {
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let groups = 0;
  let i = start;
  const heredocs: { delim: string; stripTabs: boolean }[] = [];

  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    words = [];
    out.push(words);
  };
  const substitution = (inner: string): void => {
    scan(inner, 0, out, false);
  };

  /** Double-quoted text, from just past the opening quote. False when the quote is never closed. */
  const doubleQuoted = (): boolean => {
    while (i < src.length) {
      const c = src[i] as string;
      const next = src[i + 1];
      if (c === '"') {
        i += 1;
        return true;
      }
      if (c === '\\' && next !== undefined) {
        if (next === '\n') {
          i += 2;
        } else if (DOUBLE_QUOTE_ESCAPES.includes(next)) {
          word += next;
          i += 2;
        } else {
          word += c;
          i += 1;
        }
      } else if (c === '`') {
        const { inner, end } = readBacktick(src, i + 1);
        substitution(inner);
        i = end;
      } else if (c === '$' && next === '(') {
        i = scan(src, i + 2, out, true);
      } else {
        word += c;
        i += 1;
      }
    }
    return false;
  };

  /** `<<[-] DELIM` at `at`: the operator and delimiter become one word, the body is queued. Returns the index after it. */
  const heredocOperator = (at: number): number => {
    let j = at + 2;
    const stripTabs = src[j] === '-';
    if (stripTabs) j += 1;
    word += stripTabs ? '<<-' : '<<';
    inWord = true;
    while (src[j] === ' ' || src[j] === '\t') j += 1;
    let delim = '';
    while (j < src.length && !DELIMITER_END.includes(src[j] as string)) {
      const ch = src[j] as string;
      const close = ch === "'" || ch === '"' ? src.indexOf(ch, j + 1) : -1;
      if (close >= 0) {
        delim += src.slice(j + 1, close);
        j = close + 1;
      } else if (ch === '\\' && j + 1 < src.length) {
        delim += src[j + 1];
        j += 2;
      } else {
        delim += ch;
        j += 1;
      }
    }
    word += delim;
    if (delim !== '') heredocs.push({ delim, stripTabs });
    return j;
  };

  /** After a newline at `from`: skips the queued heredoc bodies, or nothing if one has no end. */
  const skipHeredocBodies = (from: number): number => {
    let pos = from;
    for (const { delim, stripTabs } of heredocs.splice(0)) {
      const end = heredocEnd(src, pos, delim, stripTabs);
      if (end < 0) return from;
      pos = end;
    }
    return pos;
  };

  out.push(words);
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    switch (c) {
      case '\\':
        if (next === '\n') {
          i += 2;
        } else if (next === undefined) {
          word += c;
          inWord = true;
          i += 1;
        } else {
          word += next;
          inWord = true;
          i += 2;
        }
        break;
      case "'": {
        inWord = true;
        const close = src.indexOf("'", i + 1);
        if (close < 0) {
          word += c;
          i += 1;
        } else {
          word += src.slice(i + 1, close);
          i = close + 1;
        }
        break;
      }
      case '"': {
        inWord = true;
        const quoteStart = i;
        const outLength = out.length;
        const wordBefore = word;
        i += 1;
        if (!doubleQuoted()) {
          // Never closed: undo what the scan added and read the quote as an ordinary character.
          out.length = outLength;
          word = `${wordBefore}"`;
          i = quoteStart + 1;
        }
        break;
      }
      case '`': {
        inWord = true;
        const { inner, end } = readBacktick(src, i + 1);
        substitution(inner);
        i = end;
        break;
      }
      case '$':
        inWord = true;
        if (next === '(') {
          i = scan(src, i + 2, out, true);
        } else {
          word += c;
          i += 1;
        }
        break;
      case '<':
      case '>':
        inWord = true;
        if (c === '<' && next === '<' && src[i + 2] !== '<' && src[i - 1] !== '<') {
          i = heredocOperator(i);
        } else if (next === '(') {
          i = scan(src, i + 2, out, true);
        } else {
          word += c;
          i += 1;
        }
        break;
      case '&': {
        // `2>&1`, `>&2` and `&>file` are redirections, not command separators.
        const before = src[i - 1];
        if (before === '>' || before === '<' || next === '>') {
          word += c;
          inWord = true;
        } else {
          endCommand();
        }
        i += 1;
        break;
      }
      case '\n':
        endCommand();
        i = skipHeredocBodies(i + 1);
        break;
      case ';':
      case '|':
        endCommand();
        i += 1;
        break;
      case '(':
        endCommand();
        groups += 1;
        i += 1;
        break;
      case ')':
        endCommand();
        i += 1;
        if (groups > 0) groups -= 1;
        else if (nested) return i;
        break;
      case ' ':
      case '\t':
      case '\r':
        endWord();
        i += 1;
        break;
      case '#':
        if (inWord) {
          word += c;
          i += 1;
        } else {
          while (i < src.length && src[i] !== '\n') i += 1;
        }
        break;
      default:
        word += c;
        inWord = true;
        i += 1;
    }
  }
  endWord();
  return i;
}

/**
 * The simple commands of a shell command line, one word list each. Splits on `;`, `&&`, `||`, `|`,
 * `&`, newlines, subshell parentheses, and the insides of `$( )` and backticks, including inside
 * double quotes. Quotes and backslash escapes are honoured, so quoted text is one word and a
 * quoted `;` splits nothing. Heredoc bodies are skipped (see `scan`), and the text of a heredoc
 * that is fed to a shell (`cat <<EOF | sh`) is therefore not checked.
 */
export function shellWords(command: string): string[][] {
  const out: string[][] = [];
  scan(command, 0, out, false);
  return out.filter(words => words.length > 0);
}
