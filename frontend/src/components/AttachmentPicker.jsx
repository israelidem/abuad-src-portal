/**
 * Image picker with local previews.
 *
 * Files are held here and uploaded by the parent on submit, so a
 * cancelled form doesn't leave orphans in Storage.
 *
 * Preview URLs are revoked on removal and unmount — object URLs leak
 * memory otherwise.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, X, ImageIcon } from 'lucide-react';
import { MAX_FILES, validateFile, formatBytes } from '../lib/uploads.js';

export default function AttachmentPicker({ files, onChange, disabled }) {
  const inputRef = useRef(null);
  const [error, setError] = useState('');

  // Derived from `files` rather than mirrored into state — an effect that
  // setStates on every prop change costs an extra render pass for a value
  // that's a pure function of the input.
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);

  // Object URLs are held by the browser until revoked, so release the
  // previous batch whenever it's replaced and on unmount.
  useEffect(() => () => previews.forEach(URL.revokeObjectURL), [previews]);

  const handleSelect = (event) => {
    setError('');
    const chosen = Array.from(event.target.files ?? []);
    if (!chosen.length) return;

    if (files.length + chosen.length > MAX_FILES) {
      setError(`You can attach up to ${MAX_FILES} images.`);
      return;
    }

    const rejected = chosen.map(validateFile).find(Boolean);
    if (rejected) {
      setError(rejected);
      return;
    }

    onChange([...files, ...chosen]);
    // Reset so the same file can be picked again after removal
    event.target.value = '';
  };

  const remove = (index) => onChange(files.filter((_, i) => i !== index));

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-slate-700">
        Photos <span className="font-normal text-slate-400">(optional)</span>
      </span>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        multiple
        onChange={handleSelect}
        disabled={disabled || files.length >= MAX_FILES}
        className="sr-only"
        id="attachments"
      />

      <label
        htmlFor="attachments"
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
          disabled || files.length >= MAX_FILES
            ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
            : 'border-slate-300 text-slate-500 hover:border-[#006633] hover:bg-[#006633]/5'
        }`}
      >
        <Upload size={20} className="mb-2" aria-hidden="true" />
        <span className="text-sm font-medium">
          {files.length >= MAX_FILES ? 'Maximum reached' : 'Tap to add photos'}
        </span>
        <span className="mt-0.5 text-xs">
          JPEG, PNG or WebP · up to 5 MB each · {files.length}/{MAX_FILES} added
        </span>
      </label>

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}

      {files.length > 0 && (
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="group relative">
              <div className="aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                {previews[index] ? (
                  <img
                    src={previews[index]}
                    alt={file.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <ImageIcon className="m-auto text-slate-300" />
                )}
              </div>

              <button
                type="button"
                onClick={() => remove(index)}
                disabled={disabled}
                aria-label={`Remove ${file.name}`}
                className="absolute -right-2 -top-2 rounded-full bg-white p-1 text-slate-500 shadow ring-1 ring-slate-200 hover:text-red-600"
              >
                <X size={14} />
              </button>

              <p className="mt-1 truncate text-xs text-slate-500">{formatBytes(file.size)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
