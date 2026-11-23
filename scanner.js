"use strict";

const MAX_BYTES = 5_000_000;
const MAX_PAGES = 30;
const fullFrame = () => [[0, 0], [1, 0], [1, 1], [0, 1]];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function validQuad(points) {
  return points.every((point, i) => cross(point, points[(i + 1) % 4], points[(i + 2) % 4]) > .003);
}

function hull(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (sequence) => {
    const result = [];
    for (const point of sequence) {
      while (result.length > 1 && cross(result.at(-2), result.at(-1), point) <= 0) result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return half(points).concat(half(points.reverse()));
}

function findPaper(rgba, width, height) {
  if (width < 12 || height < 12) return null;
  const length = width * height;
  const gray = new Uint8Array(length);
  const histogram = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const value = (77 * rgba[i * 4] + 150 * rgba[i * 4 + 1] + 29 * rgba[i * 4 + 2]) >> 8;
    gray[i] = value;
    histogram[value]++;
    sum += value;
  }

  // Separate light paper from its background with Otsu's between-class variance.
  let lowCount = 0, lowSum = 0, best = 0, threshold = 0;
  for (let value = 0; value < 255; value++) {
    lowCount += histogram[value];
    lowSum += histogram[value] * value;
    if (!lowCount || lowCount === length) continue;
    const highCount = length - lowCount;
    const difference = (sum - lowSum) / highCount - lowSum / lowCount;
    const score = lowCount * highCount * difference ** 2;
    if (score > best) {
      best = score;
      threshold = value;
    }
  }
  const above = (value) => value > Math.max(85, threshold);
  const mask = new Uint8Array(length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      // A majority filter bridges small lettering and suppresses stray bright pixels.
      const count = Number(above(gray[i])) + Number(above(gray[i - 1])) +
        Number(above(gray[i + 1])) + Number(above(gray[i - width])) + Number(above(gray[i + width]));
      mask[i] = count >= 3;
    }
  }

  const queue = new Int32Array(length);
  let selected = null, largest = 0;
  for (let start = width + 1; start < length - width - 1; start++) {
    if (!mask[start]) continue;
    mask[start] = 0;
    queue[0] = start;
    let tail = 1, border = 0;
    const left = new Int32Array(height).fill(width);
    const right = new Int32Array(height).fill(-1);
    for (let head = 0; head < tail; head++) {
      const index = queue[head];
      const y = Math.floor(index / width), x = index % width;
      left[y] = Math.min(left[y], x);
      right[y] = Math.max(right[y], x);
      if (x === 1 || y === 1 || x === width - 2 || y === height - 2) border++;
      for (const nearby of [index - 1, index + 1, index - width, index + width]) {
        if (!mask[nearby]) continue;
        mask[nearby] = 0;
        queue[tail++] = nearby;
      }
    }
    if (tail < length * .11 || border > (width + height) * .38 || tail <= largest) continue;
    const edges = [];
    for (let y = 1; y < height - 1; y++) {
      if (right[y] < 0) continue;
      edges.push([left[y], y], [right[y], y]);
    }
    const corners = hull(edges);
    // Reduce the convex outline to four vertices while keeping the strongest corners.
    while (corners.length > 4) {
      let remove = 0, least = Infinity;
      for (let i = 0; i < corners.length; i++) {
        const area = cross(corners[(i + corners.length - 1) % corners.length], corners[i], corners[(i + 1) % corners.length]);
        if (area < least) {
          least = area;
          remove = i;
        }
      }
      corners.splice(remove, 1);
    }
    if (corners.length !== 4) continue;
    const normalized = corners.map(([x, y]) => [x / (width - 1), y / (height - 1)]);
    const top = normalized.reduce((bestIndex, p, i) => p[0] + p[1] < normalized[bestIndex][0] + normalized[bestIndex][1] ? i : bestIndex, 0);
    const ordered = normalized.slice(top).concat(normalized.slice(0, top));
    if (!validQuad(ordered)) continue;
    const area = (cross(ordered[0], ordered[1], ordered[2]) + cross(ordered[0], ordered[2], ordered[3])) / 2;
    if (area < .14 || area > .97 || tail / (area * length) < .57) continue;
    selected = ordered;
    largest = tail;
  }
  return refinePaperEdges(gray, width, height, selected);
}

