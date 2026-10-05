/**
 * Import layer public API: files and built-in songs → Chart.
 *
 *   chartFromMusicXml(xml)   MusicXML text (partwise or timewise)
 *   chartFromMidi(bytes)     Standard MIDI file; also generates chart.musicXml
 *   chartToMusicXml(chart)   grand-staff MusicXML for the sheet view
 *   importFile(file)         .musicxml/.xml/.mxl/.mid/.midi (by extension, then by sniffing)
 *
 * Every failure a user can cause is an `ImportError` with a Korean message to show as is.
 */
import { unzipSync, strFromU8 } from 'fflate';
import type { Chart } from '../core/chart';
import { ImportError, type ImportOptions } from './common';
import { chartFromMidi } from './midi';
import { chartFromMusicXml } from './musicxml';
import { chartToMusicXml } from './toMusicXml';

export { ImportError, chartFromMidi, chartFromMusicXml, chartToMusicXml };
export type { ImportOptions };
export { BUILTIN_SONGS, type SongEntry } from '../songs';

type Kind = 'xml' | 'mxl' | 'midi';

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes);
}

function sniff(bytes: Uint8Array): Kind | null {
  const head = String.fromCharCode(...bytes.subarray(0, 4));
  if (head === 'MThd') return 'midi';
  if (head === 'PK\u0003\u0004') return 'mxl';
  const text = decodeText(bytes.subarray(0, 4096)).replace(/^﻿/, '').trimStart();
  if (text.startsWith('<') && /<score-(partwise|timewise)/.test(text)) return 'xml';
  if (text.startsWith('<?xml')) return 'xml';
  return null;
}

function kindFromName(name: string): Kind | null | 'unsupported' {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'musicxml' || ext === 'xml') return 'xml';
  if (ext === 'mxl') return 'mxl';
  if (ext === 'mid' || ext === 'midi' || ext === 'smf' || ext === 'kar') return 'midi';
  if (['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) return 'unsupported';
  return null;
}

/** Unzips a compressed MusicXML (.mxl) and returns the score's XML text. */
export function musicXmlFromMxl(bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new ImportError('압축된 MusicXML(.mxl) 파일을 풀 수 없어요. 파일이 손상됐을 수 있어요.', { cause: e });
  }
  let path: string | undefined;
  const container = files['META-INF/container.xml'];
  if (container) {
    const m = /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(strFromU8(container));
    if (m && files[m[1]]) path = m[1];
  }
  path ??= Object.keys(files).find((p) => !p.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(p));
  if (!path) throw new ImportError('.mxl 파일 안에서 악보(MusicXML)를 찾지 못했어요.');
  return decodeText(files[path]);
}

async function readBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

/**
 * Imports a user-selected file. Format comes from the extension, falling back to the
 * file's first bytes (a mislabelled file is still read by its content).
 */
export async function importFile(file: File): Promise<Chart> {
  const fileName = file.name;
  const byName = kindFromName(fileName);
  if (byName === 'unsupported') {
    throw new ImportError('PDF·이미지·오디오 파일은 아직 바로 불러올 수 없어요. MusicXML(.musicxml, .mxl)이나 MIDI(.mid) 파일을 올려 주세요.');
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(file);
  } catch (e) {
    throw new ImportError('파일을 읽지 못했어요. 다시 선택해 주세요.', { cause: e });
  }
  if (!bytes.length) throw new ImportError('빈 파일이에요. 다른 파일을 선택해 주세요.');
  const sniffed = sniff(bytes);
  // Content wins when it clearly disagrees with the extension.
  const kind = sniffed ?? byName;
  if (!kind) {
    throw new ImportError('지원하지 않는 파일 형식이에요. MusicXML(.musicxml, .xml, .mxl)이나 MIDI(.mid) 파일을 올려 주세요.');
  }
  const opts: ImportOptions = { fileName };
  switch (kind) {
    case 'midi':
      return chartFromMidi(bytes, opts);
    case 'mxl':
      return chartFromMusicXml(musicXmlFromMxl(bytes), opts);
    case 'xml':
      return chartFromMusicXml(decodeText(bytes), opts);
  }
}
