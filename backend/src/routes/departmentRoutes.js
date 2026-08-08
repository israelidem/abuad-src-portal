/**
 * Department routes.
 *
 * Departments are the routing targets for tickets (Welfare, ICT, ...).
 * Reading is public so the submission form can populate its dropdown
 * before the student signs in; writing is admin-only.
 */

import express from 'express';

import { prisma } from '../lib/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { TICKET_CATEGORIES } from '../validators/ticketSchemas.js';
import { z } from 'zod';

const router = express.Router();

const departmentSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers and hyphens.'),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().default(true),

  /// Drives the ticket's category when a student picks this department,
  /// so the submission form only has to ask one question.
  category: z.enum(TICKET_CATEGORIES).default('OTHER'),
});

const updateDepartmentSchema = departmentSchema.partial().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'No changes supplied.' }
);

/** GET /api/departments — active only, unless an admin asks for all. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';

    const departments = await prisma.department.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isActive: true,
        // Sent to the client so the form can show what a choice implies,
        // and so staff tooling doesn't need a second lookup.
        category: true,
        _count: { select: { tickets: true } },
      },
    });

    res.json({
      departments: departments.map(({ _count, ...d }) => ({
        ...d,
        ticketCount: _count.tickets,
      })),
    });
  })
);

/** POST /api/departments */
router.post(
  '/',
  requireAuth,
  requireAdmin,
  validateBody(departmentSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.department.findUnique({ where: { slug: req.body.slug } });
    if (existing) throw new ApiError(409, 'A department with that slug already exists.');

    const department = await prisma.department.create({ data: req.body });
    res.status(201).json({ department });
  })
);

/** PATCH /api/departments/:id */
router.patch(
  '/:id',
  requireAuth,
  requireAdmin,
  validateBody(updateDepartmentSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.department.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Department not found.');

    if (req.body.slug && req.body.slug !== existing.slug) {
      const clash = await prisma.department.findUnique({ where: { slug: req.body.slug } });
      if (clash) throw new ApiError(409, 'A department with that slug already exists.');
    }

    const department = await prisma.department.update({
      where: { id: req.params.id },
      data: req.body,
    });

    res.json({ department });
  })
);

/**
 * DELETE /api/departments/:id
 * Deactivates rather than deletes when tickets reference it, so the
 * historical record stays intact.
 */
router.delete(
  '/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const department = await prisma.department.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { tickets: true } } },
    });

    if (!department) throw new ApiError(404, 'Department not found.');

    if (department._count.tickets > 0) {
      await prisma.department.update({
        where: { id: req.params.id },
        data: { isActive: false },
      });
      return res.json({
        message: `Department deactivated — ${department._count.tickets} ticket(s) still reference it.`,
        deactivated: true,
      });
    }

    await prisma.department.delete({ where: { id: req.params.id } });
    res.json({ message: 'Department deleted.', deactivated: false });
  })
);

export default router;