function fitPaperSide(gray, width, height, vertical, reverse) {
  const across = vertical ? width : height;
  const along = vertical ? height : width;
  const inset = Math.max(2, Math.round(across * .009));
  const readings = [];
  const get = (x, y) => {
    const normal = reverse ? across - 1 - x : x;
    return vertical ? gray[y * width + normal] : gray[normal * width + y];
  };

  for (let step = 0; step < 27; step++) {
    const run = .14 + .72 * step / 26;
    const y = Math.round(run * (along - 1));
    const candidates = [];
    for (let x = inset * 2; x < across * .43; x++) {
      // A paper edge has a sustained jump toward the inside. Averaging strips
      // discounts individual letters, reflections and compression noise.
      const outer = get(x - inset, y) + get(x - 2 * inset, y) + get(x - 2 * inset, y - 1);
      const inner = get(x + inset, y) + get(x + 2 * inset, y) + get(x + 2 * inset, y + 1);
      const contrast = (inner - outer) / 3;
      if (contrast < 15 || inner < 345) continue;
      candidates.push({pos: x / (across - 1), weight: Math.min(contrast, 70)});
    }
    candidates.sort((a, b) => b.weight - a.weight);
    const peaks = [];
    for (const point of candidates) {
      if (peaks.some(other => Math.abs(other.pos - point.pos) < .022)) continue;
      peaks.push(point);
      if (peaks.length === 4) break;
    }
    readings.push({run, peaks});
  }

  let best = null;
  let bestScore = 0;
  const tolerance = .021;
  for (let i = 0; i < readings.length; i++) {
    for (let j = i + 10; j < readings.length; j++) {
      const start = readings[i], end = readings[j];
      for (const a of start.peaks) {
        for (const b of end.peaks) {
          const slope = (b.pos - a.pos) / (end.run - start.run);
          const offset = a.pos - slope * start.run;
          if (Math.abs(slope) > .47 || Math.min(offset, offset + slope) < -.11) continue;
          const support = [];
          let score = 0;
          for (const row of readings) {
            const estimated = offset + slope * row.run;
            const match = row.peaks.find(p => Math.abs(p.pos - estimated) <= tolerance);
            if (!match) continue;
            score += 1 + match.weight / 80 - Math.abs(match.pos - estimated) / tolerance * .35;
            support.push([row.run, match.pos]);
          }
          if (support.length < 12 || support.at(-1)[0] - support[0][0] < .4) continue;
          // When two lines have similar support, prefer the outer paper boundary.
          score -= 12 * (offset + slope * .5);
          if (score <= bestScore) continue;
          best = support;
          bestScore = score;
        }
      }
    }
  }
  if (!best) return null;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (const [x, y] of best) {
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const count = best.length;
  const slope = (count * sumXY - sumX * sumY) / (count * sumXX - sumX * sumX);
  const offset = (sumY - slope * sumX) / count;
  return reverse ? [1 - offset, -slope] : [offset, slope];
}

function refinePaperEdges(gray, width, height, fallback) {
  const frame = fallback || fullFrame();
  const sides = [fitPaperSide(gray, width, height, false, false),
    fitPaperSide(gray, width, height, true, true),
    fitPaperSide(gray, width, height, false, true),
    fitPaperSide(gray, width, height, true, false)];
  if (!fallback && sides.filter(Boolean).length < 3) return null;
  for (let i = 0; i < 4; i++) {
    if (!sides[i] || !fallback) continue;
    const xAxis = i % 2 === 0;
    const axis = xAxis ? 0 : 1, normal = 1 - axis;
    const a = frame[i], b = frame[(i + 1) % 4];
    // Use the mask where it already reaches a realistic edge. A conflicting
    // interior line can be a crease, print or the boundary of a hard shadow.
    const displacement = ([x,y]) => Math.abs(sides[i][0] + sides[i][1] * (axis === 0 ? x : y) - (normal === 0 ? x : y));
    if (displacement(a) > .095 || displacement(b) > .095) sides[i] = null;
  }
  const edge = (i) => {
    if (sides[i]) return sides[i];
    const axis = i % 2, normal = 1 - axis;
    const a = frame[i], b = frame[(i + 1) % 4];
    const slope = (b[normal] - a[normal]) / (b[axis] - a[axis]);
    return [a[normal] - slope * a[axis], slope];
  };
  const intersection = ([v, vy], [h, hx]) => {
    const y = (h + hx * v) / (1 - hx * vy);
    return [clamp(v + vy * y, 0, 1), clamp(y, 0, 1)];
  };
  const [top, right, bottom, left] = [0, 1, 2, 3].map(edge);
  const corners = [intersection(left, top), intersection(right, top),
    intersection(right, bottom), intersection(left, bottom)];
  const area = (cross(corners[0], corners[1], corners[2]) + cross(corners[0], corners[2], corners[3])) / 2;
  return area > .16 && area < .98 && validQuad(corners) ? corners : fallback;
}



function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function releaseCanvas(canvas) {
  canvas.width = canvas.height = 1;
  canvas.getContext("2d").clearRect(0, 0, 1, 1);
}

async function loadPhoto(file, limit, turns = 0) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = makeCanvas(turns % 2 ? height : width, turns % 2 ? width : height);
    const ctx = canvas.getContext("2d", {willReadFrequently: true});
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(turns * Math.PI / 2);
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function detectOnCanvas(source) {
  const scale = Math.min(1, 420 / Math.max(source.width, source.height));
  const small = makeCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)));
  const ctx = small.getContext("2d", {willReadFrequently: true});
  ctx.drawImage(source, 0, 0, small.width, small.height);
  const paper = findPaper(ctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height);
  releaseCanvas(small);
  return paper;
}

