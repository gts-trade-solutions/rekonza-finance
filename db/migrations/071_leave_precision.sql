-- Monthly accrual of 15 days a year is 1.25 a month; one decimal stored it as
-- 1.3 and a year came to 15.6. Two decimals keep it exact.

ALTER TABLE leave_entries MODIFY COLUMN days DECIMAL(7,2) NOT NULL;
