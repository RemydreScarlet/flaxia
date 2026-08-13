export type ZipGameType = 'html5' | 'dos' | null;

export async function detectZipType(file: File): Promise<ZipGameType> {
  try {
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    let eocdOffset = buffer.byteLength - 22;
    while (eocdOffset >= 0) {
      if (view.getUint32(eocdOffset, true) === 0x06054b50) break;
      eocdOffset--;
    }
    if (eocdOffset < 0) return null;
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const numEntries = view.getUint16(eocdOffset + 10, true);
    let hasIndexHtml = false;
    let hasExe = false;
    let offset = cdOffset;
    for (let i = 0; i < numEntries; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      let name = '';
      for (let j = 0; j < nameLen; j++) name += String.fromCharCode(view.getUint8(offset + 46 + j));
      const lower = name.toLowerCase();
      const fileName = lower.split('/').pop() || '';
      if (fileName === 'index.html' || fileName === 'index.htm') hasIndexHtml = true;
      if (fileName.endsWith('.exe') || fileName.endsWith('.bat') || fileName.endsWith('.com')) hasExe = true;
      offset += 46 + nameLen + extraLen + commentLen;
    }
    if (hasIndexHtml) return 'html5';
    if (hasExe) return 'dos';
    return null;
  } catch {
    return null;
  }
}
