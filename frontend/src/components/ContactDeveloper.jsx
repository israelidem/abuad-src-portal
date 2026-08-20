/**
 * "Contact developer" footer link and its dialog.
 *
 * Accessibility here is done by hand rather than pulled from a library,
 * because a modal that traps a keyboard user is worse than no modal:
 *
 *   - focus moves into the dialog on open and returns to the trigger on close,
 *     so a keyboard user is not dropped at the top of the document;
 *   - Tab cycles within the dialog while it is open;
 *   - Escape closes, as does a click on the backdrop;
 *   - the surrounding page is inert to assistive tech via aria-modal.
 *
 * Email and phone are real `mailto:`/`tel:` links — on a phone, a printed
 * number that cannot be tapped is just a transcription exercise.
 */

import { useEffect, useRef } from 'react';
import { Code2, Mail, Phone, X } from 'lucide-react';

const DEVELOPER = {
  name: 'Israel Idem',
  email: 'israelidem20@gmail.com',
  phone: '+2349071443404',
};

/// Anything focusable inside the dialog, for the Tab cycle.
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function ContactDeveloper({ open, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    // Remember who opened it so focus can go back there afterwards.
    const opener = document.activeElement;

    // Focus the close button rather than the dialog itself: it gives a
    // screen reader something actionable and makes Escape discoverable.
    closeRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      // Manual focus wrap. Without this, Tab walks out of the dialog and
      // into the page behind it, which is invisible to the user.
      const nodes = dialogRef.current?.querySelectorAll(FOCUSABLE);
      if (!nodes?.length) return;

      const first = nodes[0];
      const last = nodes[nodes.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    // Stop the page behind the dialog from scrolling under it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Only restore focus if it is still safe to do so — the opener may
      // have unmounted while the dialog was open.
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      // Backdrop click closes. The dialog itself stops propagation below,
      // so clicking inside it does not count as clicking the backdrop.
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-dev-title"
        aria-describedby="contact-dev-desc"
        onClick={(e) => e.stopPropagation()}
        // Bottom sheet on phones, centred card on larger screens: reaching
        // the top of a tall screen one-handed is awkward.
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-slate-900"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#006633]/10 text-[#006633] dark:bg-green-400/10 dark:text-green-400">
              <Code2 size={18} aria-hidden="true" />
            </span>
            <h2
              id="contact-dev-title"
              className="text-base font-semibold text-slate-900 dark:text-white"
            >
              Contact the developer
            </h2>
          </div>

          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <p id="contact-dev-desc" className="mb-4 text-sm text-slate-600 dark:text-slate-400">
          For technical problems with the portal itself. For SRC matters, please
          submit a report instead.
        </p>

        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
              Name
            </dt>
            <dd className="mt-0.5 text-slate-900 dark:text-slate-100">{DEVELOPER.name}</dd>
          </div>

          <div>
            <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
              Email
            </dt>
            <dd className="mt-0.5">
              <a
                href={`mailto:${DEVELOPER.email}`}
                className="flex min-h-11 items-center gap-2 text-[#006633] underline decoration-1 underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] dark:text-green-400"
              >
                <Mail size={15} aria-hidden="true" />
                {DEVELOPER.email}
              </a>
            </dd>
          </div>

          <div>
            <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
              Phone
            </dt>
            <dd className="mt-0.5">
              <a
                href={`tel:${DEVELOPER.phone}`}
                className="flex min-h-11 items-center gap-2 text-[#006633] underline decoration-1 underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] dark:text-green-400"
              >
                <Phone size={15} aria-hidden="true" />
                {DEVELOPER.phone}
              </a>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