function perspective(points) {
  const [a, b, c, d] = points;
  const dx1 = b[0] - c[0], dx2 = d[0] - c[0], dx3 = a[0] - b[0] + c[0] - d[0];
  const dy1 = b[1] - c[1], dy2 = d[1] - c[1], dy3 = a[1] - b[1] + c[1] - d[1];
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return [b[0] - a[0] + g * b[0], d[0] - a[0] + h * d[0], a[0],
    b[1] - a[1] + g * b[1], d[1] - a[1] + h * d[1], a[1], g, h];
}

function straighten(source, quad, limit) {
  const points = quad.map(([x, y]) => [x * (source.width - 1), y * (source.height - 1)]);
  const [tl, tr, br, bl] = points;
  const rawWidth = Math.max(distance(tl, tr), distance(bl, br));
  const rawHeight = Math.max(distance(tl, bl), distance(tr, br));
  const scale = Math.min(1, limit / Math.max(1, rawWidth, rawHeight));
  const width = Math.max(1, Math.round(rawWidth * scale));
  const height = Math.max(1, Math.round(rawHeight * scale));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const frame = fullFrame();
  if (quad.every(([x, y], i) => x === frame[i][0] && y === frame[i][1]) || source.width < 2 || source.height < 2) {
    ctx.drawImage(source, 0, 0, width, height);
    return canvas;
  }
  const input = source.getContext("2d").getImageData(0, 0, source.width, source.height).data;
  const output = ctx.createImageData(width, height);
  const [a,b,c,d,e,f,g,h] = perspective(points);
  for (let y = 0; y < height; y++) {
    const v = (y + .5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + .5) / width;
      const div = g * u + h * v + 1;
      const sx = clamp((a*u + b*v + c) / div, 0, source.width - 1);
      const sy = clamp((d*u + e*v + f) / div, 0, source.height - 1);
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(source.width - 1, x0 + 1), y1 = Math.min(source.height - 1, y0 + 1);
      const wx = sx - x0, wy = sy - y0;
      const topL = (y0 * source.width + x0) * 4, topR = (y0 * source.width + x1) * 4;
      const botL = (y1 * source.width + x0) * 4, botR = (y1 * source.width + x1) * 4;
      const dest = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        output.data[dest + channel] = (input[topL + channel] * (1-wx) + input[topR + channel] * wx) * (1-wy) +
          (input[botL + channel] * (1-wx) + input[botR + channel] * wx) * wy;
      }
      output.data[dest + 3] = 255;
    }
  }
  ctx.putImageData(output, 0, 0);
  return canvas;
}

