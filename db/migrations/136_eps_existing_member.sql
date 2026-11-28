-- ─────────────────────────────────────────────────────────────────────────────
-- EPS for new joiners above the wage ceiling (Employees' Pension Scheme, 1995,
-- paragraph 6A as amended from 1 September 2014, G.S.R. 609(E)).
--
-- A person who becomes a PF member on or after 1 September 2014 with PF wages
-- (basic and DA) above ₹15,000 a month at joining is not eligible for the
-- pension scheme: the employer's whole 12% goes to the EPF account and none to
-- EPS. Someone who was already an EPS member before that date (carried over
-- from an earlier employer, by their UAN) stays one whatever they now earn.
-- employees.eps_member was simply on by default; whether the person was an
-- existing member is the fact that decides it, and it is kept here.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE employees
  ADD COLUMN eps_before_sep2014 TINYINT(1) NOT NULL DEFAULT 0 AFTER eps_member;
