import { db } from '@/lib/server/db';
import { route, asId } from '@/lib/server/http';
import { allowedBranchIds } from '@/lib/server/auth/branches';

/**
 * Who am I, and what may I act on?
 *
 * The client bootstraps from this on load. It returns the branches the user can
 * raise documents for, so the branch switcher never offers one the server would
 * refuse.
 */
export const GET = route(async ({ user }) => {
  const [org, branches] = await Promise.all([
    db.selectFrom('organizations').selectAll().where('id', '=', user.orgId).executeTakeFirst(),
    db
      .selectFrom('branches')
      .select(['id', 'name', 'gstin', 'state_code', 'address', 'is_primary'])
      .where('org_id', '=', user.orgId)
      .where('is_active', '=', 1)
      .orderBy('is_primary', 'desc')
      .orderBy('name')
      .execute(),
  ]);

  // The same rule the API enforces on every request, so the switcher never
  // offers a branch the server would refuse.
  const allowedIds = await allowedBranchIds(user);

  return {
    user: {
      id: asId(user.userId),
      name: user.name,
      email: user.email,
      role: user.role,
      branchId: user.homeBranchId ? asId(user.homeBranchId) : null,
      activeBranchId: user.activeBranchId ? asId(user.activeBranchId) : null,
      mfaSetupRequired: !!user.mfaSetupRequired,
      /** A custom role's grants; null means the built-in role's. */
      permissions: user.permissions ?? null,
      customRoleName: user.customRoleName ?? null,
    },
    org: org && {
      id: asId(org.id),
      name: org.name,
      pan: org.pan,
      gstRegistrationType: org.gst_registration_type,
      aatoAbove5Cr: !!org.aato_above_5cr,
      fiscalYearStartMonth: org.fiscal_year_start_month,
      baseCurrency: org.base_currency,
      address: org.address,
      email: org.email,
      phone: org.phone,
      onboarded: !!org.onboarded_at,
      // The app says different things on a demo book than on a real one.
      isDemo: !!org.is_demo,
    },
    // Admins work in every branch; others in their grants, or their home branch.
    branches: branches
      .filter((b) => allowedIds.has(b.id))
      .map((b) => ({
        id: asId(b.id),
        name: b.name,
        gstin: b.gstin,
        stateCode: b.state_code,
        address: b.address,
        isPrimary: !!b.is_primary,
      })),
  };
}, { duringMfaSetup: true });