function cleanPaperHighlights(canvas) {
  const ctx = canvas.getContext("2d");
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    const low = Math.min(data[i], data[i + 1], data[i + 2]);
    const high = Math.max(data[i], data[i + 1], data[i + 2]);
    // Clean near-white paper texture while retaining colored and dark markings.
    if (low < 216 || high - low > 12) continue;
    const lift = Math.min(255 - high, Math.round((low - 216) * .28));
    data[i] += lift;
    data[i + 1] += lift;
    data[i + 2] += lift;
  }
  ctx.putImageData(pixels, 0, 0);
}

async function compressPage(page, budget, qualityMode) {
  const preset = qualityMode === "light" ? {edge: 1450, qualities: [.64, .54, .46]} :
    {edge: 1850, qualities: [.76, .66, .56, .46]};
  const source = await loadPhoto(page.file, 2500, page.turns);
  let documentCanvas;
  try {
    documentCanvas = straighten(source, page.quad, preset.edge);
  } finally {
    releaseCanvas(source);
  }
  try {
    cleanPaperHighlights(documentCanvas);
    let canvas = documentCanvas;
    try {
      while (true) {
        for (const quality of preset.qualities) {
          const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
          if (!jpeg) throw new Error("JPEG encoding failed");
          if (jpeg.size <= budget) return {jpeg, width: canvas.width, height: canvas.height};
        }

        const edge = Math.max(canvas.width, canvas.height);
        if (edge <= 240) break;
        const scale = Math.max(240, Math.floor(edge * .8)) / edge;
        const smaller = makeCanvas(Math.max(1, Math.round(canvas.width * scale)), Math.max(1, Math.round(canvas.height * scale)));
        if (canvas !== documentCanvas) releaseCanvas(canvas);
        canvas = smaller;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(documentCanvas, 0, 0, canvas.width, canvas.height);
      }
      throw new Error("Page cannot fit within the size cap");
    } finally {
      if (canvas !== documentCanvas) releaseCanvas(canvas);
    }
  } finally {
    releaseCanvas(documentCanvas);
  }
}

function makePdf(images) {
  const parts = [];
  const offsets = [0];
  let size = 0;
  const write = (part) => {
    parts.push(part);
    size += typeof part === "string" ? part.length : part.size;
  };
  const begin = (id) => {
    offsets[id] = size;
    write(id + " 0 obj\n");
  };
  const end = () => write("\nendobj\n");
  write("%PDF-1.4\n");
  begin(1);
  write("<< /Type /Catalog /Pages 2 0 R >>");
  end();
  begin(2);
  const kids = images.map((_, i) => (3 + i * 3) + " 0 R").join(" ");
  write("<< /Type /Pages /Count " + images.length + " /Kids [" + kids + "] >>");
  end();
  images.forEach(({jpeg, width, height}, i) => {
    const page = 3 + i * 3;
    const factor = Math.min(595 / Math.min(width, height), 842 / Math.max(width, height));
    const w = (width * factor).toFixed(2), h = (height * factor).toFixed(2);
    begin(page);
    write("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + w + " " + h + "] /Resources << /XObject << /Im " + (page + 1) + " 0 R >> >> /Contents " + (page + 2) + " 0 R >>");
    end();
    begin(page + 1);
    write("<< /Type /XObject /Subtype /Image /Width " + width + " /Height " + height + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpeg.size + " >>\nstream\n");
    write(jpeg);
    write("\nendstream");
    end();
    begin(page + 2);
    const stream = "q " + w + " 0 0 " + h + " 0 0 cm /Im Do Q\n";
    write("<< /Length " + stream.length + " >>\nstream\n" + stream + "endstream");
    end();
  });
  const start = size;
  write("xref\n0 " + offsets.length + "\n0000000000 65535 f \n");
  for (const offset of offsets.slice(1)) write(String(offset).padStart(10, "0") + " 00000 n \n");
  write("trailer\n<< /Size " + offsets.length + " /Root 1 0 R >>\nstartxref\n" + start + "\n%%EOF\n");
  return new Blob(parts, {type: "application/pdf"});
}

