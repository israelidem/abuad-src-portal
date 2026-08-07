/**
 * Zod request validation.
 *
 * Replaces the old pattern of reading raw `req.body` straight into
 * database queries — which allowed both junk data and query injection.
 * Validated output replaces the original input, so handlers only ever
 * see clean, typed values.
 */

export const validate =
  (schema, source = 'body') =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      return next(result.error);
    }

    req[source] = result.data;
    next();
  };

export const validateBody   = (schema) => validate(schema, 'body');
export const validateQuery  = (schema) => validate(schema, 'query');
export const validateParams = (schema) => validate(schema, 'params');
