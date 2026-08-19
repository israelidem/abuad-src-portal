/**
 * Admin settings validation — derived from the registry.
 *
 * This file used to list every field by hand, which meant the validator was
 * a fourth copy of the same list (Prisma model, DEFAULTS, Zod, public field
 * list). The copies drifted, and a setting could be saved but never read.
 * Now the shape comes from settingsRegistry, so a new entry there is
 * validated automatically — and, just as importantly, an entry that is
 * *not* in the registry is rejected.
 *
 * Still lives in validators/ to match the existing layout (authSchemas,
 * ticketSchemas, notificationSchemas) and so tests can import it without
 * pulling in Prisma or Supabase.
 *
 * Every field is optional: the settings screen sends a partial patch. The
 * refinements at the bottom reject an empty body and catch the two
 * combinations that would lock people out.
 */

import { z } from 'zod';

import { SETTINGS, SETTING_KEYS } from '../config/settingsRegistry.js';

/**
 * Builds the Zod type for one registry entry.
 *
 * `nullable` entries use `.nullish()` deliberately: null means "clear this
 * and fall back to the built-in wording", which is different from omitting
 * the key ("leave it alone"). Collapsing those two would make it
 * impossible to clear a custom message once set.
 */
const fieldSchema = (key) => {
  const { type, max, nullable } = SETTINGS[key];

  switch (type) {
    case 'boolean':
      return z.boolean().optional();

    case 'number':
      // Coerced because <input type="number"> yields a string. Integer and
      // bounded: a negative or fractional attachment limit is meaningless,
      // and an unbounded one is a denial-of-service vector.
      return z.coerce.number().int().min(1).max(max ?? 100).optional();

    case 'text': {
      const text = z.string().trim().max(max ?? 300);
      return nullable ? text.nullish() : text.optional();
    }

    case 'domains':
      return z
        .array(z.string().trim().toLowerCase())
        .max(max ?? 20)
        .optional();

    default:
      // A typo in the registry should fail loudly at import, not silently
      // skip validation for that field.
      throw new Error(`settingsRegistry: unknown type "${type}" for "${key}"`);
  }
};

const shape = SETTING_KEYS.reduce((acc, key) => {
  acc[key] = fieldSchema(key);
  return acc;
}, {});

export const settingsSchema = z
  .object(shape)
  // An unknown key is a client bug or a probe — say so rather than
  // silently dropping it, which would look like a successful save.
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'No changes supplied.' })
  /**
   * Guard the self-inflicted outage: restricting signups to an empty
   * allow-list rejects every new registration, with no clue why.
   *
   * Only checked when both keys are present in the patch — a patch that
   * touches neither must not be second-guessed here, since we cannot see
   * the stored value from inside the validator.
   */
  .refine(
    (d) =>
      !(d.restrictSignupDomains === true && Array.isArray(d.allowedDomains) && d.allowedDomains.length === 0),
    {
      path: ['allowedDomains'],
      message: 'Add at least one allowed domain, or turn the restriction off.',
    }
  );
