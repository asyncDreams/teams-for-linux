"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const OUTPUTS = [path.join(ROOT, "app", "assets", "icons"), path.join(ROOT, "build", "icons")];
const COLORED_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
const SCALE = 4;

function main() {
  for (const output of OUTPUTS) fs.mkdirSync(output, { recursive: true });
  for (const size of COLORED_SIZES) {
    const png = renderLogo(size, false);
    for (const output of OUTPUTS) {
      const isAppIconDirectory = output.endsWith(path.join("app", "assets", "icons"));
      const name = isAppIconDirectory ? `icon-${size}x${size}.png` : `${size}x${size}.png`;
      // The app runtime uses the historic icon-<size> names while electron-builder
      // reads the plain <size>x<size> names from build/icons.
      if (isAppIconDirectory && ![16, 96, 256].includes(size)) continue;
      fs.writeFileSync(path.join(output, name), png, { mode: 0o644 });
    }
  }

  for (const [name, size, light] of [
    ["icon-monochrome-dark-16x16.png", 16, false],
    ["icon-monochrome-dark-96x96.png", 96, false],
    ["icon-monochrome-light-16x16.png", 16, true],
    ["icon-monochrome-light-96x96.png", 96, true],
  ]) {
    fs.writeFileSync(path.join(ROOT, "app", "assets", "icons", name), renderLogo(size, true, light), { mode: 0o644 });
  }
}

function renderLogo(size, monochrome, light = false) {
  const width = size * SCALE;
  const pixels = new Uint8Array(width * width * 4);
  const color = monochrome ? (light ? [255, 255, 255, 255] : [39, 39, 52, 255]) : null;
  const paint = (x, y, rgba) => {
    if (x < 0 || y < 0 || x >= width || y >= width) return;
    const index = (y * width + x) * 4;
    const sourceAlpha = rgba[3] / 255;
    const destinationAlpha = pixels[index + 3] / 255;
    const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
    if (alpha === 0) return;
    for (let channel = 0; channel < 3; channel += 1) {
      pixels[index + channel] = Math.round((rgba[channel] * sourceAlpha + pixels[index + channel] * destinationAlpha * (1 - sourceAlpha)) / alpha);
    }
    pixels[index + 3] = Math.round(alpha * 255);
  };
  const roundedRect = (left, top, rectWidth, rectHeight, radius, fill) => {
    const minX = Math.floor(left - radius);
    const maxX = Math.ceil(left + rectWidth + radius);
    const minY = Math.floor(top - radius);
    const maxY = Math.ceil(top + rectHeight + radius);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = Math.max(left - x, 0, x - (left + rectWidth));
        const dy = Math.max(top - y, 0, y - (top + rectHeight));
        if (dx * dx + dy * dy <= radius * radius) paint(x, y, fill(x, y));
      }
    }
  };
  const circle = (centerX, centerY, radius, fill) => {
    const minX = Math.floor(centerX - radius);
    const maxX = Math.ceil(centerX + radius);
    const minY = Math.floor(centerY - radius);
    const maxY = Math.ceil(centerY + radius);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if ((x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2) paint(x, y, fill(x, y));
      }
    }
  };
  const bubble = (centerX, centerY, radius, fill, tailDirection) => {
    circle(centerX, centerY, radius, fill);
    const tail = tailDirection === "up"
      ? [[centerX - radius * 0.45, centerY + radius * 0.72], [centerX - radius * 0.05, centerY + radius * 1.45], [centerX + radius * 0.2, centerY + radius * 0.65]]
      : [[centerX - radius * 0.65, centerY - radius * 0.25], [centerX - radius * 1.15, centerY + radius * 0.5], [centerX - radius * 0.2, centerY + radius * 0.3]];
    for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius * 1.5); y += 1) {
      for (let x = Math.floor(centerX - radius * 1.3); x <= Math.ceil(centerX + radius); x += 1) {
        if (insideTriangle(x, y, tail[0], tail[1], tail[2])) paint(x, y, fill(x, y));
      }
    }
  };
  const pixelScale = width;
  const gradient = (start, end, opacity = 255) => (x) => {
    const t = Math.max(0, Math.min(1, x / pixelScale));
    return [
      Math.round(start[0] + (end[0] - start[0]) * t),
      Math.round(start[1] + (end[1] - start[1]) * t),
      Math.round(start[2] + (end[2] - start[2]) * t),
      opacity,
    ];
  };
  const tFill = monochrome ? () => color : (x) => gradient([76, 77, 190], [43, 138, 198])(x);
  const backBubble = monochrome ? () => color : () => [132, 113, 232, 220];
  const frontBubble = monochrome ? () => color : () => [36, 153, 184, 235];

  // The mark is intentionally transparent: a rounded T and two overlapping
  // conversation bubbles remain recognizable at tray size without recreating
  // Microsoft's square logo or using its artwork.
  roundedRect(width * 0.18, width * 0.22, width * 0.56, width * 0.14, width * 0.055, tFill);
  roundedRect(width * 0.39, width * 0.29, width * 0.14, width * 0.5, width * 0.055, tFill);
  bubble(width * 0.72, width * 0.34, width * 0.13, backBubble, "down");
  bubble(width * 0.76, width * 0.61, width * 0.17, frontBubble, "up");
  if (!monochrome) {
    circle(width * 0.76, width * 0.58, width * 0.035, () => [255, 255, 255, 220]);
    roundedRect(width * 0.695, width * 0.64, width * 0.13, width * 0.025, width * 0.012, () => [255, 255, 255, 220]);
  }

  return encodePng(downsample(pixels, width, size));
}

function insideTriangle(x, y, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([x, y], a, b);
  const d2 = sign([x, y], b, c);
  const d3 = sign([x, y], c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function downsample(source, sourceSize, targetSize) {
  const result = Buffer.alloc(targetSize * targetSize * 4);
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const sums = [0, 0, 0, 0];
      for (let sy = 0; sy < SCALE; sy += 1) {
        for (let sx = 0; sx < SCALE; sx += 1) {
          const index = ((y * SCALE + sy) * sourceSize + x * SCALE + sx) * 4;
          for (let channel = 0; channel < 4; channel += 1) sums[channel] += source[index + channel];
        }
      }
      const output = (y * targetSize + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) result[output + channel] = Math.round(sums[channel] / (SCALE * SCALE));
    }
  }
  return result;
}

function encodePng(rgba) {
  const size = Math.sqrt(rgba.length / 4);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0;
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.from([size >>> 24, size >>> 16 & 255, size >>> 8 & 255, size & 255, size >>> 24, size >>> 16 & 255, size >>> 8 & 255, size & 255, 8, 6, 0, 0, 0])),
    pngChunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  const crc = crc32(Buffer.concat([typeBuffer, data]));
  const footer = Buffer.alloc(4);
  footer.writeUInt32BE(crc, 0);
  return Buffer.concat([header, typeBuffer, data, footer]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}

main();
