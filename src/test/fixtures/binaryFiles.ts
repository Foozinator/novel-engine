/**
 * Small binary files for tests that must prove a file is left byte-for-byte
 * unchanged (#83). Each starts with its format's real header.
 */

/** A valid 1×1 PNG (signature, IHDR, IDAT, IEND). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A JFIF header: SOI, APP0 "JFIF\0" segment, EOI. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

/** A glTF 2.0 binary: 12-byte header plus one JSON chunk. */
function makeGlb(): Buffer {
  const json = Buffer.from('{"asset":{"version":"2.0"}}', 'utf-8');
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + padded.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(padded.length, 0);
  chunkHeader.write('JSON', 4, 'ascii');
  return Buffer.concat([header, chunkHeader, padded]);
}

export const BINARY_FIXTURES: ReadonlyArray<{ path: string; bytes: Buffer }> = [
  { path: 'assets/cover.png', bytes: PNG },
  { path: 'assets/photo.jpg', bytes: JPEG },
  { path: 'assets/model.glb', bytes: makeGlb() },
];