function startScanner() {
  const $ = (id) => document.getElementById(id);
  const pages = [];
  const formatter = new Intl.NumberFormat("ar-EG", {maximumFractionDigits: 2});
  let active = -1, busy = false, drag = null, output = null, outputUrl = null;
  const photo = $("photo"), outline = $("outline"), video = $("live");
  const qualityInputs = [...document.querySelectorAll('[name="quality"]')];
  let pending = null, editCrop = false, capturing = false, stream = null, request = 0;
  const currentPage = () => pending || pages[active];
  const defaultName = () => {
    const now = new Date();
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, "0")).join("-");
    return "مستند-" + date;
  };
  $("filename").value = defaultName();

  function notice(message = "") {
    $("notice").textContent = message;
    $("notice").hidden = !message;
  }

  function setBusy(value) {
    busy = value;
    for (const id of ["auto","full","rotate","remove","build","filename","share","toggle-crop",
      "accept-next","accept-stop","retake","native-camera"]) $(id).disabled = value;
    $("take").disabled = $("pick").disabled = value || capturing || Boolean(pending);
    $("snap").disabled = value || !stream || video.readyState < 2;
    for (const input of qualityInputs) input.disabled = value;
    for (const button of $("pages").children) button.disabled = value;
  }


  function filename() {
    const name = $("filename").value.trim().replace(/(?:\.pdf)+$/gi, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^[. ]+|[. ]+$/g, "");
    return (name || defaultName()) + ".pdf";
  }

  function invalidate() {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = output = null;
    $("download").removeAttribute("href");
    $("result").hidden = true;
  }

  function redraw() {
    const bounds = photo.getBoundingClientRect();
    outline.style.width = bounds.width + "px";
    outline.style.height = bounds.height + "px";
    const ctx = outline.getContext("2d");
    ctx.clearRect(0, 0, outline.width, outline.height);
    const positions = currentPage().quad.map(([x,y]) => [x * (outline.width - 1), y * (outline.height - 1)]);
    const trace = () => {
      ctx.moveTo(...positions[0]);
      for (const p of positions.slice(1)) ctx.lineTo(...p);
      ctx.closePath();
    };
    const unit = outline.width / Math.max(1, outline.getBoundingClientRect().width);
    ctx.beginPath();
    ctx.rect(0, 0, outline.width, outline.height);
    trace();
    ctx.fillStyle = "#080d1c9c";
    ctx.fill("evenodd");
    ctx.beginPath();
    trace();
    ctx.strokeStyle = "#72ecc4";
    ctx.lineWidth = 2.5 * unit;
    ctx.stroke();
    for (const [x,y] of positions) {
      ctx.beginPath();
      ctx.arc(x, y, 7 * unit, 0, Math.PI * 2);
      ctx.fillStyle = "#72ecc4";
      ctx.fill();
      ctx.strokeStyle = "#10251f";
      ctx.lineWidth = 2 * unit;
      ctx.stroke();
    }
  }

  function showPage() {
    const page = currentPage();
    $("capture-area").hidden = !capturing || Boolean(pending);
    $("editor").hidden = !page || (capturing && !pending);
    $("export").hidden = active < 0 || Boolean(pending) || capturing;
    $("review-heading").hidden = $("review-buttons").hidden = !pending;
    $("edit-title").textContent = pending ? "راجع اللقطة" : "حدود الورقة";
    $("pages").hidden = Boolean(pending);
    $("remove").hidden = Boolean(pending);
    $("accept-next").hidden = pages.length + 1 >= MAX_PAGES;
    $("capture-count").textContent = "صوّر صفحة " + formatter.format(pages.length + 1) + " من حد ٣٠ صفحة";
    $("review-count").textContent = "الصفحة " + formatter.format(pages.length + 1) + " · بعد المراجعة تتضاف للملف";
    if (!page) {
      releaseCanvas(photo);
      releaseCanvas(outline);
      $("pages").replaceChildren();
      return;
    }
    if (!pending && !capturing) {
      $("pages").replaceChildren(...pages.map((_, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "subtle";
        button.textContent = "صفحة " + formatter.format(index + 1);
        button.setAttribute("aria-current", String(index === active));
        button.disabled = busy;
        button.addEventListener("click", () => {
          active = index;
          showPage();
          $("pages").children[index].focus({preventScroll: true});
        });
        return button;
      }));
      $("pages").children[active].scrollIntoView({block:"nearest", inline:"nearest"});
    }
    if ($("editor").hidden) return;

    const cropped = pending && !editCrop;
    let preview = page.preview;
    if (cropped) preview = straighten(page.preview, page.quad, 720);
    photo.width = outline.width = preview.width;
    photo.height = outline.height = preview.height;
    photo.getContext("2d").drawImage(preview, 0, 0);
    if (cropped) releaseCanvas(preview);
    outline.hidden = $("auto").hidden = $("full").hidden = Boolean(cropped);
    $("toggle-crop").textContent = editCrop ? "شوف بعد القص" : "ظبّط القص";
    if (!cropped) redraw();
    cropHint();
  }

  function cropHint() {
    $("crop-hint").textContent = pending && !editCrop ? "دي معاينة الصفحة اللي هتتحفظ في الـPDF." :
      currentPage().detected ? "اسحب الزوايا لو محتاج تعدّل القص." :
        "اسحب الزوايا على حواف الورقة عشان تحدّد القص.";
  }

  async function preparePage(file) {
    const preview = await loadPhoto(file, 720);
    const detected = detectOnCanvas(preview);
    return {file, preview, quad: detected || fullFrame(), detected: Boolean(detected), turns: 0};
  }


  async function add(files) {
    if (busy || !files.length) return;
    const remaining = MAX_PAGES - pages.length;
    if (!remaining) {
      notice("الملف الواحد بياخد لحد ٣٠ صفحة.");
      return;
    }
    setBusy(true);
    notice("بنفتح الصور ونحدّد الحواف…");
    let failed = 0;
    const first = pages.length;
    try {
      for (const file of files.slice(0, remaining)) {
        try {
          pages.push(await preparePage(file));
        } catch {
          failed++;
        }
      }
      if (pages.length > first) {
        active = first;
        invalidate();
        showPage();
      }
      const messages = [];
      if (failed) messages.push("في صور مقدرناش نفتحها. لو الصورة HEIC افتح الصفحة في Safari على iOS 17 أو أحدث، أو جرّب JPG.");
      if (files.length > remaining) messages.push("اتضافت أول " + formatter.format(remaining) + " صورة بس. حد الملف ٣٠ صفحة.");
      notice(messages.join(" "));
    } finally {
      setBusy(false);
    }
  }

  function cameraStatus(message, fallback = false) {
    $("camera-status").textContent = message;
    $("camera-status").hidden = !message;
    $("native-camera").hidden = !fallback;
    video.hidden = $("snap").hidden = fallback;
  }

  function releaseStream() {
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    video.srcObject = null;
  }

  function stopCapture() {
    capturing = false;
    request++;
    releaseStream();
    showPage();
    setBusy(false);
  }

  async function showCamera() {
    if (busy || pending) return;
    if (pages.length >= MAX_PAGES) {
      notice("الملف الواحد بياخد لحد ٣٠ صفحة.");
      return;
    }
    capturing = true;
    notice();
    showPage();
    $("capture-area").scrollIntoView({block:"start"});
    if (stream?.active) {
      void video.play().catch(() => cameraStatus("الكاميرا ما اشتغلتش هنا. جرّب كاميرا التليفون.", true));
      setBusy(false);
      return;
    }

    const opening = ++request;
    setBusy(true);
    cameraStatus("بنفتح الكاميرا…");
    try {
      const camera = await navigator.mediaDevices?.getUserMedia({
        audio: false, video: {facingMode: {ideal: "environment"}, width: {ideal: 1920}, height: {ideal: 1920}}
      });
      if (!camera) throw new Error("Camera unavailable");
      if (opening !== request) {
        for (const track of camera.getTracks()) track.stop();
        return;
      }
      stream = camera;
      for (const track of camera.getVideoTracks()) track.addEventListener("ended", () => {
        if (stream !== camera) return;
        releaseStream();
        cameraStatus("الكاميرا وقفت. كمّل من كاميرا التليفون.", true);
        setBusy(false);
      });
      video.srcObject = camera;
      await video.play();
      if (opening === request) cameraStatus("");
    } catch {
      if (opening === request) {
        releaseStream();
        cameraStatus("الكاميرا ما فتحتش هنا. تقدر تصوّر بكاميرا التليفون.", true);
      }
    } finally {
      if (opening === request) setBusy(false);
    }
  }

  async function reviewCapture(file) {
    if (busy || pending || !capturing) return;
    const opening = request;
    setBusy(true);
    try {
      const page = await preparePage(file);
      if (opening !== request) {
        releaseCanvas(page.preview);
        return;
      }
      pending = page;
      editCrop = !page.detected;
      showPage();
      $("editor").scrollIntoView({block:"start"});
      if (!page.detected) notice("الحواف مش واضحة. ظبّط الزوايا قبل ما تقبل الصفحة.");
    } catch {
      if (opening === request) cameraStatus("الصورة ما اتفتحتش. جرّب تصوّر تاني.", !stream);
    } finally {
      if (opening === request) setBusy(false);
    }
  }

  $("take").addEventListener("click", showCamera);
  $("close-camera").addEventListener("click", stopCapture);
  $("native-camera").addEventListener("click", () => $("camera").click());
  $("camera").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) void reviewCapture(file);
  });
  $("pick").addEventListener("click", () => $("library").click());
  $("library").addEventListener("change", (event) => {
    const files = Array.from(event.target.files);
    event.target.value = "";
    void add(files);
  });
  video.addEventListener("loadeddata", () => {
    if (!busy) $("snap").disabled = !stream || video.readyState < 2;
  });
  $("snap").addEventListener("click", async () => {
    if (busy || pending || !stream || video.readyState < 2) return;
    const opening = request;
    const scale = Math.min(1, 2500 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = makeCanvas(Math.max(1, Math.round(video.videoWidth * scale)),
      Math.max(1, Math.round(video.videoHeight * scale)));
    setBusy(true);
    try {
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .93));
      if (opening !== request) return;
      if (!jpeg) throw new Error("Capture failed");
      setBusy(false);
      await reviewCapture(new File([jpeg], "scan.jpg", {type:"image/jpeg"}));
    } catch {
      if (opening === request) cameraStatus("اللقطة ما اتاخدتش. جرّب تاني.");
    } finally {
      releaseCanvas(canvas);
      if (opening === request) setBusy(false);
    }
  });

  function resumeCapture() {
    notice();
    showPage();
    $("capture-area").scrollIntoView({block:"start"});
    if (stream) {
      void video.play().catch(() => cameraStatus("الكاميرا وقفت. كمّل من كاميرا التليفون.", true));
    } else {
      $("camera").click();
    }
    setBusy(false);
  }

  function acceptCapture(next) {
    if (busy || !pending) return;
    pages.push(pending);
    active = pages.length - 1;
    pending = null;
    invalidate();
    if (next && pages.length < MAX_PAGES) {
      resumeCapture();
    } else {
      notice();
      stopCapture();
      $("export").scrollIntoView({block:"nearest"});
    }
  }

  $("accept-next").addEventListener("click", () => acceptCapture(true));
  $("accept-stop").addEventListener("click", () => acceptCapture(false));
  $("retake").addEventListener("click", () => {
    if (busy || !pending) return;
    releaseCanvas(pending.preview);
    pending = null;
    resumeCapture();
  });
  $("toggle-crop").addEventListener("click", () => {
    editCrop = !editCrop;
    showPage();
  });
  window.addEventListener("pagehide", () => {
    releaseStream();
    request++;
    if (!pending) capturing = false;
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    if (pending) cameraStatus("كمّل من كاميرا التليفون.", true);
    showPage();
    setBusy(false);
  });


  function setQuad(points) {
    currentPage().quad = points;
    currentPage().detected = true;
    cropHint();
    if (!pending) invalidate();
    redraw();
  }

  $("auto").addEventListener("click", () => {
    const found = detectOnCanvas(currentPage().preview);
    if (found) setQuad(found);
    notice(found ? "" : "الحواف مش واضحة. اسحب الأربع زوايا عشان تحدّد الورقة.");
  });
  $("full").addEventListener("click", () => {
    notice();
    setQuad(fullFrame());
  });
  $("rotate").addEventListener("click", () => {
    const page = currentPage();
    const next = makeCanvas(page.preview.height, page.preview.width);
    const ctx = next.getContext("2d");
    ctx.translate(next.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(page.preview, 0, 0);
    releaseCanvas(page.preview);
    page.preview = next;
    page.turns = (page.turns + 1) % 4;
    page.quad = [page.quad[3], ...page.quad.slice(0, 3)].map(([x,y]) => [1-y,x]);
    if (!pending) invalidate();
    showPage();
  });
  $("remove").addEventListener("click", () => {
    releaseCanvas(pages[active].preview);
    pages.splice(active, 1);
    active = Math.min(active, pages.length - 1);
    invalidate();
    notice();
    showPage();
  });

  function pointer(event) {
    const rect = outline.getBoundingClientRect();
    return [clamp((event.clientX - rect.left) / rect.width, 0, 1), clamp((event.clientY - rect.top) / rect.height, 0, 1)];
  }

  outline.addEventListener("pointerdown", (event) => {
    if (busy || drag) return;
    const position = pointer(event);
    const rect = outline.getBoundingClientRect();
    const distances = currentPage().quad.map(([x,y]) => Math.hypot((x-position[0])*rect.width,(y-position[1])*rect.height));
    const closest = Math.min(...distances);
    if (closest > 34) return;
    drag = {id: event.pointerId, index: distances.indexOf(closest)};
    outline.setPointerCapture(event.pointerId);
  });

  outline.addEventListener("pointermove", (event) => {
    if (busy || !drag || drag.id !== event.pointerId) return;
    const quad = currentPage().quad.slice();
    quad[drag.index] = pointer(event);
    if (validQuad(quad)) setQuad(quad);
  });
  outline.addEventListener("lostpointercapture", () => { drag = null; });
  window.addEventListener("resize", () => { if (currentPage() && !$("editor").hidden && !outline.hidden) redraw(); });

  for (const input of qualityInputs) input.addEventListener("change", invalidate);

  $("filename").addEventListener("input", () => { if (output) $("download").download = filename(); });

  $("build").addEventListener("click", async () => {
    if (busy || active < 0 || pending || capturing) return;
    invalidate();
    setBusy(true);
    try {
      const images = [];
      const qualityMode = qualityInputs.find(input => input.checked).value;
      let remaining = MAX_BYTES - 4096 - pages.length * 750;
      for (const page of pages) {
        notice("بنضغط صفحة " + formatter.format(images.length + 1) + " من " + formatter.format(pages.length) + "…");
        const image = await compressPage(page, Math.floor(remaining / (pages.length - images.length)), qualityMode);
        images.push(image);
        remaining -= image.jpeg.size;
      }
      const pdf = makePdf(images);
      if (pdf.size > MAX_BYTES) throw new Error("PDF exceeds size cap");
      output = pdf;
      outputUrl = URL.createObjectURL(pdf);
      $("download").href = outputUrl;
      $("download").download = filename();
      const size = pdf.size >= 1_000_000 ? formatter.format(pdf.size / 1_000_000) + " ميجا" : formatter.format(pdf.size / 1000) + " كيلوبايت";
      const file = new File([pdf], filename(), {type: "application/pdf"});
      const canShare = matchMedia("(any-pointer: coarse)").matches &&
        typeof navigator.share === "function" && navigator.canShare?.({files: [file]}) === true;
      $("share").hidden = $("share-hint").hidden = !canShare;
      $("share-hint").textContent = "اختار واتساب من قائمة المشاركة.";
      $("size").textContent = "الملف جاهز · " + size;
      $("result").hidden = false;
      notice();
      $("result").scrollIntoView({block: "nearest"});
    } catch {
      notice("الـPDF متجهّزش. جرّب تفتح الصور من جديد أو قلّل عدد الصفحات.");
    } finally {
      setBusy(false);
    }
  });

  $("share").addEventListener("click", async () => {
    if (!output) return;
    const file = new File([output], filename(), {type: "application/pdf"});
    const data = {files: [file]};
    if (!navigator.share || !navigator.canShare?.(data)) {
      $("share-hint").textContent = "افتح الصفحة في Safari، أو احفظ الـPDF وشاركه من تطبيق الملفات.";
      return;
    }
    try {
      await navigator.share(data);
    } catch (error) {
      if (error.name !== "AbortError") {
        $("share-hint").textContent = "احفظ الـPDF وشاركه من تطبيق الملفات لو المشاركة هنا ما فتحتش.";
      }
    }
  });
}

if (typeof document !== "undefined") startScanner();
