// Monthly billing period anchored on a tenant's JOIN date (users.createdAt
// day-of-month), NOT the 1st of the month. Example: a super admin who joined
// on the 14th has periods running [14th 00:00, next-month 14th 00:00).
//
// Month-length clamping: an anchor day of 29/30/31 is clamped to the last day
// of any shorter month (e.g. joined on the 31st → period starts on Feb 28/29).
//
// All boundaries are computed in UTC. Token reporting is monthly-granular, so a
// few hours of timezone skew at the boundary is immaterial; computing in a
// single fixed reference (UTC) keeps the math simple and deterministic.

function daysInMonth(year: number, month0: number): number {
  // Day 0 of the next month == last day of this month.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function anchorStart(year: number, month0: number, anchorDay: number): Date {
  const day = Math.min(anchorDay, daysInMonth(year, month0));
  return new Date(Date.UTC(year, month0, day, 0, 0, 0, 0));
}

export interface BillingPeriod {
  start: Date;
  end: Date;
}

// Returns the [start, end) of the billing period that CONTAINS `now`, anchored
// on `joinDate`'s day-of-month.
export function computeBillingPeriod(joinDate: Date, now: Date): BillingPeriod {
  const anchorDay = joinDate.getUTCDate();
  let year = now.getUTCFullYear();
  let month0 = now.getUTCMonth();

  let start = anchorStart(year, month0, anchorDay);
  if (start.getTime() > now.getTime()) {
    // This month's anchor hasn't happened yet → we're still in last month's period.
    month0 -= 1;
    if (month0 < 0) {
      month0 = 11;
      year -= 1;
    }
    start = anchorStart(year, month0, anchorDay);
  }

  let endYear = year;
  let endMonth0 = month0 + 1;
  if (endMonth0 > 11) {
    endMonth0 = 0;
    endYear += 1;
  }
  const end = anchorStart(endYear, endMonth0, anchorDay);

  return { start, end };
}
