import { AttachmentInputError } from './types.js';

type Element = { name: string; namespace: string; attributes: Map<string, string> };
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
const contentNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationships = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);
function invalid(): never {
  throw new AttachmentInputError();
}
function references(value: string): string {
  return value.replace(/&([^;]*);|&/gu, (match, reference: string | undefined) => {
    const predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
    if (reference && Object.hasOwn(predefined, reference)) return predefined[reference]!;
    if (!reference || !/^#(?:[0-9]+|x[0-9a-f]+)$/iu.test(reference)) return invalid();
    const code =
      reference[1] === 'x' ? Number.parseInt(reference.slice(2), 16) : Number(reference.slice(1));
    if (!(
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff)
    ))
      return invalid();
    return String.fromCodePoint(code);
  });
}

// A bounded XML recognizer for the package declarations and main document. It has no
// DTD/entity expansion, network resolution or document rendering. Only root/direct
// child metadata is retained; document text is never returned to callers.
function document(bytes: Buffer, collectChildren: boolean) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(source)) invalid();
  const name = /[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/uy;
  const attribute =
    /\s+([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/uy;
  const stack: Array<{ name: string; namespaces: Map<string, string> }> = [];
  const children: Element[] = [];
  let root: Element | undefined,
    offset = 0,
    nodes = 0,
    namespaceWork = 0;
  while (offset < source.length) {
    if (source[offset] !== '<') {
      const next = source.indexOf('<', offset),
        end = next === -1 ? source.length : next;
      const text = source.slice(offset, end);
      if ((!stack.length && text.trim()) || text.includes(']]>')) invalid();
      references(text);
      offset = end;
      continue;
    }
    if (source.startsWith('<!--', offset)) {
      const end = source.indexOf('-->', offset + 4);
      if (end === -1 || source.slice(offset + 4, end).includes('--')) invalid();
      offset = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', offset)) {
      const end = source.indexOf(']]>', offset + 9);
      if (!stack.length || end === -1) invalid();
      offset = end + 3;
      continue;
    }
    if (source.startsWith('<?xml', offset)) {
      const end = source.indexOf('?>', offset + 5);
      if (
        offset !== 0 ||
        end === -1 ||
        !/^<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>$/iu.test(
          source.slice(0, end + 2),
        )
      )
        invalid();
      offset = end + 2;
      continue;
    }
    const closing = source.startsWith('</', offset);
    name.lastIndex = offset + (closing ? 2 : 1);
    const found = name.exec(source);
    if (!found || found[0].length > 128) invalid();
    offset = name.lastIndex;
    if (closing) {
      while (/\s/u.test(source[offset] ?? '') && offset < source.length) offset++;
      if (source[offset] !== '>' || stack.pop()?.name !== found[0]) invalid();
      offset++;
      continue;
    }
    if (++nodes > 250000 || stack.length >= 128 || (root && !stack.length)) invalid();
    const attributes = new Map<string, string>();
    while (true) {
      attribute.lastIndex = offset;
      const match = attribute.exec(source);
      if (!match) break;
      if (attributes.size >= 128 || attributes.has(match[1]!)) invalid();
      attributes.set(match[1]!, references(match[2] ?? match[3]!));
      offset = attribute.lastIndex;
    }
    while (/\s/u.test(source[offset] ?? '') && offset < source.length) offset++;
    const empty = source.startsWith('/>', offset);
    if (!empty && source[offset] !== '>') invalid();
    offset += empty ? 2 : 1;
    const inherited = stack.at(-1)?.namespaces ?? new Map([['xml', xmlNamespace]]);
    const declarations = [...attributes].filter(
      ([key]) => key === 'xmlns' || key.startsWith('xmlns:'),
    );
    let namespaces = inherited;
    if (declarations.length) {
      namespaceWork += inherited.size + declarations.length;
      if (namespaceWork > 65536) invalid();
      namespaces = new Map(inherited);
    }
    // Descendants share unchanged scopes; declaration changes pay a finite
    // cumulative copy budget before allocating a new namespace map.
    for (const [key, value] of declarations) {
      if (key === 'xmlns') namespaces.set('', value);
      else if (key.startsWith('xmlns:')) {
        const prefix = key.slice(6);
        if (
          !value ||
          prefix === 'xmlns' ||
          (prefix === 'xml' && value !== xmlNamespace) ||
          (prefix !== 'xml' && value === xmlNamespace)
        )
          invalid();
        namespaces.set(prefix, value);
      }
    }
    const expandedAttributes = new Set<string>();
    for (const key of attributes.keys()) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
      const parts = key.split(':'),
        namespace = parts.length === 1 ? '' : namespaces.get(parts[0]!);
      if (namespace === undefined) invalid();
      const expanded = `${namespace}:${parts.at(-1)}`;
      if (expandedAttributes.has(expanded)) invalid();
      expandedAttributes.add(expanded);
    }
    const parts = found[0].split(':'),
      namespace =
        namespaces.get(parts.length === 1 ? '' : parts[0]!) ??
        (parts.length === 1 ? '' : undefined);
    if (namespace === undefined) invalid();
    const element = { name: parts.at(-1)!, namespace, attributes };
    if (!root) root = element;
    else if (collectChildren && stack.length === 1) children.push(element);
    if (!empty) stack.push({ name: found[0], namespaces });
  }
  if (!root || stack.length) invalid();
  return { root, children };
}

export function validateOfficeFamily(files: Map<string, Buffer>, extension: string): void {
  const main = extension === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
  const family = extension === 'docx' ? 'wordprocessingml' : 'spreadsheetml';
  const mainType = `application/vnd.openxmlformats-officedocument.${family}.${extension === 'docx' ? 'document' : 'sheet'}.main+xml`;
  const types = files.get('[Content_Types].xml'),
    rels = files.get('_rels/.rels'),
    mainBytes = files.get(main);
  if (!types || !rels || !mainBytes || types.length > 1048576 || rels.length > 1048576) invalid();
  const declarations = document(types, true),
    relationships = document(rels, true),
    content = document(mainBytes, false);
  const overrides = declarations.children.filter(
    (e) =>
      e.name === 'Override' &&
      e.namespace === contentNamespace &&
      e.attributes.get('PartName') === `/${main}`,
  );
  const office = relationships.children.filter(
    (e) =>
      e.name === 'Relationship' &&
      e.namespace === relationshipNamespace &&
      officeRelationships.has(e.attributes.get('Type') ?? ''),
  );
  if (
    declarations.root.name !== 'Types' ||
    declarations.root.namespace !== contentNamespace ||
    relationships.root.name !== 'Relationships' ||
    relationships.root.namespace !== relationshipNamespace ||
    overrides.length !== 1 ||
    overrides[0]!.attributes.get('ContentType') !== mainType ||
    declarations.children.some((e) =>
      /macroEnabled/iu.test(e.attributes.get('ContentType') ?? ''),
    ) ||
    office.length !== 1 ||
    ![main, `/${main}`].includes(office[0]!.attributes.get('Target') ?? '') ||
    !['Internal', undefined].includes(office[0]!.attributes.get('TargetMode')) ||
    content.root.name !== (extension === 'docx' ? 'document' : 'workbook') ||
    ![
      `http://schemas.openxmlformats.org/${family}/2006/main`,
      `http://purl.oclc.org/ooxml/${family}/main`,
    ].includes(content.root.namespace)
  )
    invalid();
}
