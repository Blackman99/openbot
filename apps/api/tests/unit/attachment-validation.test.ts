import sharp from 'sharp';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AttachmentInputError, parseAttachmentCommand } from '../../src/attachments/types.js';
import { validateAttachment } from '../../src/attachments/validation.js';
function command(bytes: Buffer, filename: string, mediaType: string) {
  return parseAttachmentCommand({
    body: 'Read this',
    idempotencyKey: 'test',
    filename,
    mediaType,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
function zip(files: Record<string, string>) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const path = Buffer.from(name),
      data = Buffer.from(body),
      header = Buffer.alloc(30),
      directory = Buffer.alloc(46),
      crc = crc32(data);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(path.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(header, path, data);
    central.push(directory, path);
    offset += header.length + path.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function officeFiles(extension: 'docx' | 'xlsx'): Record<string, string> {
  const main = extension === 'docx' ? 'word/document.xml' : 'xl/workbook.xml',
    type = extension === 'docx' ? 'wordprocessingml.document' : 'spreadsheetml.sheet';
  return {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`,
    [main]:
      extension === 'docx'
        ? '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'
        : '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
  };
}
function office(extension: 'docx' | 'xlsx') {
  return zip(officeFiles(extension));
}
describe('bounded attachment content validation', () => {
  it('accepts UTF-8 Markdown and CSV only with their declared filename and media family', async () => {
    const markdown = Buffer.from('# Heading\nA useful note.');
    await expect(
      validateAttachment(markdown, command(markdown, 'notes.md', 'text/markdown')),
    ).resolves.toBeUndefined();
    const csv = Buffer.from('name,count\nalpha,2\n');
    await expect(
      validateAttachment(csv, command(csv, 'data.csv', 'text/csv')),
    ).resolves.toBeUndefined();
    await expect(
      validateAttachment(markdown, command(markdown, 'notes.html', 'text/markdown')),
    ).rejects.toBeInstanceOf(AttachmentInputError);
  });
  it('fully decodes bounded static PNG/JPEG and rejects animation, malformed images, and signature disagreement', async () => {
    for (const format of ['png', 'jpeg'] as const) {
      const bytes = await sharp({
        create: { width: 4, height: 4, channels: 3, background: '#123456' },
      })
        .toFormat(format)
        .toBuffer();
      await expect(
        validateAttachment(bytes, command(bytes, `image.${format}`, `image/${format}`)),
      ).resolves.toBeUndefined();
      await expect(
        validateAttachment(
          bytes.subarray(0, -1),
          command(bytes.subarray(0, -1), `image.${format}`, `image/${format}`),
        ),
      ).rejects.toThrow();
    }
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } })
      .png()
      .toBuffer();
    await expect(
      validateAttachment(png, command(png, 'wrong.jpg', 'image/jpeg')),
    ).rejects.toThrow();
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8);
    chunk.write('acTL', 4);
    const apng = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
    await expect(
      validateAttachment(apng, command(apng, 'animated.png', 'image/png')),
    ).rejects.toThrow();
  });
  it('recognizes bounded OOXML families and rejects arbitrary ZIP, family masquerading, and corrupt archives', async () => {
    const docx = office('docx'),
      xlsx = office('xlsx');
    await expect(
      validateAttachment(
        docx,
        command(
          docx,
          'report.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateAttachment(
        xlsx,
        command(
          xlsx,
          'report.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateAttachment(
        xlsx,
        command(
          xlsx,
          'wrong.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ),
    ).rejects.toThrow();
    const arbitrary = zip({ 'payload.txt': 'hello' });
    await expect(
      validateAttachment(
        arbitrary,
        command(
          arbitrary,
          'fake.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ),
    ).rejects.toThrow();
    const corrupt = Buffer.from(docx);
    corrupt[60] = corrupt[60]! ^ 1;
    await expect(
      validateAttachment(
        corrupt,
        command(
          corrupt,
          'broken.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ),
    ).rejects.toThrow();
  });
  it('recognizes OOXML declarations structurally, including valid single-quoted XML', async () => {
    const files = Object.fromEntries(
      Object.entries(officeFiles('docx')).map(([name, content]) => [
        name,
        content.replaceAll('"', "'"),
      ]),
    );
    const bytes = zip(files);
    await expect(
      validateAttachment(
        bytes,
        command(
          bytes,
          'report.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ),
    ).resolves.toBeUndefined();
  });
  it('rejects OOXML family claims in comments, unrelated attributes, or non-XML main content', async () => {
    const spoof = officeFiles('xlsx');
    spoof['[Content_Types].xml'] = spoof['[Content_Types].xml']!.replace(
      '</Types>',
      '<!-- PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" --></Types>',
    );
    spoof['_rels/.rels'] = spoof['_rels/.rels']!.replace(
      '</Relationships>',
      '<!-- Target="word/document.xml" --></Relationships>',
    );
    spoof['word/document.xml'] = 'not an XML document';
    const separateAttributes = officeFiles('docx');
    separateAttributes['[Content_Types].xml'] = separateAttributes['[Content_Types].xml']!.replace(
      ' ContentType=',
      '/><Override PartName="/unrelated.xml" ContentType=',
    );
    const nonXml = officeFiles('docx');
    nonXml['word/document.xml'] = 'not an XML document';
    const wrongNamespace = officeFiles('docx');
    wrongNamespace['word/document.xml'] = '<w:document xmlns:w="https://unrelated.invalid"/>';
    const externalMain = officeFiles('docx');
    externalMain['_rels/.rels'] = externalMain['_rels/.rels']!.replace(
      ' Target=',
      ' TargetMode="External" Target=',
    );
    const malformed = officeFiles('docx');
    malformed['word/document.xml'] = malformed['word/document.xml']!.replace('</w:document>', '');
    const entity = officeFiles('docx');
    entity['word/document.xml'] =
      '<!DOCTYPE document [<!ENTITY local SYSTEM "file:///private">]>' +
      entity['word/document.xml'];
    const deep = officeFiles('docx');
    deep['word/document.xml'] = deep['word/document.xml']!.replace(
      '<w:body/>',
      '<w:body>'.repeat(129) + '</w:body>'.repeat(129),
    );
    for (const files of [
      spoof,
      separateAttributes,
      nonXml,
      wrongNamespace,
      externalMain,
      malformed,
      entity,
      deep,
    ]) {
      const bytes = zip(files);
      await expect(
        validateAttachment(
          bytes,
          command(
            bytes,
            'report.docx',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ),
        ),
      ).rejects.toBeInstanceOf(AttachmentInputError);
    }
  });
  it('rejects cumulative XML namespace amplification within the ordinary file and depth limits', async () => {
    const files = officeFiles('docx');
    const nested =
      Array.from(
        { length: 64 },
        (_, depth) =>
          `<w:body ${Array.from({ length: 64 }, (_, index) => `xmlns:n${depth}_${index}="urn:namespace:${depth}:${index}"`).join(' ')}>`,
      ).join('') + '</w:body>'.repeat(64);
    files['word/document.xml'] = files['word/document.xml']!.replace('<w:body/>', nested);
    const bytes = zip(files);
    expect(bytes.length).toBeLessThan(200000);
    await expect(
      validateAttachment(
        bytes,
        command(
          bytes,
          'report.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ),
    ).rejects.toBeInstanceOf(AttachmentInputError);
  });
  it('rejects unsafe filenames, invalid UTF-8, active text and false checksums without treating MIME as content', async () => {
    const bytes = Buffer.from('safe');
    for (const filename of ['../x.txt', 'x.html', 'x.svg', 'x.exe', ' bad.txt', 'x.txt\u0000']) {
      await expect(async () =>
        validateAttachment(bytes, command(bytes, filename, 'text/plain')),
      ).rejects.toThrow();
    }
    for (const bytes of [
      Buffer.from([0xc0, 0xaf]),
      Buffer.from('<html><script>evil()</script></html>'),
      Buffer.from([0, 1, 2]),
    ])
      await expect(
        validateAttachment(bytes, command(bytes, 'fake.txt', 'text/plain')),
      ).rejects.toThrow();
    await expect(
      validateAttachment(bytes, {
        ...command(bytes, 'notes.txt', 'text/plain'),
        sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow();
  });
});
