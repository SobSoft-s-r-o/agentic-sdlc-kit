import { isMap, isScalar, parseDocument, Scalar, type Document } from 'yaml';
import { loadConfigFromString } from './schema.js';

export type ConfigMode = 'observe' | 'enforce';

/** `mode` as the scalar's own style would write it, so `mode: "observe"` stays quoted. */
function inStyleOf(node: Scalar, mode: ConfigMode): string | undefined {
  if (node.anchor !== undefined || node.tag !== undefined) return undefined;
  if (node.type === Scalar.PLAIN || node.type === undefined) return mode;
  if (node.type === Scalar.QUOTE_DOUBLE) return `"${mode}"`;
  if (node.type === Scalar.QUOTE_SINGLE) return `'${mode}'`;
  return undefined;
}

/**
 * The edited text with every byte outside `mode` untouched: the value is replaced where it sits, or
 * `mode: <mode>` is appended as the last key of a block-style file. `undefined` when the file is laid
 * out in a way that cannot be edited that safely (flow-style root, tagged or aliased value).
 */
function editInPlace(text: string, doc: Document, mode: ConfigMode): string | undefined {
  const node = doc.getIn(['mode'], true);
  if (isScalar(node)) {
    const written = typeof node.value === 'string' ? inStyleOf(node, mode) : undefined;
    if (written === undefined || node.range == null) return undefined;
    return `${text.slice(0, node.range[0])}${written}${text.slice(node.range[1])}`;
  }
  if (node != null || !isMap(doc.contents) || doc.contents.flow) return undefined;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = text === '' || text.endsWith('\n') ? '' : eol;
  return `${text}${separator}mode: ${mode}${eol}`;
}

/**
 * `text` (the contents of `sdlc.config.yaml`) with `mode` set to `mode`; `previous` is the value the
 * file had, `undefined` when it had none. Comments, blank lines, spacing and key order stay as they
 * are; a missing `mode` key is added after the others. Throws when `mode` is not a mode, or when the
 * edited text is not a valid config with that mode: nothing invalid is ever handed back.
 */
export function setConfigMode(text: string, mode: ConfigMode): { text: string; previous: string | undefined } {
  if (mode !== 'observe' && mode !== 'enforce') {
    throw new Error(`mode must be observe or enforce, got "${String(mode)}"`);
  }
  const doc = parseDocument(text);
  const syntaxError = doc.errors[0];
  if (syntaxError) throw new Error(`Invalid config: YAML syntax error: ${syntaxError.message}`);

  const current: unknown = doc.getIn(['mode']);
  const previous = typeof current === 'string' ? current : undefined;

  let next = editInPlace(text, doc, mode);
  if (next === undefined) {
    // Any other layout: the yaml library re-writes the document (comments and key order are kept,
    // spacing is normalized). It writes `\n`; a file that used CRLF keeps it.
    doc.setIn(['mode'], mode);
    const edited = String(doc);
    next = text.includes('\r\n') ? edited.replace(/\r?\n/g, '\r\n') : edited;
  }
  if (loadConfigFromString(next).mode !== mode) throw new Error(`Could not set mode to ${mode} in the config`);
  return { text: next, previous };
}
