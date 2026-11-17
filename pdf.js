(function () {
  const A4 = [595.276, 841.89];

  function jpegInfo(bytes) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
          components: bytes[i + 9]
        };
      }
      i += 2 + length;
    }
    return null;
  }

  const colorSpace = (components) => (components === 1 ? "/DeviceGray" : components === 4 ? "/DeviceCMYK" : "/DeviceRGB");

  function makePdf(images) {
    const encoder = new TextEncoder();
    const parts = [];
    let size = 0;
    const putBytes = (bytes) => { parts.push(bytes); size += bytes.length; };
    const putText = (text) => putBytes(encoder.encode(text));
    const offsets = [];

    putBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const pageBase = (index) => 3 + index * 3;
    offsets[1] = size;
    putText("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    offsets[2] = size;
    const kids = images.map((_, index) => `${pageBase(index)} 0 R`).join(" ");
    putText(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>\nendobj\n`);

    images.forEach((image, index) => {
      const pageNo = pageBase(index);
      const contentNo = pageNo + 1;
      const imageNo = pageNo + 2;
      const portrait = image.height >= image.width;
      const pageWidth = portrait ? A4[0] : A4[1];
      const pageHeight = portrait ? A4[1] : A4[0];
      const scale = Math.min(pageWidth / image.width, pageHeight / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      const x = (pageWidth - drawWidth) / 2;
      const y = (pageHeight - drawHeight) / 2;
      const content = `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`;

      offsets[pageNo] = size;
      putText(`${pageNo} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /XObject << /Im0 ${imageNo} 0 R >> >> /Contents ${contentNo} 0 R >>\nendobj\n`);

      const contentBytes = encoder.encode(content);
      offsets[contentNo] = size;
      putText(`${contentNo} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
      putBytes(contentBytes);
      putText("endstream\nendobj\n");

      offsets[imageNo] = size;
      putText(`${imageNo} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${colorSpace(image.components)} /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`);
      putBytes(image.bytes);
      putText("\nendstream\nendobj\n");
    });

    const xrefOffset = size;
    const count = 3 + images.length * 3;
    putText(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let n = 1; n < count; n++) putText(`${String(offsets[n] || 0).padStart(10, "0")} 00000 n \n`);
    putText(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    return new Blob(parts, { type: "application/pdf" });
  }

  globalThis.jpegInfo = jpegInfo;
  globalThis.makePdf = makePdf;
})();
