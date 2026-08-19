/**
 * Client-side image compression.
 *
 * Motivation: the expected workload is ~10,000 images/week at ~2 MB each,
 * which is ~20 GB/week of raw uploads. Phone cameras produce 3–8 MB JPEGs
 * of scenes that are legible at a fraction of that, so compressing in the
 * browser cuts storage, upload time on campus data, and egress — all
 * before a byte reaches Supabase.
 *
 * Deliberately dependency-free: canvas + `toBlob` is already in every
 * browser this PWA supports, and adding browser-image-compression (~12 kB
 * gzipped) to shave a few lines would work against the bundle budget the
 * performance phase just measured.
 *
 * On quality — these are *evidence* photos: a broken pipe, a hostel
 * noticeboard, a screenshot of a portal error. The settings below target
 * "a marker on a whiteboard is still readable", not "looks fine as a
 * thumbnail". Hence 1600px on the long edge and quality 0.82 rather than
 * the 1024/0.7 that generic advice suggests: text in a photographed
 * document is the first thing to dissolve, and an illegible complaint is
 * a useless complaint.
 */

/** Long-edge cap. 1600px keeps photographed text readable. */
export const MAX_DIMENSION = 1600;

/** JPEG/WebP quality. 0.82 is near the knee of the size/artefact curve. */
export const COMPRESSION_QUALITY = 0.82;

/**
 * Files at or below this are passed through untouched.
 *
 * Re-encoding a small image usually makes it *larger* (it has already been
 * compressed once) and always loses a generation of quality for nothing.
 */
export const SKIP_COMPRESSION_BELOW = 300 * 1024; // 300 KB

/**
 * Formats we can re-encode.
 *
 * HEIC is excluded on purpose: Chrome and Firefox cannot decode it, so
 * `drawImage` yields a blank canvas — silently turning a student's photo
 * into a white rectangle. Safari can, but a format that fails invisibly
 * on most browsers is not one to route through canvas. HEIC files upload
 * as-is and are size-checked like everything else.
 */
export const COMPRESSIBLE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Scales dimensions to fit within `max` on the long edge.
 *
 * Pure and exported so the geometry can be tested without a DOM — the
 * off-by-one that produces a 1601px image is not worth discovering in a
 * browser.
 */
export const fitWithin = (width, height, max = MAX_DIMENSION) => {
  if (width <= max && height <= max) return { width, height, scaled: false };

  const ratio = Math.min(max / width, max / height);
  return {
    // Round, then clamp to at least 1: a very wide, very short panorama
    // can round its short edge to 0, and a zero-height canvas throws.
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
};

/**
 * Decides whether a file is worth re-encoding.
 *
 * Separated from the work itself so the policy is inspectable and
 * testable; `compressImage` just obeys it.
 */
export const shouldCompress = (file) => {
  if (!COMPRESSIBLE_TYPES.includes(file.type)) return false;
  if (file.size <= SKIP_COMPRESSION_BELOW) return false;
  return true;
};

/**
 * Picks the output type.
 *
 * PNG is converted to JPEG when it's a photograph, because PNG is
 * lossless and a 4 MB PNG photo stays roughly 4 MB. But PNG screenshots
 * of *text* are exactly where JPEG's ringing artefacts are ugliest, and
 * screenshots are a large share of what students attach. Since we cannot
 * tell a screenshot from a photo without inspecting pixels, PNG is kept
 * as PNG and merely resized — the resize alone recovers most of the size
 * on an oversized screenshot, without smearing the text.
 */
const outputType = (file) => (file.type === 'image/png' ? 'image/png' : 'image/jpeg');

/** Loads a File into an ImageBitmap or HTMLImageElement, whichever exists. */
const loadImage = async (file) => {
  // createImageBitmap is faster and off the main thread where supported,
  // and it honours EXIF orientation when asked — without which photos
  // taken in portrait arrive rotated, a longstanding iOS complaint.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through: Safari < 15 rejects the options bag.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image.'));
    };
    img.src = url;
  });
};

/**
 * Compresses one image, returning a new File plus what it saved.
 *
 * Never throws for compression reasons: if anything goes wrong the
 * original file is returned with `compressed: false`. Losing the
 * optimisation is acceptable; losing the student's evidence because a
 * canvas call failed on some browser is not.
 */
export const compressImage = async (file) => {
  const unchanged = (reason) => ({
    file,
    compressed: false,
    reason,
    originalSize: file.size,
    finalSize: file.size,
    savedBytes: 0,
  });

  if (!shouldCompress(file)) {
    return unchanged(
      COMPRESSIBLE_TYPES.includes(file.type) ? 'already small' : 'format not re-encodable'
    );
  }

  try {
    const image = await loadImage(file);
    const sourceWidth = image.width;
    const sourceHeight = image.height;

    if (!sourceWidth || !sourceHeight) return unchanged('could not read dimensions');

    const { width, height } = fitWithin(sourceWidth, sourceHeight);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return unchanged('canvas unavailable');

    // Better downscaling than the default nearest-ish sampling, which
    // makes small text in screenshots crawl.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, width, height);

    // Release the decoded bitmap promptly — a handful of 12-megapixel
    // images held at once is enough to be killed on a low-end phone.
    if (typeof image.close === 'function') image.close();

    const type = outputType(file);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, type, COMPRESSION_QUALITY)
    );

    // Free the backing store on browsers that keep canvases alive.
    canvas.width = 0;
    canvas.height = 0;

    if (!blob) return unchanged('encoding failed');

    // The honest check. Re-encoding can enlarge an already-optimised
    // file, and uploading our larger version would make compression a
    // pessimisation. Keep whichever is smaller.
    if (blob.size >= file.size) return unchanged('original was already smaller');

    const extension = type === 'image/png' ? 'png' : 'jpg';
    const baseName = file.name.replace(/\.[^./\\]+$/, '') || 'image';

    return {
      file: new File([blob], `${baseName}.${extension}`, {
        type,
        lastModified: Date.now(),
      }),
      compressed: true,
      reason: null,
      originalSize: file.size,
      finalSize: blob.size,
      savedBytes: file.size - blob.size,
      dimensions: { width, height },
      originalDimensions: { width: sourceWidth, height: sourceHeight },
    };
  } catch {
    // Any failure at all: upload the original.
    return unchanged('compression failed');
  }
};

/** Compresses a batch sequentially. */
export const compressAll = async (files) => {
  const results = [];
  // Sequential, not Promise.all: decoding several large images at once
  // spikes memory and is what actually crashes the tab on mid-range
  // Android devices. The wait is short and the picker shows progress.
  for (const file of files) {
    results.push(await compressImage(file));
  }
  return results;
};
