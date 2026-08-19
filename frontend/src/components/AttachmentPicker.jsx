/**
 * Image picker with local previews and client-side compression.
 *
 * Files are held here and uploaded by the parent on submit, so a
 * cancelled form doesn't leave orphans in Storage.
 *
 * Preview URLs are revoked on removal and unmount — object URLs leak
 * memory otherwise.
 *
 * Compression happens at selection time rather than at upload time, for
 * two reasons: the preview then shows what will actually be stored, and
 * the size limit is checked against the compressed file — so a 7 MB phone
 * photo that shrinks to 800 KB is accepted rather than rejected for being
 * over the 5 MB cap. Validating the original would refuse images we are
 * perfectly capable of storing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, X, ImageIcon, Loader2 } from 'lucide-react';
import { MAX_FILES, validateFile, formatBytes } from '../lib/uploads.js';
import { compressImage } from '../lib/imageCompression.js';

export default function AttachmentPicker({ files, onChange, disabled, maxFiles = MAX_FILES }) {
  const inputRef = useRef(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // What compression achieved, keyed by the resulting File. A WeakMap
  // would be tidier but React needs a value it can render, and the array
  // is at most a handful of entries.
  const [savings, setSavings] = useState([]);

  // Derived from `files` rather than mirrored into state — an effect that
  // setStates on every prop change costs an extra render pass for a value
  // that's a pure function of the input.
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);

  // Object URLs are held by the browser until revoked, so release the
  // previous batch whenever it's replaced and on unmount.
  useEffect(() => () => previews.forEach(URL.revokeObjectURL), [previews]);

  const handleSelect = async (event) => {
    setError('');
    const chosen = Array.from(event.target.files ?? []);
    // Reset immediately, not after the await: the input must be cleared
    // even if compression fails, or re-picking the same file silently
    // does nothing.
    event.target.value = '';
    if (!chosen.length) return;

    if (files.length + chosen.length > maxFiles) {
      setError(`You can attach up to ${maxFiles} images.`);
      return;
    }

    setBusy(true);
    try {
      const accepted = [];
      const stats = [];

      for (const original of chosen) {
        // Type is checked against the original — compression cannot turn
        // an unsupported format into a supported one, and telling the
        // student "PDF isn't an image" beats a vague failure later.
        if (!/^image\//.test(original.type)) {
          setError(`${original.name} isn’t an image file.`);
          setBusy(false);
          return;
        }

        const result = await compressImage(original);

        // Size is checked against the *compressed* file. This is the
        // point of doing it here.
        const rejected = validateFile(result.file);
        if (rejected) {
          setError(rejected);
          setBusy(false);
          return;
        }

        accepted.push(result.file);
        stats.push({
          name: result.file.name,
          compressed: result.compressed,
          originalSize: result.originalSize,
          finalSize: result.finalSize,
        });
      }

      onChange([...files, ...accepted]);
      setSavings((prev) => [...prev, ...stats]);
    } finally {
      setBusy(false);
    }
  };

  const remove = (index) => {
    onChange(files.filter((_, i) => i !== index));
    setSavings((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
        Photos <span className="font-normal text-slate-400 dark:text-slate-500">(optional)</span>
      </span>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        multiple
        onChange={handleSelect}
        disabled={disabled || busy || files.length >= maxFiles}
        className="sr-only"
        id="attachments"
      />

      <label
        htmlFor="attachments"
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
          disabled || busy || files.length >= maxFiles
            ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-600'
            : 'border-slate-300 text-slate-500 hover:border-[#006633] hover:bg-[#006633]/5 dark:border-slate-700 dark:text-slate-400'
        }`}
      >
        {busy ? (
          <Loader2 size={20} className="mb-2 animate-spin" aria-hidden="true" />
        ) : (
          <Upload size={20} className="mb-2" aria-hidden="true" />
        )}

        <span className="text-sm font-medium">
          {busy
            ? 'Preparing photos…'
            : files.length >= maxFiles
              ? 'Maximum reached'
              : 'Tap to add photos'}
        </span>

        <span className="mt-0.5 text-xs">
          {/* Says "resized automatically" rather than quoting the 5 MB cap,
              because the cap now applies after compression — telling a
              student their 8 MB photo is too large would be wrong. */}
          JPEG, PNG or WebP · resized automatically · {files.length}/{maxFiles} added
        </span>
      </label>

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {files.length > 0 && (
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="group relative">
              <div className="aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-800">
                {previews[index] ? (
                  <img
                    src={previews[index]}
                    alt={file.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <ImageIcon className="m-auto text-slate-300 dark:text-slate-600" />
                )}
              </div>

              <button
                type="button"
                onClick={() => remove(index)}
                disabled={disabled}
                aria-label={`Remove ${file.name}`}
                className="absolute -right-2 -top-2 rounded-full bg-white p-1 text-slate-500 shadow ring-1 ring-slate-200 hover:text-red-600 dark:bg-slate-900 dark:text-slate-400"
              >
                <X size={14} />
              </button>

              <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
                {formatBytes(file.size)}
                {/* Shown only when compression actually helped. Reporting
                    "saved 0 KB" on an already-small file is noise. */}
                {savings[index]?.compressed && (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {' '}
                    · from {formatBytes(savings[index].originalSize)}
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
